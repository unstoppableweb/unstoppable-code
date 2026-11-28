import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  CanopyOperationError,
  defineRuntimeModule,
  type CanopyHandlerContext,
  type RuntimeInstructionGuard,
  type RuntimeModule,
  type RuntimeStreamGuard,
} from '@canopy/core-runtime';
import type {
  CanopyControlWindowIdentity,
  CanopyWindowTicketVerifier,
} from '@canopy/core-runtime/node';
import {
  CORE_CLIENT_WINDOW_INSTRUCTION_DEFINITIONS,
  CoreClientWindowTicketSchema,
  WORKER_TERMINAL_GRANTS,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CoreClientWindowGrantParams,
  type CoreClientWindowIssueParams,
  type CoreClientWindowIssueResult,
  type CoreClientWindowRevokeParams,
  type CoreClientWindowRight,
} from '@canopy/protocol/canopy-core';

/** How long an issued ticket can be presented; checked on presentation only. */
const WINDOW_TICKET_TTL_MS = 60_000;
/** Unpresented tickets one issuing lease may hold at once. */
const WINDOW_MAX_OUTSTANDING_TICKETS = 16;
/** Issue replies kept per lease for keyed replay; the oldest goes first. */
const MAX_ISSUE_REPLAYS = 64;
/** Window instances one lease may hold, and terminals one window may be granted. */
const WINDOW_MAX_PER_LEASE = 256;
const WINDOW_MAX_GRANTS = 1024;
/**
 * Attachments one window may hold at once: room for the renderer's budget of
 * 6, while two windows still fit the 16 host slots main's mirror of up to 48
 * terminals leaves free.
 */
const WINDOW_MAX_ATTACHMENTS = 8;

const WINDOW_PRINCIPAL_PREFIX = 'desktop-window:';

/**
 * Everything a window connection is served (CAN-8039): attach, write and
 * resize on the terminals it is granted, dropping its own attachments
 * (CAN-8067), runtime reads, and its own lease. Not create, kill, release,
 * restore, get, list, events, the record, tools or window admission itself.
 */
export const WINDOW_OPERATIONS: ReadonlySet<string> = new Set([
  'worker.terminal.attach',
  'worker.terminal.write',
  'worker.terminal.resize',
  'core.events.unsubscribe',
  'core.runtime.health.get',
  'core.runtime.manifest.get',
  'core.client.lease.acquire',
  'core.client.lease.renew',
  'core.client.lease.release',
  'core.client.capabilities.register',
]);

const WINDOW_CALLER_GRANTS: ReadonlySet<string> = new Set([
  'core.runtime.read',
  'core.client.manage',
  WORKER_TERMINAL_GRANTS.read,
  WORKER_TERMINAL_GRANTS.write,
]);

/**
 * The caller a window connection runs as: the caller its connection would
 * otherwise get, narrowed to the window grants it already holds, so a ticket
 * never adds a right. The guard then limits it to its granted terminals.
 */
export function windowConnectionCaller(
  base: CanopyCallerDescriptor,
  { windowInstanceId }: CanopyControlWindowIdentity,
): CanopyCallerDescriptor {
  return {
    ...base,
    principalId: `${WINDOW_PRINCIPAL_PREFIX}${windowInstanceId}`,
    interfaceKind: 'desktop',
    grants: base.grants.filter((grant) => WINDOW_CALLER_GRANTS.has(grant)),
  };
}

const DENIED: CanopyErrorPayload = {
  kind: 'permission_denied',
  message: "This window hasn't been granted this terminal.",
  retry: { kind: 'never' },
};

function denied(): CanopyOperationError {
  return new CanopyOperationError(DENIED);
}

// Code-free, as the control plane's own lease refusals are.
function leaseRequired(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    message: 'This operation requires a live client lease on this connection.',
    retry: { kind: 'never' },
  });
}

function exhausted(message: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'resource_exhausted',
    message,
    retry: { kind: 'never' },
  });
}

