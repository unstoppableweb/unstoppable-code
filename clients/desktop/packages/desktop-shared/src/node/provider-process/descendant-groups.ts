import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import type {
  PlatformProcessIdentity,
  PlatformSupervisionServices,
} from '@canopy/core-runtime';

/*
 * Best-effort reaping of a provider's descendants that left its process group
 * (CAN-6726). Antigravity starts each approved command in its own group, so
 * stopping the provider's group does not reach it.
 *
 * While the provider still runs, its descendants are traced through the
 * process table and each one's start identity is recorded (CAN-6482). After
 * the provider's group is stopped, a recorded group is signalled only while a
 * member with a recorded identity is still in it: a group ID cannot be reused
 * while the group has members, so that member proves it is the same group.
 * Every other member joined it from inside the descendant's own session.
 *
 * Environment run markers (CAN-6601) cannot prove these members on macOS:
 * `ps -E` shows no environment for Apple's own programs, such as the shells
 * that run the commands (CAN-6640).
 *
 * Every descendant that set up its own process group is in scope, not only
 * approved commands: anything a provider detaches is stopped with it.
 *
 * Not guaranteed: a descendant that starts a new group after the last trace,
 * or after the child exited, is never recorded and is not stopped. What was
 * recorded before a child exited on its own is still reaped at its stop.
 */

const LIST_ATTEMPTS = 3;
const LIST_RETRY_MS = 50;
/**
 * Reads of a process that came back unverifiable, read again: an exiting
 * process reads that way until it becomes a zombie (CAN-7026).
 */
const IDENTIFY_ATTEMPTS = 3;
/** Identity reads in flight at once while tracing. */
const TRACE_CONCURRENCY = 4;
/** Recording while the child runs is bounded independently of its stop. */
const TRACE_BUDGET_MS = 2_000;
/**
 * Share of a trace's budget kept for the confirm read, so the identities read
 * before the budget fires are confirmed before the caller moves on.
 */
const CONFIRM_SHARE = 0.4;
/** Group proofs in flight at once during a reap round. */
const PROOF_CONCURRENCY = 4;
/** Bound on proving that killed groups are gone. */
const VERIFY_BUDGET_MS = 1_000;
/** Bound on a whole reap round, however many groups it proves. */
const REAP_ROUND_BUDGET_MS = 3_000;
/** Bound on proving one group before a signal, so one slow group cannot starve the rest. */
const GROUP_PROOF_BUDGET_MS = 1_500;

/**
 * A stop's descendant cleanup. Each value speaks only for the recorded
 * members, never for every descendant: one started after the last recording,
 * or by a child that exited, may never have been seen.
 * - `none`: every requested recording finished, and no recorded member was
 *   still ours to signal;
 * - `reaped`: every requested recording finished, and every group signalled
 *   in either round is proven to hold none of its recorded members afterwards;
 * - `unverified`: anything else, such as an inconclusive proof, a killed
 *   member not proven gone, or a recording that was dropped, failed or ran
 *   out of time. Never `reaped` without that proof.
 */
export type DescendantCleanup = 'none' | 'reaped' | 'unverified';

/**
 * Why a reap is `unverified` (CAN-7026): `proof-inconclusive`, a group's
 * proof before a signal did not settle within its budget; `verify-deadline`,
 * a killed group was not proven gone before the check's deadline.
 */
export type DescendantReapReason = 'proof-inconclusive' | 'verify-deadline';

export interface DescendantReap {
  readonly cleanup: DescendantCleanup;
  /** Set only when `cleanup` is `unverified`. */
  readonly reason?: DescendantReapReason;
}

interface SignalRound {
  readonly signalled: number[];
  readonly unknown: number[];
}

/**
 * Recorded descendants by process group: each member's start identity, with
 * the PID it was read from.
 */
export type DescendantGroups = Map<number, Map<string, number>>;

let supervision: PlatformSupervisionServices | undefined;

function supervisionServices(): PlatformSupervisionServices {
  supervision ??= hostPlatformServices(
    createPlatformEndpointServices(hostPlatformOperatingSystem()),
  ).supervision;
  return supervision;
}

