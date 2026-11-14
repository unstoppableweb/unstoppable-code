import type { PlatformSupervisionServices } from '../../../platform/platform-services';
import { FORCE_KILL_DELAY_MS } from './process-runner';
import type { ScriptRunChild } from './script-run-log';

/**
 * How a user's Stop of an orphaned run ended (CAN-6482 part 2):
 * `stopped` (it exited, or was ended), `still_running` (a PID-only Stop sent
 * SIGTERM and it is still there; a confirmed Force stop may follow), `gone`
 * (nothing was there), `not_same` (the recorded identity no longer matches:
 * the PID now belongs to another process, so nothing was signalled),
 * `unverifiable` (its identity could not be read, so nothing was signalled),
 * `group_remains` (the recorded leader exited, and its group still has
 * members; a confirmed group Force stop may follow, CAN-6601). A full record
 * whose identity becomes unreadable after SIGTERM reads `still_running`,
 * never `stopped`, and gets no SIGKILL; one whose PID another process holds
 * while the recorded group has members reads `unverifiable`, since a PID is
 * never reused while a group of that ID exists, so the group isn't the run's.
 */
export type ScriptRunChildStop =
  | 'stopped'
  | 'still_running'
  | 'gone'
  | 'not_same'
  | 'unverifiable'
  | 'group_remains';

/** `stop`: SIGTERM, as the record allows; `force`: SIGKILL to a PID-only record's PID. */
export type ScriptRunChildStopMode = 'stop' | 'force';

export interface ScriptRunChildStopOptions {
  readonly child: ScriptRunChild;
  readonly mode: ScriptRunChildStopMode;
  readonly supervision: Pick<
    PlatformSupervisionServices,
    'inspectProcess' | 'identifyProcess'
  >;
  /**
   * Default `process.kill`; a negative target is a process group, and signal
   * 0 only asks whether it exists.
   */
  readonly kill?: ScriptRunSignal;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds that bound the grace; default `performance.now`. */
  readonly now?: () => number;
  /** How long a SIGTERM has before the record's next step; default 5 s. */
  readonly graceMs?: number;
  readonly pollMs?: number;
}

/** Whether the record names a full start identity, so a group may be signalled. */
export function isScriptRunChildIdentified(
  child: ScriptRunChild,
): child is ScriptRunChild & {
  startIdentity: string;
  processGroupId: number;
  executablePath: string;
} {
  return (
    child.startIdentity !== undefined &&
    child.processGroupId !== undefined &&
    child.executablePath !== undefined
  );
}

/** `process.kill`'s shape: SIGTERM, SIGKILL, or 0 to ask whether a target exists. */
export type ScriptRunSignal = (
  target: number,
  signal: 'SIGTERM' | 'SIGKILL' | 0,
) => void;

const processKill: ScriptRunSignal = (target, signal): void => {
  process.kill(target, signal);
};

/**
 * Whether the recorded process group still has a member: a leader can exit
 * while processes in its group live on. Anything but ESRCH counts as a
 * member (EPERM: one that this user cannot signal).
 */