function heldElsewhere(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    message: 'This window instance belongs to another client lease.',
    retry: { kind: 'never' },
  });
}

interface Ticket {
  readonly secret: Buffer;
  readonly windowInstanceId: string;
  readonly issuerLeaseId: string;
  readonly expiresAt: number;
}

interface Attachment {
  readonly terminalId: string;
  readonly end: () => void;
}

interface WindowRecord {
  readonly issuerLeaseId: string;
  readonly grants: Map<
    string,
    { readonly grantId: string; rights: ReadonlySet<CoreClientWindowRight> }
  >;
  readonly attachments: Set<Attachment>;
}

interface IssueReplay {
  readonly windowInstanceId: string;
  readonly label: string;
  readonly result: CoreClientWindowIssueResult;
}

interface DaemonWindowAdmission {
  /** Serves `core.client.window.*` on the daemon's core. */
  readonly module: RuntimeModule;
  /** The control plane's `windowTickets` option. */
  readonly tickets: CanopyWindowTicketVerifier;
  /** Refuses a window's forwarded write or resize without its right. */
  readonly instructionGuard: (
    ...args: Parameters<RuntimeInstructionGuard>
  ) => void;
  /** Refuses a window's forwarded attach without its right, and ends it on revoke. */
  readonly streamGuard: RuntimeStreamGuard;
  /** A client lease ended: its tickets and every window it issued end. */
  leaseEnded(leaseId: string): void;
}

interface DaemonWindowAdmissionOptions {
  /** Test seam; production presents tickets for {@link WINDOW_TICKET_TTL_MS}. */
  readonly ticketTtlMs?: number;
  readonly now?: () => number;
}

function terminalIdOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const terminalId: unknown = Reflect.get(params, 'terminalId');
  return typeof terminalId === 'string' ? terminalId : undefined;
}

function windowOf(context: CanopyHandlerContext): string | undefined {
  const { principalId } = context.caller;
  return principalId.startsWith(WINDOW_PRINCIPAL_PREFIX)
    ? principalId.slice(WINDOW_PRINCIPAL_PREFIX.length)
    : undefined;
}

const RIGHT_FOR: Readonly<Record<string, CoreClientWindowRight>> = {
  'worker.terminal.write': 'write',
  'worker.terminal.resize': 'resize',
  'worker.terminal.attach': 'attach',
};

/**
 * The daemon's window admission (CAN-8039). Electron main's ordinary
 * connection issues single-use tickets and grants each window rights on
 * specific terminals; both belong to the issuing client lease. A ticket
 * admits one connection as `desktop-window:<windowInstanceId>`. Grants are
 * keyed by window instance, so a reconnecting window needs a new ticket but
 * keeps its grants. Only window principals are checked; every other caller
 * passes unchanged. Tickets expire on presentation, with no timer.
 */