/**
 * `unref` lets a budget timer end without holding the process open; `signal`
 * ends the wait early.
 */
export function delay(
  ms: number,
  unref = false,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (unref) timer.unref();
    signal?.addEventListener('abort', done, { once: true });
  });
}

type Identify = NonNullable<PlatformSupervisionServices['identifyProcess']>;

/**
 * A process identity, read again while it comes back unverifiable, within
 * `signal`. On Linux a process that is exiting but not yet a zombie reads as
 * running while its executable link is gone, so for a moment it is neither
 * readable nor absent (CAN-7026); a stranger that stays unreadable is still
 * reported unverifiable after the last attempt. A failed read is undefined.
 */
async function identifySettled(
  identify: Identify,
  pid: number,
  signal: AbortSignal,
): Promise<PlatformProcessIdentity | undefined> {
  let found: PlatformProcessIdentity | undefined;
  for (let attempt = 1; attempt <= IDENTIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await delay(LIST_RETRY_MS, true, signal);
    if (signal.aborted) return found;
    found = await identify({ pid, signal }).catch(() => undefined);
    if (found?.state !== 'unverifiable') return found;
  }
  return found;
}

/**
 * A signal that aborts after `ms`, like `AbortSignal.timeout`, on a timer
 * that does not hold the process open. It runs on the ordinary timer, so a
 * test's fake clock drives every budget here.
 */
function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  void delay(ms, true).then(() => {
    controller.abort(new DOMException('The budget elapsed.', 'TimeoutError'));
  });
  return controller.signal;
}

/**
 * `work`'s result, or `fallback` once `signal` aborts. The platform's reads
 * may not honor an abort, so a budget is enforced here; a late result is
 * ignored.
 */
function settleBy<T>(
  work: Promise<T>,
  signal: AbortSignal,
  fallback: T,
): Promise<T> {
  if (signal.aborted) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    const onAbort = (): void => resolve(fallback);
    signal.addEventListener('abort', onAbort, { once: true });
    work
      .then(resolve, () => resolve(fallback))
      .finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
  });
}

function record(
  into: DescendantGroups,
  group: number,
  startIdentity: string,
  pid: number,
): void {
  const members = into.get(group);
  if (members) members.set(startIdentity, pid);
  else into.set(group, new Map([[startIdentity, pid]]));
}

/** A group that may never be signalled: none, init's, the host's or the root's. */
function protectedGroup(group: number, rootPid: number): boolean {
  return group <= 1 || group === rootPid || group === process.pid;
}

/**
 * Adds every current descendant of `rootPid` outside the root's own group,
 * with its start identity, to `into`. Unreadable rows are skipped. Identity
 * reads stop at the trace budget; those already made are still confirmed
 * and recorded. The platform's table read may not honor the budget, so a
 * caller that must not wait uses `traceWithin`.
 */
export async function traceDescendantGroups(
  rootPid: number,
  into: DescendantGroups = new Map(),
  services?: PlatformSupervisionServices,
  budgetMs: number = TRACE_BUDGET_MS,
): Promise<DescendantGroups> {
  await trace(rootPid, into, services, budgetMs);
  return into;
}

/**
 * Traces into `into` and reports whether the trace was complete: every
 * descendant in the table was identified, or proven gone, and confirmed.
 * A failed or unsupported read, the budget running out, or a descendant that
 * changed group or parent between the reads leaves it incomplete.
 */
