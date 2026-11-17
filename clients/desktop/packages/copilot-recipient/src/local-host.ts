import { VaultSecretPinSchema } from '@canopy/protocol/canopy-core';
import { randomUUID } from 'node:crypto';
import {
  COPILOT_RECIPIENT_LIMITS as limits,
  CopilotCallbackRequestSchema,
  CopilotProjectedEventSchema,
  CopilotRecipientAudienceSchema,
  CopilotRecipientCommandSchema,
  CopilotRecipientPurposeSchema,
  CopilotRecipientResultSchema,
  type CopilotCallbackReply,
  type CopilotCallbackRequest,
  type CopilotProjectedEvent,
  type CopilotRecipientAudience,
  type CopilotRecipientCommand,
  type CopilotRecipientMessage,
  type CopilotRecipientOutcome,
  type CopilotRecipientPurpose,
  type CopilotRecipientRefusal,
  type CopilotRecipientResult,
  type CopilotRecipientTurn,
} from '@canopy/protocol/copilot-recipient';
import {
  redactCopilotTextParts,
  redactCopilotToolValue,
} from './text-redaction';
import type { CopilotRecipientIdentity } from './runtime';
export type { CopilotProcessOwner } from './runtime';

/** Structural P4 view: no core service, writer, refresh grant or host path dependency. */
export interface CopilotRecipientHead {
  readonly epoch: string;
  readonly account: { readonly host: string; readonly id: string };
  readonly pin: {
    readonly ref: { readonly vaultId: string; readonly entryId: string };
    readonly revision: number;
  };
}
export interface CopilotRecipientBinding {
  readonly head: CopilotRecipientHead;
  readonly authorityGeneration: number;
  readonly publicationGeneration: number;
  readonly purpose: CopilotRecipientPurpose;
  readonly audience: CopilotRecipientAudience;
  readonly deadline: number;
}
export interface CopilotLocalExecution {
  readonly signal: AbortSignal;
  readonly audience: CopilotRecipientAudience;
  readonly turn: CopilotRecipientTurn | undefined;
  /** Revalidates synchronously after token acquisition, immediately before a provider RPC. */
  admit(): void;
  /** Acquires access under lease admission. Never a wire callback. */
  token(): Promise<string>;
  sessionToken(
    host: string,
    sessionId: string,
  ): Promise<{ kind: 'token'; accessToken: string; expiresIn: number }>;
  callback(request: CopilotCallbackRequest): Promise<CopilotCallbackReply>;
  emit(event: CopilotProjectedEvent): void;
}
export interface CopilotLocalRuntime {
  readonly identity: CopilotRecipientIdentity;
  isClosed(): boolean;
  readonly exited: Promise<void>;
  execute(
    purpose: CopilotRecipientPurpose,
    context: CopilotLocalExecution,
  ): Promise<CopilotRecipientResult>;
  close(): Promise<void>;
}
/** Trusted in-process evidence only. Never serialized in a recipient result. */
export interface CopilotLocalPresentation {
  readonly id: string;
  readonly handle: string;
  readonly binding: CopilotRecipientBinding;
  readonly committedPin: CopilotRecipientHead['pin'] | null;
  readonly expiresAt: number;
}
export interface CopilotLocalCompletion {
  readonly handle: string;
  readonly binding: CopilotRecipientBinding;
  readonly presentations: readonly CopilotLocalPresentation[];
  readonly providerSuccess: true;
  readonly admittedCompletion: true;
}
export interface CopilotLocalHostOptions {
  readonly platform: 'darwin' | 'win32' | 'linux';
  /** Checked before any process or recipient creation. */
  capable(): boolean;
  /** Trusted adapter projects workspace/config paths and host policy, never wire data. */
  start(signal: AbortSignal): Promise<CopilotLocalRuntime>;
  /** Must synchronously compare account epoch/lineage and publication against current authority. */
  current(binding: CopilotRecipientBinding): boolean;
  /** P4 present(handle, epoch); only the fixed recipient port below can receive access. */
  present(handle: string, epoch: string): Promise<unknown>;
  /** Synchronous trusted owner; invoked only after acknowledged, admitted success. */
  completed?(evidence: CopilotLocalCompletion): void;
  readonly monotonicNow?: () => number;
  readonly wallNow?: () => number;
}
export interface CopilotLocalDelivery {
  readonly signal: AbortSignal;
  /** Revalidate immediately before the encoded writer accepts its next frame. */
  admit(): void;
}
type Completion = Extract<
  CopilotRecipientOutcome,
  { kind: 'completed' | 'accepted' }
