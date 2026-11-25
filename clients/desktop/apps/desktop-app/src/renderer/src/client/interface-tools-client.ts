import {
  CORE_CLIENT_TOOLS_REGISTER,
  CORE_CLIENT_TOOLS_UNREGISTER,
  CanopyErrorPayloadSchema,
  CoreClientToolsRegisterResultSchema,
  CoreClientToolsUnregisterResultSchema,
  interfaceToolDescriptor,
  isUnknownKeyedWriteOutcome,
  type CanopyErrorPayload,
  type CoreClientToolsRegisterResult,
  type CoreClientToolsUnregisterResult,
  type InterfaceToolName,
} from '@canopy/protocol/canopy-core';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';

/**
 * What a page learned about one lease request. `refused` is definite: the
 * backend answered and applied nothing, so a registration key stays unspent.
 * `unknown` means the request may have landed (a lost or unusable reply), so
 * only the same key may repeat a registration.
 */
export type InterfaceToolsAck<Result> =
  | ({ status: 'acknowledged' } & Result)
  | { status: 'refused'; kind: CanopyErrorPayload['kind']; code?: string }
  | { status: 'unknown' };
export type InterfaceToolRegistrationAck =
  InterfaceToolsAck<CoreClientToolsRegisterResult>;
export type InterfaceToolRemovalAck =
  InterfaceToolsAck<CoreClientToolsUnregisterResult>;

type Reply =
  | { ok: true; value: unknown }
  | { ok: false; error: CanopyErrorPayload }
  | undefined;

async function send(
  method: string,
  params: Record<string, unknown>,
  reportRefusal: boolean,
): Promise<Reply | 'unavailable'> {
  if (typeof window === 'undefined' || !window.canopyCore) return 'unavailable';
  try {
    const reply: unknown = await window.canopyCore.invoke({
      kind: 'request',
      method,
      params,
    });
    const typed = asReply(reply);
    if (typed && !typed.ok && reportRefusal)
      // A static message and the typed kind only: no tool names or keys.
      reportClientAppError(
        new Error(`Interface tool registration refused: ${typed.error.kind}`),
      );
    return typed;
  } catch (cause) {
    // The outcome is unknown: the request may have landed.
    reportClientAppError(cause);
    return undefined;
  }
}

function asReply(reply: unknown): Reply {
  if (typeof reply !== 'object' || reply === null || !('ok' in reply))
    return undefined;
  if (reply.ok === true && 'value' in reply)
    return { ok: true, value: reply.value };
  if (reply.ok === false && 'error' in reply) {
    // The preload relay already types every error; reading it again keeps a
    // malformed reply from throwing. An unreadable error is an unknown outcome.
    const parsed = CanopyErrorPayloadSchema.safeParse(reply.error);
    if (parsed.success) return { ok: false, error: parsed.data };
  }
  return undefined;
}

/** Registers the catalog tools this page implements on its own lease. */
export async function registerInterfaceTools(
  names: readonly InterfaceToolName[],
  idempotencyKey: string,
): Promise<InterfaceToolRegistrationAck> {
  const reply = await send(
    CORE_CLIENT_TOOLS_REGISTER,
    {
      tools: names.map(interfaceToolDescriptor),
      _meta: { idempotencyKey },
    },
    true,
  );
  return acknowledge(reply, CoreClientToolsRegisterResultSchema);
}

/** Removes every tool this page registered. */
export function unregisterAllInterfaceTools(): Promise<InterfaceToolRemovalAck> {
  return removeTools({ all: true });
}

/** Removes the named tools from this page's lease. */
export function unregisterInterfaceTools(
  names: readonly InterfaceToolName[],
): Promise<InterfaceToolRemovalAck> {
  return removeTools({ toolNames: [...names] });
}

async function removeTools(
  params: Record<string, unknown>,
): Promise<InterfaceToolRemovalAck> {
  const reply = await send(CORE_CLIENT_TOOLS_UNREGISTER, params, false);
  // Inherent removals can finish before the relay times out or closes. Its
  // same-request recovery is uncertain, unlike a keyed write's refusal.
  if (
    reply &&
    reply !== 'unavailable' &&
    !reply.ok &&
    reply.error.retry.kind === 'same_request'
  )
    return { status: 'unknown' };
  return acknowledge(reply, CoreClientToolsUnregisterResultSchema);
}

function acknowledge<Result extends object>(
  reply: Reply | 'unavailable',
  schema: {
    safeParse(
      value: unknown,
    ): { success: true; data: Result } | { success: false };
  },
): InterfaceToolsAck<Result> {
  if (reply === 'unavailable')
    return { status: 'refused', kind: 'capability_unavailable' };
  if (!reply) return { status: 'unknown' };
  if (!reply.ok)
    return isUnknownKeyedWriteOutcome(reply.error)
      ? { status: 'unknown' }
      : {
          status: 'refused',
          kind: reply.error.kind,
          ...(reply.error.code === undefined ? {} : { code: reply.error.code }),
        };
  // An answered success we cannot read still applied: the same key replays it.
  const parsed = schema.safeParse(reply.value);
  return parsed.success
    ? { ...parsed.data, status: 'acknowledged' }
    : { status: 'unknown' };
}