async function trace(
  rootPid: number,
  into: DescendantGroups,
  services: PlatformSupervisionServices | undefined,
  budgetMs: number,
): Promise<boolean> {
  const supervisor = services ?? supervisionServices();
  const identify = supervisor.identifyProcess?.bind(supervisor);
  if (!identify) return false;
  const confirmMs = Math.round(budgetMs * CONFIRM_SHARE);
  const signal = timeoutSignal(budgetMs - confirmMs);
  const table = await supervisor
    .readProcessTable({ signal })
    .catch(() => undefined);
  if (table?.kind !== 'sampled') return false;
  const children = new Map<number, number[]>();
  for (const row of table.rows.values()) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  // Only descendants outside the root's group need an identity read.
  const candidates: Array<{ pid: number; ppid: number; pgid: number }> = [];
  const pending = [rootPid];
  const seen = new Set<number>(pending);
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined) break;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      pending.push(child);
      const pgid = table.rows.get(child)?.pgid;
      if (pgid !== undefined && !protectedGroup(pgid, rootPid))
        candidates.push({ pid: child, ppid: pid, pgid });
    }
  }
  const identified: Array<{
    pid: number;
    ppid: number;
    pgid: number;
    startIdentity: string;
  }> = [];
  let next = 0;
  let complete = true;
  const worker = async (): Promise<void> => {
    while (next < candidates.length && !signal.aborted) {
      const candidate = candidates[next];
      next += 1;
      if (!candidate) break;
      const found = await identifySettled(identify, candidate.pid, signal);
      if (found?.state === 'absent') continue;
      // A PID reused since the table read almost always has another group;
      // the second read below catches the rest. A descendant that moved to
      // another group in between is not recorded either: a gap.
      if (
        found?.state !== 'running' ||
        found.processGroupId !== candidate.pgid
      ) {
        complete = false;
        continue;
      }
      identified.push({ ...candidate, startIdentity: found.startIdentity });
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(TRACE_CONCURRENCY, candidates.length) },
      worker,
    ),
  );
  if (next < candidates.length) complete = false;
  if (identified.length === 0) return complete;
  // The table and the identities are separate reads. Bind them: a PID that
  // exited and was reused between them has another parent or group in a
  // second read, unless the same parent PID (our own descendant) started it.
  const confirm = await supervisor
    .readProcessTable({ signal: timeoutSignal(confirmMs) })
    .catch(() => undefined);
  if (confirm?.kind !== 'sampled') return false;
  for (const entry of identified) {
    const row = confirm.rows.get(entry.pid);
    if (!row) continue;
    // Reused, or reparented after its parent exited: not recorded, a gap.
    if (row.ppid !== entry.ppid || row.pgid !== entry.pgid) {
      complete = false;
      continue;
    }
    record(into, entry.pgid, entry.startIdentity, entry.pid);
  }
  return complete;
}

/**
 * Traces like `traceDescendantGroups`, but resolves after `budgetMs` at the
 * latest, so a slow platform read never holds the caller. Resolves whether
 * the trace was complete; one still running at the budget is not. A trace
 * that finishes later still adds to `into`; a reap sees those records only
 * if it reads `into` after they land.
 */
export function traceWithin(
  rootPid: number,
  into: DescendantGroups,
  budgetMs: number = TRACE_BUDGET_MS,
  services?: PlatformSupervisionServices,
): Promise<boolean> {
  const traced = trace(rootPid, into, services, budgetMs).catch(() => false);
  return Promise.race([traced, delay(budgetMs, true).then(() => false)]);
}

/**
 * What a proof concluded: `proven`, a recorded member is still in the group;
 * `notOurs`, every read succeeded and none is; `unknown`, a read failed or
 * ran out of time, so a later round may try again.
 */
type Proof = 'proven' | 'notOurs' | 'unknown';

/** Whether a recorded member is still this process, in this group. */
async function recordedMemberRemains(
  services: PlatformSupervisionServices,
  group: number,
  members: ReadonlyMap<string, number>,
  signal: AbortSignal,
): Promise<Proof> {
  const identify = services.identifyProcess?.bind(services);
  if (!identify) return 'unknown';
  let unknown = false;
  for (const [startIdentity, pid] of members) {
    if (signal.aborted) return 'unknown';
    const found = await identifySettled(identify, pid, signal);
    if (
      found?.state === 'running' &&
      found.startIdentity === startIdentity &&
      found.processGroupId === group
    )
      return 'proven';
    if (!found || found.state === 'unverifiable') unknown = true;
  }
  return unknown ? 'unknown' : 'notOurs';
}