export function createDaemonWindowAdmission(
  options: DaemonWindowAdmissionOptions = {},
): DaemonWindowAdmission {
  const now = options.now ?? Date.now;
  const ttlMs = options.ticketTtlMs ?? WINDOW_TICKET_TTL_MS;
  const tickets = new Map<string, Ticket>();
  const windows = new Map<string, WindowRecord>();
  const replays = new Map<string, Map<string, IssueReplay>>();
  const endedListeners = new Set<(windowInstanceId: string) => void>();

  const leaseOf = (context: CanopyHandlerContext): string => {
    // The host binds these operations to a lease; refused without one.
    if (!context.lease) throw leaseRequired();
    return context.lease.leaseId;
  };

  /** This lease's window, created on first use; another lease's is refused. */
  const ownWindow = (
    leaseId: string,
    windowInstanceId: string,
  ): WindowRecord => {
    const existing = windows.get(windowInstanceId);
    if (existing) {
      if (existing.issuerLeaseId !== leaseId) throw heldElsewhere();
      return existing;
    }
    let held = 0;
    for (const record of windows.values())
      if (record.issuerLeaseId === leaseId) held += 1;
    if (held >= WINDOW_MAX_PER_LEASE)
      throw exhausted('This client lease holds too many window instances.');
    const created: WindowRecord = {
      issuerLeaseId: leaseId,
      grants: new Map(),
      attachments: new Set(),
    };
    windows.set(windowInstanceId, created);
    return created;
  };

  const endAttachments = (
    record: WindowRecord,
    keep: (attachment: Attachment) => boolean = () => false,
  ): void => {
    for (const attachment of Array.from(record.attachments))
      if (!keep(attachment)) {
        record.attachments.delete(attachment);
        attachment.end();
      }
  };

  const endWindow = (windowInstanceId: string): void => {
    const record = windows.get(windowInstanceId);
    if (!record) return;
    windows.delete(windowInstanceId);
    for (const [ticketId, ticket] of tickets)
      if (ticket.windowInstanceId === windowInstanceId)
        tickets.delete(ticketId);
    endAttachments(record);
    for (const listener of Array.from(endedListeners))
      listener(windowInstanceId);
  };

  const hasRight = (
    windowInstanceId: string,
    terminalId: string | undefined,
    right: CoreClientWindowRight | undefined,
  ): boolean =>
    terminalId !== undefined &&
    right !== undefined &&
    windows.get(windowInstanceId)?.grants.get(terminalId)?.rights.has(right) ===
      true;

  const issue = (
    leaseId: string,
    params: CoreClientWindowIssueParams,
  ): CoreClientWindowIssueResult => {
    const key = params._meta.idempotencyKey;
    const leaseReplays = replays.get(leaseId) ?? new Map<string, IssueReplay>();
    const replay = leaseReplays.get(key);
    if (replay) {
      if (
        replay.windowInstanceId !== params.windowInstanceId ||
        replay.label !== params.label
      )
        throw new CanopyOperationError({
          kind: 'invalid_argument',
          message: 'This idempotency key was used for another window.',
          retry: { kind: 'never' },
        });
      return replay.result;
    }
    const at = now();
    let outstanding = 0;
    for (const [ticketId, ticket] of tickets) {
      if (ticket.issuerLeaseId !== leaseId) continue;
      if (at >= ticket.expiresAt) tickets.delete(ticketId);
      else outstanding += 1;
    }
    // Checked first, so a refused issue claims no window instance.
    if (outstanding >= WINDOW_MAX_OUTSTANDING_TICKETS)
      throw exhausted('Too many window tickets wait to be presented.');
    ownWindow(leaseId, params.windowInstanceId);
    const ticketId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = at + ttlMs;
    tickets.set(ticketId, {
      secret: Buffer.from(secret),
      windowInstanceId: params.windowInstanceId,
      issuerLeaseId: leaseId,
      expiresAt,
    });
    const result = {
      ticketId,
      secret,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    leaseReplays.set(key, {
      windowInstanceId: params.windowInstanceId,
      label: params.label,
      result,
    });
    if (leaseReplays.size > MAX_ISSUE_REPLAYS)
      for (const oldest of leaseReplays.keys()) {
        leaseReplays.delete(oldest);
        break;
      }
    replays.set(leaseId, leaseReplays);
    return result;
  };

  const grant = (
    leaseId: string,
    params: CoreClientWindowGrantParams,
  ): { grantId: string } => {
    const record = ownWindow(leaseId, params.windowInstanceId);
    // Exactly the rights main asks for: the daemon can't tell a Claude
    // terminal from a shell (a restored one reads `interactive`), so Q-F's
    // attach-and-resize-only rule is main's grant policy, not checked here.
    const rights = new Set(params.rights);
    const existing = record.grants.get(params.terminalId);
    if (!existing && record.grants.size >= WINDOW_MAX_GRANTS)
      throw exhausted('This window holds too many terminal grants.');
    const grantId = existing?.grantId ?? randomUUID();
    record.grants.set(params.terminalId, { grantId, rights });
    // A narrowed grant ends the attachments it no longer allows.
    if (!rights.has('attach'))
      endAttachments(
        record,
        (attachment) => attachment.terminalId !== params.terminalId,
      );
    return { grantId };
  };

  const revoke = (
    leaseId: string,
    params: CoreClientWindowRevokeParams,
  ): { revoked: boolean } => {
    const record = windows.get(params.windowInstanceId);
    if (!record) return { revoked: false };
    if (record.issuerLeaseId !== leaseId) throw heldElsewhere();
    const { terminalId } = params;
    if (terminalId === undefined) {
      endWindow(params.windowInstanceId);
      return { revoked: true };
    }
    const revoked = record.grants.delete(terminalId);
    endAttachments(
      record,
      (attachment) => attachment.terminalId !== terminalId,
    );
    return { revoked };
  };

  const module = defineRuntimeModule({
    name: 'core.client.window',
    plane: 'core',
    definitions: {
      queries: {},
      instructions: CORE_CLIENT_WINDOW_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: {},
      instructions: {
        'core.client.window.issue': (params, context) =>
          issue(leaseOf(context), params),
        'core.client.window.grant': (params, context) =>
          grant(leaseOf(context), params),
        'core.client.window.revoke': (params, context) =>
          revoke(leaseOf(context), params),
      },
      streams: {},
    },
  });

  return {
    module,
    tickets: {
      redeem: (presented): CanopyControlWindowIdentity | null => {
        const parsed = CoreClientWindowTicketSchema.safeParse(presented);
        if (!parsed.success) return null;
        const ticket = tickets.get(parsed.data.ticketId);
        if (!ticket) return null;
        // Single use: consumed whatever the outcome.
        tickets.delete(parsed.data.ticketId);
        const secret = Buffer.from(parsed.data.secret);
        if (
          secret.length !== ticket.secret.length ||
          !timingSafeEqual(secret, ticket.secret) ||
          now() >= ticket.expiresAt ||
          windows.get(ticket.windowInstanceId)?.issuerLeaseId !==
            ticket.issuerLeaseId
        )
          return null;
        return {
          windowInstanceId: ticket.windowInstanceId,
          issuerLeaseId: ticket.issuerLeaseId,
        };
      },
      onWindowEnded: (listener): (() => void) => {
        endedListeners.add(listener);
        return () => void endedListeners.delete(listener);
      },
    },
    instructionGuard: (operation, params, context): void => {
      const windowInstanceId = windowOf(context);
      if (windowInstanceId === undefined) return;
      if (
        !hasRight(windowInstanceId, terminalIdOf(params), RIGHT_FOR[operation])
      )
        throw denied();
    },
    streamGuard: (operation, params, context, sink): (() => void) | void => {
      const windowInstanceId = windowOf(context);
      if (windowInstanceId === undefined) return;
      const terminalId = terminalIdOf(params);
      if (
        operation !== 'worker.terminal.attach' ||
        terminalId === undefined ||
        !hasRight(windowInstanceId, terminalId, 'attach')
      )
        throw denied();
      const record = windows.get(windowInstanceId);
      if (!record) throw denied();
      // Never retried blindly: room frees only when this window ends one.
      if (record.attachments.size >= WINDOW_MAX_ATTACHMENTS)
        throw exhausted('This window has too many terminal attachments.');
      const attachment: Attachment = {
        terminalId,
        end: () => sink.end('error', DENIED),
      };
      record.attachments.add(attachment);
      return () => void record.attachments.delete(attachment);
    },
    leaseEnded: (leaseId): void => {
      replays.delete(leaseId);
      for (const [ticketId, ticket] of tickets)
        if (ticket.issuerLeaseId === leaseId) tickets.delete(ticketId);
      for (const [windowInstanceId, record] of Array.from(windows))
        if (record.issuerLeaseId === leaseId) endWindow(windowInstanceId);
    },
  };
}