/*
 * A page has one lease, and a registration replaces its whole set, so every
 * bridge on the page contributes here and the page registers the union
 * (CAN-5822). One reconcile loop runs at a time, so additions and removals are
 * strictly ordered and a late acknowledgement can only update bookkeeping,
 * never revive a withdrawn tool. Removing tools uses unregister, which spends
 * none of the lease's registration keys.
 *
 * Bookkeeping follows what the backend acknowledged, not what was asked:
 * - `acked`: the names the last acknowledged registration left on the lease.
 * - `maybeServed`: `acked` plus the names of a registration whose outcome is
 *   unknown. Removal covers this set, so a lost reply that applied is still
 *   withdrawn.
 * - `unknownAttempt`: the key and names of the last unknown registration. The
 *   backend replays a known key without applying it again and refuses it for
 *   other tools, so the key repeats only for the same names with no applied
 *   or uncertain removal since; anything else mints a new key.
 * A refusal is not retried on its own: the next contribution or withdrawal
 * tries again. Unknown outcomes and failed removals retry a few times with
 * backoff that a new contribution or withdrawal cuts short.
 */
const RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 4_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

const contributions = new Map<number, readonly InterfaceToolName[]>();
let nextContribution = 0;
let acked: ReadonlySet<InterfaceToolName> = new Set();
let maybeServed: ReadonlySet<InterfaceToolName> = new Set();
let unknownAttempt:
  | { readonly key: string; readonly names: readonly InterfaceToolName[] }
  | undefined;
let running = false;
let triggered = false;
let wake: (() => void) | undefined;

const desiredNames = (): InterfaceToolName[] =>
  [...new Set([...contributions.values()].flat())].sort();

const sameNames = (
  left: ReadonlySet<InterfaceToolName>,
  right: readonly InterfaceToolName[],
): boolean => left.size === right.length && right.every((n) => left.has(n));

type Step =
  | { kind: 'remove'; names: readonly InterfaceToolName[]; all: boolean }
  | { kind: 'register'; names: readonly InterfaceToolName[] };

function nextStep(): Step | undefined {
  const desired = desiredNames();
  const stale = [...maybeServed].filter((name) => !desired.includes(name));
  if (stale.length > 0)
    return { kind: 'remove', names: stale, all: desired.length === 0 };
  if (desired.length > 0 && !sameNames(acked, desired))
    return { kind: 'register', names: desired };
  return undefined;
}

type Outcome = 'done' | 'refused' | 'unknown';

async function runStep(step: Step): Promise<Outcome> {
  if (step.kind === 'remove') {
    const ack = await (step.all
      ? unregisterAllInterfaceTools()
      : unregisterInterfaceTools(step.names));
    if (
      ack.status === 'refused' &&
      ack.kind === 'not_found' &&
      ack.code === 'core.client.tools.notFound'
    ) {
      // Only this refusal proves the lease is absent. Forget the whole served
      // set so a lost initial registration cannot block the remaining tools.
      unknownAttempt = undefined;
      acked = new Set();
      maybeServed = acked;
      return 'done';
    }
    // A definite refusal cannot invalidate the earlier registration receipt.
    if (ack.status === 'refused') return 'refused';
    unknownAttempt = undefined;
    const keep = (name: InterfaceToolName): boolean =>
      !step.all && !step.names.includes(name);
    if (ack.status === 'unknown') {
      // The removal may have applied: these names are no longer known to be
      // registered, so a re-add registers them again under a new key. They
      // stay in `maybeServed` until a removal is acknowledged.
      acked = new Set([...acked].filter(keep));
      return 'unknown';
    }
    acked = new Set([...acked].filter(keep));
    maybeServed = new Set([...maybeServed].filter(keep));
    return 'done';
  }
  const key =
    unknownAttempt && sameNames(new Set(unknownAttempt.names), step.names)
      ? unknownAttempt.key
      : `interface-tools:${crypto.randomUUID()}`;
  const ack = await registerInterfaceTools(step.names, key);
  if (ack.status === 'acknowledged') {
    acked = new Set(step.names);
    maybeServed = acked;
    unknownAttempt = undefined;
    return 'done';
  }
  if (ack.status === 'unknown') {
    maybeServed = new Set([...acked, ...step.names]);
    unknownAttempt = { key, names: step.names };
    return 'unknown';
  }
  // This dispatch's refusal cannot resolve a previous unknown registration.
  // Preserve its key so a later contribution can recover the original receipt.
  return 'refused';
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      wake = undefined;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    wake = finish;
  });
}

async function reconcile(): Promise<void> {
  let failures = 0;
  for (;;) {
    const step = nextStep();
    if (!step) return;
    const outcome = await runStep(step);
    // A change that arrived meanwhile restarts from the current desired set.
    if (triggered) return;
    if (outcome === 'done') {
      failures = 0;
      continue;
    }
    if (outcome === 'refused' && step.kind === 'register') return;
    failures += 1;
    if (failures >= MAX_ATTEMPTS) return;
    await pause(RETRY_DELAYS_MS[failures - 1] ?? 0);
    if (triggered) return;
  }
}

async function drain(): Promise<void> {
  try {
    while (triggered) {
      triggered = false;
      await reconcile();
    }
  } catch (cause) {
    reportClientAppError(cause);
  } finally {
    running = false;
  }
}

function scheduleSync(): void {
  triggered = true;
  wake?.();
  if (running) return;
  running = true;
  // Combine root bridge contributions made in the same commit before sending.
  queueMicrotask((): void => {
    void drain();
  });
}

/**
 * Adds the catalog tools one bridge implements to this page's lease and
 * returns the function that withdraws them. A failure leaves the tools absent
 * until the next retry or change; it never marks them registered.
 */
export function contributeInterfaceTools(
  names: readonly InterfaceToolName[],
): () => void {
  const id = nextContribution++;
  contributions.set(id, [...names]);
  scheduleSync();
  return (): void => {
    if (contributions.delete(id)) scheduleSync();
  };
}