/**
 * Whether `group` still holds a member whose identity was recorded: first by
 * reading the recorded members directly, about one read per group, so an
 * unreadable stranger cannot block it; otherwise by listing the group. A
 * listed proven group's current members are recorded too, so it stays proven
 * if the members that proved it exit first.
 */
async function stillOurs(
  services: PlatformSupervisionServices,
  group: number,
  members: Map<string, number>,
  signal: AbortSignal,
  recordMembers: boolean,
): Promise<Proof> {
  const directProof = await recordedMemberRemains(
    services,
    group,
    members,
    signal,
  );
  const direct = directProof === 'proven';
  // The listing only records members for a later round; the last round
  // needs it only when the recorded members could not prove the group.
  if (!services.listProcessGroup || (direct && !recordMembers))
    return directProof;
  let listed:
    | Awaited<
        ReturnType<NonNullable<PlatformSupervisionServices['listProcessGroup']>>
      >
    | undefined;
  // A member exiting mid-read makes the whole list unverifiable; retry a few
  // times, unless a recorded member already proved the group.
  const attempts = direct ? 1 : LIST_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal.aborted) break;
    listed = await services
      .listProcessGroup({ processGroupId: group, signal })
      .catch(() => undefined);
    if (listed?.state === 'listed' || attempt === attempts) break;
    await delay(LIST_RETRY_MS);
  }
  // Listing can outlive the member that supplied the direct proof. Recheck
  // ownership after an incomplete read rather than authorizing a signal with
  // that earlier proof; an unreadable stranger still cannot block a live member.
  if (listed?.state !== 'listed')
    return direct
      ? recordedMemberRemains(services, group, members, signal)
      : 'unknown';
  // A complete listing must overlap a recorded identity, but its sequential
  // member reads are not an atomic snapshot. Revalidate a recorded member
  // after listing, before adopting new members or authorizing a signal.
  const proven = listed.members.some((member) =>
    members.has(member.startIdentity),
  );
  if (!proven) return 'notOurs';
  const freshProof = await recordedMemberRemains(
    services,
    group,
    members,
    signal,
  );
  if (freshProof !== 'proven') return freshProof;
  for (const member of listed.members)
    members.set(member.startIdentity, member.pid);
  return 'proven';
}

function signalGroup(group: number, name: NodeJS.Signals): void {
  try {
    process.kill(-group, name);
  } catch {
    // The group emptied since it was proven: the ordinary case.
  }
}

/**
 * Signals each group still proven ours, a few at a time, each within its own
 * budget and all within the round's. Returns the groups it signalled and
 * those whose proof was inconclusive, which a later round may retry.
 */
async function signalProven(
  services: PlatformSupervisionServices,
  groups: DescendantGroups,
  candidates: Iterable<number>,
  rootPid: number,
  name: NodeJS.Signals,
  recordMembers: boolean,
): Promise<SignalRound> {
  const round = timeoutSignal(REAP_ROUND_BUDGET_MS);
  const queue = Array.from(candidates);
  const signalled: number[] = [];
  const unknown: number[] = [];
  const worker = async (): Promise<void> => {
    for (
      let group = queue.shift();
      group !== undefined;
      group = queue.shift()
    ) {
      if (round.aborted) {
        // Not reached in this round's budget: inconclusive, not cleared.
        unknown.push(group, ...queue.splice(0));
        return;
      }
      const members = groups.get(group);
      if (!members || protectedGroup(group, rootPid)) continue;
      const signal = AbortSignal.any([
        round,
        timeoutSignal(GROUP_PROOF_BUDGET_MS),
      ]);
      // Signalled with no further await after the proving read. A group ID
      // cannot be reused while it has members, so only a group that emptied
      // and was recreated in that short window could be mistaken.
      // A proof that misses its budget is inconclusive: never signalled.
      const proof = await settleBy(
        stillOurs(services, group, members, signal, recordMembers),
        signal,
        'unknown',
      );
      if (proof === 'proven') {
        signalGroup(group, name);
        signalled.push(group);
      } else if (proof === 'unknown') unknown.push(group);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROOF_CONCURRENCY, queue.length) }, worker),
  );
  return { signalled, unknown };
}