>;
type Complete = (
  outcome: Completion,
  delivery: CopilotLocalDelivery,
) => Promise<void>;
export interface CopilotLocalChannel {
  /** Resolves only on peer acceptance; rejection or a hung send closes the handle. */
  send(
    message: CopilotRecipientMessage,
    delivery: CopilotLocalDelivery,
  ): Promise<void>;
}
export interface CopilotLocalHost {
  open(
    binding: CopilotRecipientBinding,
    channel: CopilotLocalChannel,
  ): Promise<CopilotRecipientOutcome>;
  receive(
    value: unknown,
    complete?: Complete,
  ): Promise<CopilotRecipientOutcome>;
  disconnect(handle: string): void;
  close(): void;
  readonly recipient: {
    admitted(
      handle: string,
      head: CopilotRecipientHead,
      generation: number,
    ): boolean;
    deliver(handle: string, accessToken: string, expiresAt: number): void;
    revoke(): void;
  };
}
interface Pending {
  readonly kind: CopilotCallbackRequest['kind'];
  readonly resolve: (reply: CopilotCallbackReply) => void;
  readonly reject: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
interface Lease {
  readonly handle: string;
  binding: CopilotRecipientBinding;
  readonly runtime: CopilotLocalRuntime;
  readonly identity: CopilotRecipientIdentity;
  readonly abort: AbortController;
  readonly channel: CopilotLocalChannel;
  readonly pending: Map<string, Pending>;
  readonly setupDeadline: number | undefined;
  deadlineTimer: ReturnType<typeof setTimeout>;
  readonly secrets: string[];
  readonly events: CopilotProjectedEvent[];
  sequence: number;
  outputBytes: number;
  running: boolean;
  closed: boolean;
  access?: { token: string; expiresAt: number; monotonicExpiresAt: number };
  accessDeadline?: number;
  provenance?: CopilotLocalPresentation;
  readonly used: Map<
    string,
    { presentation: CopilotLocalPresentation; monotonicExpiry: number }
  >;
  sessionId?: string;
  presentation?: Promise<string>;
  closePromise?: Promise<void>;
  sendTail: Promise<void>;
}
const refused = (reason: CopilotRecipientRefusal): CopilotRecipientOutcome => ({
  kind: 'refused',
  reason,
});
const failure = (): Error => new Error('Copilot recipient unavailable.');
const size = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
function sameAudience(
  a: CopilotRecipientAudience,
  b: CopilotRecipientAudience,
): boolean {
  return (
    a.kind === b.kind &&
    a.operationId === b.operationId &&
    (a.kind !== 'resume' ||
      (b.kind === 'resume' && a.sessionId === b.sessionId))
  );
}
function sameHead(a: CopilotRecipientHead, b: CopilotRecipientHead): boolean {
  // A received successor can have a newer revision while retaining this lineage.
  return (
    a.epoch === b.epoch &&
    a.account.host === b.account.host &&
    a.account.id === b.account.id &&
    a.pin.ref.vaultId === b.pin.ref.vaultId &&
    a.pin.ref.entryId === b.pin.ref.entryId
  );
}

/** No singleton, listeners, process or activation at module load. P6 must explicitly compose it. */
export function createCopilotLocalRecipientHost(
  options: CopilotLocalHostOptions,
): CopilotLocalHost {
  const now = options.monotonicNow ?? ((): number => performance.now());
  const wallNow = options.wallNow ?? Date.now;
  const leases = new Map<string, Lease>();
  const openings = new Set<AbortController>();
  let closed = false;
  let fence = 0;

  function admission(lease: Lease): CopilotRecipientRefusal | undefined {
    try {
      if (closed || lease.closed || lease.abort.signal.aborted) return 'stale';
      if (
        now() >=
        Math.min(
          lease.binding.deadline,
          lease.setupDeadline ?? Infinity,
          lease.accessDeadline ?? Infinity,
        )
      )
        return 'expired';
      const identityMatches = (): boolean => {
        if (lease.runtime.isClosed()) return false;
        const live = lease.runtime.identity;
        return (
          live.runtimeId === lease.identity.runtimeId &&
          live.pid === lease.identity.pid &&
          live.started === lease.identity.started
        );
      };
      if (lease.access && wallNow() >= lease.access.expiresAt) return 'expired';
      if (!identityMatches()) return 'identity';
      if (!options.current(structuredClone(lease.binding))) return 'stale';
      // Trusted ports can revoke or replace a process reentrantly.
      if (closed || lease.closed || lease.abort.signal.aborted) return 'stale';
      if (!identityMatches()) return 'identity';
      if (lease.access && wallNow() >= lease.access.expiresAt) return 'expired';
      return now() >=
        Math.min(
          lease.binding.deadline,
          lease.setupDeadline ?? Infinity,
          lease.accessDeadline ?? Infinity,
        )
        ? 'expired'
        : undefined;
    } catch {
      return 'unavailable';
    }
  }
  function stop(lease: Lease): Promise<void> {
    if (lease.closePromise) return lease.closePromise;
    lease.closed = true;
    leases.delete(lease.handle);
    lease.access = undefined;
    clearTimeout(lease.deadlineTimer);
    lease.abort.abort();
    for (const pending of lease.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject();
    }
    lease.pending.clear();
    lease.events.length = 0;
    // Never await reaping to close local use and results admission.
    lease.closePromise = Promise.resolve()
      .then(() => lease.runtime.close())
      .catch(() => undefined);
    return lease.closePromise;
  }
  function requireAdmission(lease: Lease): void {
    if (admission(lease)) {
      void stop(lease);
      throw failure();
    }
  }
  async function bounded<T>(
    lease: Lease,
    work: Promise<T>,
    timeoutMs: number | null = limits.callbackMs,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = (): void => reject(failure());
      lease.abort.signal.addEventListener('abort', abort, { once: true });
      if (timeoutMs !== null) {
        timer = setTimeout(abort, timeoutMs);
        timer.unref();
      }
      if (lease.abort.signal.aborted) abort();
    });
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      clearTimeout(timer);
      lease.abort.signal.removeEventListener('abort', abort);
    }
  }
  function armDeadline(lease: Lease): void {
    const deadline = Math.min(
      lease.binding.deadline,
      lease.setupDeadline ?? Infinity,
    );
    lease.accessDeadline = lease.access
      ? Math.min(deadline, lease.access.monotonicExpiresAt)
      : undefined;
    clearTimeout(lease.deadlineTimer);
    lease.deadlineTimer = setTimeout(
      () => {
        void stop(lease);
      },
      Math.max(0, (lease.accessDeadline ?? deadline) - now()),
    );
    lease.deadlineTimer.unref();
  }
  function scrub<T>(lease: Lease, value: T, parse: (value: unknown) => T): T {
    return parse(redactCopilotToolValue(value, lease.secrets));
  }
  function deliveryGuard(lease: Lease): CopilotLocalDelivery {
    return {
      signal: lease.abort.signal,
      admit: (): void => requireAdmission(lease),
    };
  }
  async function send(
    lease: Lease,
    body:
      | { kind: 'event'; event: CopilotProjectedEvent }
      | {
          kind: 'callback';
          correlationId: string;
          request: CopilotCallbackRequest;
        },
  ): Promise<void> {
    requireAdmission(lease);
    const message: CopilotRecipientMessage = {
      version: 1,
      handle: lease.handle,
      generation: lease.binding.publicationGeneration,
      sequence: ++lease.sequence,
      ...body,
    };
    // Buffered events are already charged at emit; only callbacks add bytes here.
    if (body.kind !== 'event') lease.outputBytes += size(message);
    if (
      lease.outputBytes > limits.outputBytes ||
      size(message) > limits.frameBytes
    )
      throw failure();
    const delivery = lease.sendTail.then(() => {
      requireAdmission(lease);
      return lease.channel.send(message, deliveryGuard(lease));
    });
    lease.sendTail = delivery.catch(() => {
      void stop(lease);
    });
    await bounded(lease, delivery);
    requireAdmission(lease);
  }
  async function callback(
    lease: Lease,
    request: CopilotCallbackRequest,
  ): Promise<CopilotCallbackReply> {
    try {
      requireAdmission(lease);
      if (lease.pending.size >= limits.callbacks) throw failure();
      if (
        request.kind === 'notice' &&
        (request.name === 'session' || request.name === 'prompt-accepted')
      ) {
        const expected =
          lease.binding.audience.kind === 'resume'
            ? lease.binding.audience.sessionId
            : lease.sessionId;
        if (
          !request.sessionId ||
          (expected !== undefined && expected !== request.sessionId)
        )
          throw failure();
        lease.sessionId = request.sessionId;
      }
      const validated = CopilotCallbackRequestSchema.parse(request);
      const projected = scrub(
        lease,
        validated,
        (value): CopilotCallbackRequest =>
          CopilotCallbackRequestSchema.parse(value),
      );
      // Do not ask an approver to approve a different, redacted invocation.
      if (JSON.stringify(projected) !== JSON.stringify(validated))
        throw failure();
      const correlationId = randomUUID();
      let pending!: Pending;
      const reply = new Promise<CopilotCallbackReply>((resolve, reject) => {
        const timer = setTimeout(() => {
          void stop(lease);
        }, limits.callbackMs);
        timer.unref();
        pending = {
          kind: request.kind,
          resolve,
          reject: (): void => reject(failure()),
          timer,
        };
        lease.pending.set(correlationId, pending);
      });
      // A synchronous peer reply is allowed; install correlation before sending.
      void reply.catch(() => undefined);
      await send(lease, {
        kind: 'callback',
        correlationId,
        request: projected,
      });
      const result = await reply;
      requireAdmission(lease);
      if (result.kind !== request.kind) throw failure();
      if (result.kind === 'notice' && !result.accepted) throw failure();
      return result;
    } catch {
      void stop(lease);
      throw failure();
    }
  }
  function useAccess(lease: Lease): string {
    if (!lease.access) throw failure();
    // Cached access keeps the presentation that originally supplied it.
    if (options.completed) {
      if (!lease.provenance) throw failure();
      lease.used.set(lease.provenance.id, {
        presentation: lease.provenance,
        monotonicExpiry: lease.access.monotonicExpiresAt,
      });
    }
    return lease.access.token;
  }
  async function token(lease: Lease): Promise<string> {
    requireAdmission(lease);
    if (lease.access && lease.access.expiresAt > wallNow())
      return useAccess(lease);
    if (lease.presentation) return lease.presentation;
    lease.access = undefined;
    const work = (async (): Promise<string> => {
      // Admission is checked at mint, here before P4 presentation, in P4 admitted,
      // and once more at synchronous deliver; no bearer crosses the wire.
      requireAdmission(lease);
      const presented = await bounded(
        lease,
        Promise.resolve().then(() => {
          requireAdmission(lease);
          return options.present(lease.handle, lease.binding.head.epoch);
        }),
      );
      requireAdmission(lease);
      if (!lease.access || lease.access.expiresAt <= wallNow()) throw failure();
      if (options.completed) {
        if (
          typeof presented !== 'object' ||
          presented === null ||
          !('kind' in presented) ||
          presented.kind !== 'delivered' ||
          !('committedPin' in presented) ||
          !('expiresAt' in presented) ||
          presented.expiresAt !== lease.access.expiresAt
        )
          throw failure();
        lease.provenance = {
          id: randomUUID(),
          handle: lease.handle,
          binding: structuredClone(lease.binding),
          committedPin:
            presented.committedPin === null
              ? null
              : VaultSecretPinSchema.parse(presented.committedPin),
          expiresAt: lease.access.expiresAt,
        };
      }
      return useAccess(lease);
    })();
    lease.presentation = work;
    try {
      return await work;
    } finally {
      lease.presentation = undefined;
    }
  }

  const recipient = Object.freeze({
    admitted(
      handle: string,
      head: CopilotRecipientHead,
      generation: number,
    ): boolean {
      const lease = leases.get(handle);
      return (
        !!lease &&
        generation === lease.binding.authorityGeneration &&
        sameHead(lease.binding.head, head) &&
        !admission(lease)
      );
    },
    deliver(handle: string, accessToken: string, expiresAt: number): void {
      const lease = leases.get(handle);
      if (!lease) throw failure();
      requireAdmission(lease);
      if (
        !lease.presentation ||
        typeof accessToken !== 'string' ||
        !accessToken.length ||
        accessToken.length > 100_000 ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= wallNow()
      )
        throw failure();
      lease.secrets.push(accessToken);
      if (lease.secrets.length > 8) {
        void stop(lease);
        throw failure();
      }
      const monotonicExpiresAt = now() + expiresAt - wallNow();
      lease.access = { token: accessToken, expiresAt, monotonicExpiresAt };
      armDeadline(lease);
      // Reentrant closure during a trusted delivery never reopens this lease.
      requireAdmission(lease);
    },
    revoke(): void {
      fence++;
      for (const abort of openings) abort.abort();
      for (const lease of leases.values()) void stop(lease);
    },
  });

  async function open(
    binding: CopilotRecipientBinding,
    channel: CopilotLocalChannel,
  ): Promise<CopilotRecipientOutcome> {
    if (closed) return refused('stale');
    if (options.platform === 'linux') return refused('unsupported');
    try {
      if (!options.capable()) return refused('unavailable');
    } catch {
      return refused('unavailable');
    }
    if (leases.size + openings.size >= limits.handles) return refused('limit');
    let frozen: CopilotRecipientBinding;
    try {
      frozen = structuredClone(binding);
    } catch {
      return refused('invalid');
    }
    if (
      !CopilotRecipientAudienceSchema.safeParse(frozen.audience).success ||
      !CopilotRecipientPurposeSchema.safeParse(frozen.purpose).success ||
      !Number.isSafeInteger(frozen.authorityGeneration) ||
      frozen.authorityGeneration < 0 ||
      !Number.isSafeInteger(frozen.publicationGeneration) ||
      frozen.publicationGeneration < 0 ||
      !Number.isFinite(frozen.deadline) ||
      frozen.deadline <= now() ||
      frozen.deadline - now() > limits.lifetimeMs
    )
      return refused('invalid');
    try {
      if (!options.current(structuredClone(frozen))) return refused('stale');
    } catch {
      return refused('unavailable');
    }
    const capturedFence = fence;
    const abort = new AbortController();
    openings.add(abort);
    const startupTimer = setTimeout(
      () => abort.abort(),
      Math.max(0, frozen.deadline - now()),
    );
    startupTimer.unref();
    let runtime: CopilotLocalRuntime | undefined;
    try {
      const starting = options.start(abort.signal);
      void starting.then(
        (late) => {
          if (abort.signal.aborted) void late.close().catch(() => undefined);
        },
        () => undefined,
      );
      let cancelStart!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancelStart = (): void => reject(failure());
        abort.signal.addEventListener('abort', cancelStart, { once: true });
        if (abort.signal.aborted) cancelStart();
      });
      try {
        runtime = await Promise.race([starting, cancelled]);
      } finally {
        abort.signal.removeEventListener('abort', cancelStart);
      }
      if (
        closed ||
        abort.signal.aborted ||
        capturedFence !== fence ||
        now() >= frozen.deadline ||
        !options.current(structuredClone(frozen))
      )
        throw failure();
      const identity = Object.freeze({ ...runtime.identity });
      if (
        typeof identity.runtimeId !== 'string' ||
        !identity.runtimeId ||
        identity.runtimeId.length > 256 ||
        !Number.isSafeInteger(identity.pid) ||
        identity.pid <= 0 ||
        !Number.isFinite(identity.started) ||
        identity.started < 0 ||
        runtime.isClosed()
      )
        throw failure();
      const handle = randomUUID();
      const deadlineTimer = setTimeout(
        () => {
          const lease = leases.get(handle);
          if (lease) void stop(lease);
        },
        Math.max(0, frozen.deadline - now()),
      );
      deadlineTimer.unref();
      const lease: Lease = {
        handle,
        binding: frozen,
        runtime,
        identity,
        abort,
        channel,
        pending: new Map(),
        used: new Map(),
        setupDeadline:
          frozen.purpose === 'setup-probe' ? frozen.deadline : undefined,
        deadlineTimer,
        secrets: [],
        events: [],
        sequence: 0,
        outputBytes: 0,
        running: false,
        closed: false,
        sendTail: Promise.resolve(),
      };
      leases.set(handle, lease);
      requireAdmission(lease);
      void runtime.exited.then(
        () => stop(lease),
        () => stop(lease),
      );
      return {
        kind: 'opened',
        handle,
        generation: frozen.publicationGeneration,
      };
    } catch {
      abort.abort();
      if (runtime) void runtime.close().catch(() => undefined);
      return refused('unavailable');
    } finally {
      clearTimeout(startupTimer);
      openings.delete(abort);
    }
  }
  function matches(
    lease: Lease,
    command: CopilotRecipientCommand,
  ): CopilotRecipientRefusal | undefined {
    if (command.generation !== lease.binding.publicationGeneration)
      return 'stale';
    if (command.purpose !== lease.binding.purpose) return 'purpose';
    if (!sameAudience(command.audience, lease.binding.audience))
      return 'audience';
    return admission(lease);
  }
  async function receive(
    value: unknown,
    complete?: Complete,
  ): Promise<CopilotRecipientOutcome> {
    let command: CopilotRecipientCommand;
    try {
      if (size(value) > limits.frameBytes) return refused('limit');
      command = CopilotRecipientCommandSchema.parse(value);
    } catch {
      return refused('invalid');
    }
    const lease = leases.get(command.handle);
    if (!lease) return refused('stale');
    const refusal = matches(lease, command);
    if (refusal) {
      void stop(lease);
      return refused(refusal);
    }
    if (command.kind === 'renew') {
      // Admission above fences the old deadline; unused lifetime never accumulates.
      lease.binding = { ...lease.binding, deadline: now() + limits.lifetimeMs };
      armDeadline(lease);
      try {
        requireAdmission(lease);
        const outcome: Completion = { kind: 'accepted' };
        if (complete) {
          await bounded(lease, complete(outcome, deliveryGuard(lease)));
          requireAdmission(lease);
        }
        return outcome;
      } catch {
        void stop(lease);
        return refused('channel');
      }
    }
    if (command.kind === 'cancel' || command.kind === 'close') {
      void stop(lease);
      return { kind: 'accepted' };
    }
    if (command.kind === 'reply') {
      const pending = lease.pending.get(command.correlationId);
      if (!pending || command.reply.kind !== pending.kind) {
        void stop(lease);
        return refused('channel');
      }
      clearTimeout(pending.timer);
      lease.pending.delete(command.correlationId);
      pending.resolve(command.reply);
      return { kind: 'accepted' };
    }
    if (lease.running) return refused('limit');
    if ((lease.binding.purpose === 'turn') !== !!command.turn) {
      void stop(lease);
      return refused('invalid');
    }
    lease.running = true;
    try {
      await token(lease);
      const result = await bounded(
        lease,
        Promise.resolve().then(() => {
          requireAdmission(lease);
          return lease.runtime.execute(lease.binding.purpose, {
            signal: lease.abort.signal,
            audience: structuredClone(lease.binding.audience),
            turn: command.turn,
            admit: (): void => requireAdmission(lease),
            token: () => token(lease),
            async sessionToken(host, sessionId) {
              requireAdmission(lease);
              const origin = (value: string): string | undefined => {
                try {
                  const url = new URL(
                    value.includes('://') ? value : `https://${value}`,
                  );
                  if (
                    url.protocol !== 'https:' ||
                    url.username ||
                    url.password ||
                    url.port ||
                    url.pathname !== '/' ||
                    url.search ||
                    url.hash
                  )
                    return undefined;
                  return url.origin;
                } catch {
                  return undefined;
                }
              };
              const expected =
                lease.binding.audience.kind === 'resume'
                  ? lease.binding.audience.sessionId
                  : lease.sessionId;
              if (
                lease.binding.purpose !== 'turn' ||
                !sessionId ||
                sessionId.length > 256 ||
                !origin(host) ||
                origin(host) !== origin(lease.binding.head.account.host) ||
                (expected !== undefined && expected !== sessionId)
              )
                throw failure();
              lease.sessionId = sessionId;
              const accessToken = await token(lease);
              requireAdmission(lease);
              const access = lease.access;
              if (!access) throw failure();
              return {
                kind: 'token',
                accessToken,
                expiresIn: Math.max(
                  0,
                  // The SDK preflight needs provider lifetime, not the local lease TTL.
                  Math.floor(
                    Math.min(
                      access.expiresAt - wallNow(),
                      access.monotonicExpiresAt - now(),
                    ) / 1000,
                  ),
                ),
              };
            },
            callback: (request) => callback(lease, request),
            emit(event) {
              requireAdmission(lease);
              const parsed = CopilotProjectedEventSchema.parse(event);
              lease.outputBytes += size(parsed);
              if (
                lease.events.length >= limits.events ||
                lease.outputBytes > limits.outputBytes
              )
                throw failure();
              lease.events.push(parsed);
            },
          });
        }),
        null,
      );
      requireAdmission(lease);
      const projected = scrub(
        lease,
        result,
        (value): CopilotRecipientResult =>
          CopilotRecipientResultSchema.parse(value),
      );
      if (projected.kind !== lease.binding.purpose) throw failure();
      if (projected.kind === 'turn') {
        const expected =
          lease.binding.audience.kind === 'resume'
            ? lease.binding.audience.sessionId
            : lease.sessionId;
        if (expected !== undefined && projected.sessionId !== expected)
          throw failure();
      }
      // Hold free text until completion: mask secrets split across event boundaries.
      const events = lease.events.map((event) =>
        scrub(
          lease,
          event,
          (value): CopilotProjectedEvent =>
            CopilotProjectedEventSchema.parse(value),
        ),
      );
      // Raw and display inputs are alternative transcript views. Mask both
      // orders so a display override cannot hide a split-secret boundary.
      for (const display of [false, true]) {
        const slots = events.flatMap((event) => {
          if (event.kind === 'patch')
            return event.patch.patches.map((patch) => {
              if ('appendText' in patch)
                return {
                  text: patch.appendText,
                  replace: (text: string): void => {
                    patch.appendText = text;
                  },
                };
              const block = patch.block;
              if (block.type === 'text' || block.type === 'thinking')
                return {
                  text: block.text,
                  replace: (text: string): void => {
                    block.text = text;
                  },
                };
              if (block.type === 'tool_result')
                return {
                  text: block.output,
                  replace: (text: string): void => {
                    block.output = text;
                  },
                };
              const input = display && block.display ? block.display : block;
              return {
                text: input.input,
                replace: (text: string): void => {
                  input.input = text;
                },
              };
            });
          if (event.kind === 'tool')
            return [
              {
                text: event.output,
                replace: (text: string): void => {
                  event.output = text;
                },
              },
            ];
          return [
            {
              text: event.text,
              replace: (text: string): void => {
                event.text = text;
              },
            },
          ];
        });
        const masked = redactCopilotTextParts(
          slots.map((slot) => slot.text),
          lease.secrets,
        );
        slots.forEach((slot, index) => slot.replace(masked[index] ?? ''));
      }
      for (const event of events) await send(lease, { kind: 'event', event });
      if (size(projected) > limits.frameBytes) throw failure();
      requireAdmission(lease);
      const outcome: Completion = { kind: 'completed', result: projected };
      // Keep the lease live through the encoded result's acknowledged write,
      // not just through returning an in-process result to the adapter.
      if (complete) {
        await bounded(lease, complete(outcome, deliveryGuard(lease)));
        requireAdmission(lease);
      }
      if (options.completed) {
        requireAdmission(lease);
        if (!lease.used.size) throw failure();
        for (const { presentation, monotonicExpiry } of lease.used.values()) {
          if (
            wallNow() >= presentation.expiresAt ||
            now() >= monotonicExpiry ||
            !options.current(structuredClone(presentation.binding))
          )
            throw failure();
        }
        requireAdmission(lease);
        options.completed({
          handle: lease.handle,
          binding: structuredClone(lease.binding),
          presentations: structuredClone(
            [...lease.used.values()].map((u) => u.presentation),
          ),
          providerSuccess: true,
          admittedCompletion: true,
        });
        requireAdmission(lease);
      }
      return outcome;
    } catch {
      return refused('channel');
    } finally {
      void stop(lease);
    }
  }
  return Object.freeze({
    open,
    receive,
    recipient,
    disconnect(handle: string): void {
      const lease = leases.get(handle);
      if (lease) void stop(lease);
    },
    close(): void {
      closed = true;
      recipient.revoke();
    },
  });
}