export function scriptRunGroupRemains(
  processGroupId: number,
  kill: ScriptRunSignal = processKill,
): boolean {
  try {
    kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined;
}

/**
 * Stops an orphaned run's recorded process on a user's request (coordinator
 * decision, 12 Nov 2026). A full record is proven before every signal: its
 * group gets SIGTERM, then SIGKILL after the grace only if the identity
 * still matches right before it. A PID-only record is never treated as a
 * group: `stop` sends SIGTERM to the PID alone and reports `still_running`
 * after the grace; `force` sends SIGKILL to that PID. The caller has the
 * user's confirmation for a PID-only record.
 */
export async function stopScriptRunChild(
  options: ScriptRunChildStopOptions,
): Promise<ScriptRunChildStop> {
  const { child, mode, supervision } = options;
  const kill = options.kill ?? processKill;
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? ((): number => performance.now());
  const graceMs = options.graceMs ?? FORCE_KILL_DELAY_MS;
  const pollMs = options.pollMs ?? 100;
  /** Polls `settled` until it answers or the grace, by the clock, ends. */
  const within = async <T>(
    settled: () => Promise<T | undefined>,
  ): Promise<T | undefined> => {
    const deadline = now() + graceMs;
    while (now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      const answer = await settled();
      if (answer !== undefined) return answer;
    }
    return undefined;
  };
  /** False when the target no longer exists. */
  const signal = (target: number, sig: 'SIGTERM' | 'SIGKILL'): boolean => {
    try {
      kill(target, sig);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return false;
      throw error;
    }
  };
  if (isScriptRunChildIdentified(child)) {
    const identify = supervision.identifyProcess;
    if (!identify) return 'unverifiable';
    /**
     * `reused`: another start identity holds the PID, so the recorded process
     * ended; `changed`: the same process, but its executable or group moved
     * (it exec'd), so it still runs and is no longer the proven identity.
     */
    const proof = async (): Promise<
      'match' | 'absent' | 'reused' | 'changed' | 'unverifiable'
    > => {
      const found = await identify({ pid: child.pid }).catch(
        (): { state: 'unverifiable' } => ({ state: 'unverifiable' }),
      );
      if (found.state === 'absent') return 'absent';
      if (found.state !== 'running') return 'unverifiable';
      if (found.startIdentity !== child.startIdentity) return 'reused';
      return found.processGroupId === child.processGroupId &&
        found.executablePath === child.executablePath
        ? 'match'
        : 'changed';
    };
    const group = child.processGroupId;
    /**
     * The recorded process ended (gone, or its PID reused). Its group may
     * still have members, but with the leader gone they cannot be proven to
     * be the run's, so they are never signalled: the run reads stopped only
     * once the group is empty too.
     */
    const ended = (): boolean => !scriptRunGroupRemains(group, kill);
    const first = await proof();
    if (first === 'absent') return ended() ? 'gone' : 'group_remains';
    // Another start identity holds the PID: the recorded process ended, once
    // its group is empty too. The same process running another program
    // (changed) is still running: nothing is signalled, and it stays
    // orphaned.
    if (first === 'reused') return ended() ? 'not_same' : 'unverifiable';
    if (first === 'changed') return 'unverifiable';
    if (first === 'unverifiable') return 'unverifiable';
    if (!signal(-group, 'SIGTERM')) return 'gone';
    const settled = await within(async () => {
      const seen = await proof();
      return (seen === 'absent' || seen === 'reused') && ended()
        ? 'stopped'
        : undefined;
    });
    if (settled !== undefined) return settled;
    // Proven again right before the SIGKILL. Anything but the proven
    // identity gets none: a process that exec'd or cannot be read is
    // reported still running, a group whose leader has gone as
    // group_remains, and an empty group as stopped.
    const last = await proof();
    if (last === 'match') {
      signal(-group, 'SIGKILL');
      return 'stopped';
    }
    if ((last === 'absent' || last === 'reused') && ended()) return 'stopped';
    return last === 'absent' ? 'group_remains' : 'still_running';
  }
  const alive = async (): Promise<boolean> =>
    (await supervision.inspectProcess({ pid: child.pid })).state !== 'absent';
  if (!(await alive())) return 'gone';
  if (mode === 'force')
    return signal(child.pid, 'SIGKILL') ? 'stopped' : 'gone';
  if (!signal(child.pid, 'SIGTERM')) return 'gone';
  return (
    (await within(async () =>
      (await alive()) ? undefined : ('stopped' as const),
    )) ?? 'still_running'
  );
}

/**
 * The environment entry each recorded script run's process starts with, its
 * value the run's execution id (CAN-6601). Children inherit it, so a group
 * member that carries it was started by that run; a reused group ID's members
 * don't. Internal to the hosts that read it, never shown to the user.
 */
export const SCRIPT_RUN_MARKER_ENV = 'CANOPY_SCRIPT_RUN_ID';

/** One live member of an orphaned run's process group, as the user sees it (CAN-6601). */
export interface ScriptRunGroupMember {
  readonly pid: number;
  readonly startIdentity: string;
  readonly startedAtMs: number;
  /** The executable's base name, for the user only. */
  readonly command: string;
  /** Its environment carries this run's marker; unreadable or absent reads false. */
  readonly carriesRunId: boolean;
}

/**
 * An orphaned run's group members (CAN-6601). `members`: the recorded leader
 * is gone and the group was read, with `offerable` true only when every
 * member carries the run's marker and started no earlier than the run did;
 * `not_group`: the record names
 * no group, or its leader still runs or its PID is another process's;
 * `unverifiable`: the leader or a member can't be read; `unsupported`: the
 * host has no process groups.
 */
export type ScriptRunGroupListing =
  | {
      readonly kind: 'members';
      readonly members: readonly ScriptRunGroupMember[];
      readonly offerable: boolean;
    }
  | { readonly kind: 'not_group' | 'unverifiable' | 'unsupported' };

export interface ScriptRunGroupOptions {
  readonly child: ScriptRunChild;
  /** When the run started, epoch milliseconds, from its record. */
  readonly runStartedAtMs: number;
  /** The run's execution id, the value of its marker. */
  readonly runId: string;
  readonly supervision: Pick<
    PlatformSupervisionServices,
    'identifyProcess' | 'listProcessGroup'
  >;
}

/**
 * Start times are read to the whole second (and a Linux boot time may round
 * by one), so a member is the run's when it started no earlier than the
 * second before the run's.
 */
const START_SLACK_MS = 1000;

/** The orphaned run's live group members, read for the user's confirmation (CAN-6601). */
export async function listScriptRunGroup(
  options: ScriptRunGroupOptions,
): Promise<ScriptRunGroupListing> {
  const { child, supervision } = options;
  const { identifyProcess, listProcessGroup } = supervision;
  if (!identifyProcess || !listProcessGroup) return { kind: 'unsupported' };
  if (!isScriptRunChildIdentified(child)) return { kind: 'not_group' };
  const leader = await identifyProcess({ pid: child.pid }).catch(
    (): { state: 'unverifiable' } => ({ state: 'unverifiable' }),
  );
  // A live leader is stopped through its record; a PID another process holds
  // names a group that formed after the run's ended.
  if (leader.state === 'running') return { kind: 'not_group' };
  if (leader.state !== 'absent') return { kind: 'unverifiable' };
  const group = await listProcessGroup({
    processGroupId: child.processGroupId,
    runMarker: { name: SCRIPT_RUN_MARKER_ENV, value: options.runId },
  }).catch((): { state: 'unverifiable' } => ({ state: 'unverifiable' }));
  if (group.state !== 'listed') return { kind: 'unverifiable' };
  const earliest =
    Math.floor(options.runStartedAtMs / 1000) * 1000 - START_SLACK_MS;
  const members = group.members.map(
    (member): ScriptRunGroupMember => ({
      pid: member.pid,
      startIdentity: member.startIdentity,
      startedAtMs: member.startedAtMs,
      command: member.command,
      carriesRunId: member.runMarker === 'match',
    }),
  );
  // A reused group ID's members started after the run too: only the run's
  // marker, inherited from its own process, ties a member to it.
  return {
    kind: 'members',
    members,
    offerable:
      members.length > 0 &&
      members.every(
        (member) => member.carriesRunId && member.startedAtMs >= earliest,
      ),
  };
}

/** What a group Force stop did to one listed member (CAN-6601). */
export type ScriptRunGroupMemberStop =
  | 'stopped'
  | 'killed'
  | 'gone'
  | 'not_same'
  | 'still_running';

export type ScriptRunGroupStop =
  | {
      readonly kind: 'done';
      /** `stopped` once the group is empty; otherwise `still_running`. */
      readonly outcome: 'stopped' | 'still_running';
      readonly members: readonly {
        readonly pid: number;
        readonly outcome: ScriptRunGroupMemberStop;
      }[];
    }
  /** The group isn't the one the user confirmed, or can't be offered: nothing was signalled. */
  | { readonly kind: 'refused' }
  | { readonly kind: 'not_group' | 'unverifiable' | 'unsupported' };

export interface ScriptRunGroupStopOptions extends ScriptRunGroupOptions {
  /** The members exactly as the user confirmed them. */
  readonly members: readonly {
    readonly pid: number;
    readonly startIdentity: string;
  }[];
  readonly kill?: ScriptRunSignal;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** How long SIGTERM has before the survivors' SIGKILL; default 3 s. */
  readonly graceMs?: number;
  readonly pollMs?: number;
}

/**
 * A user's confirmed group Force stop of an orphaned run whose leader has
 * exited (CAN-6601). It acts only when the group, read again now, can be
 * offered and has no member the user didn't confirm. Each confirmed member
 * gets SIGTERM to its own PID, never the group ID, only while it runs with
 * its confirmed start identity in the recorded group; after the grace, each
 * survivor is proven again and gets SIGKILL only if it still matches. A
 * member that changed is skipped and reported. The run reads stopped only
 * once the whole group is empty.
 */
export async function forceStopScriptRunGroup(
  options: ScriptRunGroupStopOptions,
): Promise<ScriptRunGroupStop> {
  const { child, supervision } = options;
  const kill = options.kill ?? processKill;
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? ((): number => performance.now());
  const graceMs = options.graceMs ?? 3000;
  const pollMs = options.pollMs ?? 100;
  const listing = await listScriptRunGroup(options);
  if (listing.kind !== 'members') return listing;
  const identify = supervision.identifyProcess;
  if (!identify || !isScriptRunChildIdentified(child))
    return { kind: 'unsupported' };
  const confirmed = new Map(
    options.members.map((member) => [member.pid, member.startIdentity]),
  );
  if (
    !listing.offerable ||
    confirmed.size !== options.members.length ||
    listing.members.some(
      (member) => confirmed.get(member.pid) !== member.startIdentity,
    )
  )
    return { kind: 'refused' };
  const group = child.processGroupId;
  /** Whether the PID still runs as the confirmed member, in the recorded group. */
  const proof = async (
    pid: number,
    startIdentity: string,
  ): Promise<'match' | 'gone' | 'not_same' | 'unverifiable'> => {
    const found = await identify({ pid }).catch(
      (): { state: 'unverifiable' } => ({ state: 'unverifiable' }),
    );
    if (found.state === 'absent') return 'gone';
    if (found.state !== 'running') return 'unverifiable';
    if (found.startIdentity !== startIdentity) return 'gone';
    return found.processGroupId === group ? 'match' : 'not_same';
  };
  const send = (pid: number, sig: 'SIGTERM' | 'SIGKILL'): boolean => {
    try {
      kill(pid, sig);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return false;
      throw error;
    }
  };
  const results = new Map<number, ScriptRunGroupMemberStop>();
  const signalled: { pid: number; startIdentity: string }[] = [];
  for (const member of options.members) {
    const seen = await proof(member.pid, member.startIdentity);
    if (seen === 'match' && send(member.pid, 'SIGTERM')) {
      signalled.push(member);
      continue;
    }
    // A PID now held by another start identity names a process that ended;
    // one that left the group, or can't be read, is not signalled.
    results.set(
      member.pid,
      seen === 'match' || seen === 'gone' ? 'gone' : 'not_same',
    );
  }
  const remaining = async (): Promise<typeof signalled> => {
    const left: typeof signalled = [];
    for (const member of signalled)
      if ((await proof(member.pid, member.startIdentity)) !== 'gone')
        left.push(member);
    return left;
  };
  const deadline = now() + graceMs;
  let left = await remaining();
  while (left.length > 0 && now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    left = await remaining();
  }
  const survivors = new Set(left.map((member) => member.pid));
  for (const member of signalled) {
    if (!survivors.has(member.pid)) {
      results.set(member.pid, 'stopped');
      continue;
    }
    // Proven again right before the SIGKILL.
    const seen = await proof(member.pid, member.startIdentity);
    if (seen === 'match')
      results.set(
        member.pid,
        send(member.pid, 'SIGKILL') ? 'killed' : 'stopped',
      );
    else
      results.set(
        member.pid,
        seen === 'gone'
          ? 'stopped'
          : seen === 'not_same'
            ? 'not_same'
            : 'still_running',
      );
  }
  // A SIGKILL takes a moment to land: the group is read as empty within a
  // short bounded wait, or the run stays orphaned.
  const settleUntil = now() + 1000;
  let empty = !scriptRunGroupRemains(group, kill);
  while (!empty && now() < settleUntil) {
    await sleep(Math.min(pollMs, Math.max(0, settleUntil - now())));
    empty = !scriptRunGroupRemains(group, kill);
  }
  return {
    kind: 'done',
    outcome: empty ? 'stopped' : 'still_running',
    members: options.members.map((member) => ({
      pid: member.pid,
      outcome: results.get(member.pid) ?? 'still_running',
    })),
  };
}