/**
 * SIGTERM to each recorded group still proven ours, then SIGKILL to every
 * group that was signalled or whose proof was inconclusive and is now proven
 * ours, after `graceMs` when anything was signalled. With no grace, one
 * SIGKILL round only. Each round proves the group again right before
 * signalling it; a group first proven in the SIGKILL round gets no SIGTERM.
 * A group that ignores SIGTERM therefore gets SIGKILL only after the grace.
 * The whole reap is bounded by two 3 s rounds, the grace and the 1 s check
 * that killed groups are gone: at most about `graceMs + 7 s`.
 */
export async function reapDescendantGroups(
  groups: DescendantGroups,
  rootPid: number,
  graceMs: number,
  services?: PlatformSupervisionServices,
): Promise<DescendantCleanup> {
  return (
    await reapDescendantGroupsWithReason(groups, rootPid, graceMs, services)
  ).cleanup;
}

/** `reapDescendantGroups`, with why an `unverified` outcome is unverified. */
export async function reapDescendantGroupsWithReason(
  groups: DescendantGroups,
  rootPid: number,
  graceMs: number,
  services?: PlatformSupervisionServices,
): Promise<DescendantReap> {
  if (groups.size === 0) return { cleanup: 'none' };
  const supervisor = services ?? supervisionServices();
  // Every group signalled in either round: one that ends on SIGTERM is no
  // longer ours by the SIGKILL round, yet it was reaped.
  const signalled = new Set<number>();
  let unknown: readonly number[];
  if (graceMs <= 0) {
    // A forced stop gives SIGTERM no time to act; prove each group once.
    const killed = await signalProven(
      supervisor,
      groups,
      groups.keys(),
      rootPid,
      'SIGKILL',
      false,
    );
    for (const group of killed.signalled) signalled.add(group);
    unknown = killed.unknown;
  } else {
    const first = await signalProven(
      supervisor,
      groups,
      groups.keys(),
      rootPid,
      'SIGTERM',
      true,
    );
    for (const group of first.signalled) signalled.add(group);
    const retry = [...first.signalled, ...first.unknown];
    unknown = [];
    if (retry.length > 0) {
      if (first.signalled.length > 0) await delay(graceMs);
      const killed = await signalProven(
        supervisor,
        groups,
        retry,
        rootPid,
        'SIGKILL',
        false,
      );
      for (const group of killed.signalled) signalled.add(group);
      unknown = killed.unknown;
    }
  }
  if (unknown.length > 0)
    return { cleanup: 'unverified', reason: 'proof-inconclusive' };
  if (signalled.size === 0) return { cleanup: 'none' };
  return (await verifyGone(supervisor, groups, [...signalled]))
    ? { cleanup: 'reaped' }
    : { cleanup: 'unverified', reason: 'verify-deadline' };
}

/**
 * Whether each killed group is now proven to hold none of its recorded
 * members, within `VERIFY_BUDGET_MS` for all of them. Anything unreadable,
 * still present, or unproven by the deadline is not proven gone.
 */
async function verifyGone(
  services: PlatformSupervisionServices,
  groups: DescendantGroups,
  killed: readonly number[],
): Promise<boolean> {
  const deadline = performance.now() + VERIFY_BUDGET_MS;
  for (const group of killed) {
    const members = groups.get(group);
    if (!members) continue;
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      const signal = timeoutSignal(
        Math.ceil(Math.min(GROUP_PROOF_BUDGET_MS, remaining)),
      );
      const proof = await settleBy(
        recordedMemberRemains(services, group, members, signal),
        signal,
        'unknown',
      );
      if (proof === 'notOurs') break;
      // A killed member can be unreadable for a moment while it is torn
      // down (CAN-7026), so an inconclusive read is retried like a member
      // still present, until the deadline.
      await delay(LIST_RETRY_MS);
    }
  }
  return true;
}
