import { randomUUID } from 'node:crypto';
import type {
  LedgerActorKind,
  LedgerAuthorDetails,
  LedgerContainer,
  LedgerOrigin,
} from '@canopy/protocol/canopy-core';

/** The trusted roles a host can bind a Ledger caller to. */
export const LEDGER_CALLER_ROLES = [
  'user',
  'interactive_chat',
  'pipeline_agent',
  'managed_delegation',
  'summary_publisher',
] as const;

export type LedgerCallerRole = (typeof LEDGER_CALLER_ROLES)[number];

export interface LedgerCallerActor {
  kind: LedgerActorKind;
  /** Stable host key for the actor, such as a persisted chat ID. */
  originKey: string;
  displayName: string;
}

/**
 * The actor that spawned a managed delegate, by its host key: the root chat,
 * or for a nested delegate the delegate one level up. The host cannot know the
 * parent's actor ID in a ledger, so the handlers resolve this to the parent's
 * actor there, registering it on first use.
 */
export interface LedgerCallerParentActor {
  readonly kind: 'chat' | 'managed_delegation';
  /** A persisted chat ID or a durable delegation ID. */
  readonly originKey: string;
  /** The name the parent is registered under if the ledger lacks it. */
  readonly displayName: string;
}

/**
 * A managed delegate's lineage: its delegation, the actor that spawned it (as
 * a host key, resolved to `parentActorId` when the delegate writes), the root
 * chat and the run generation.
 */
export type LedgerCallerDelegationOrigin = Omit<
  Extract<LedgerOrigin, { kind: 'managed_delegation' }>,
  'ledgerId' | 'parentActorId'
> & { readonly parent: LedgerCallerParentActor };

/**
 * Origin identifiers the Ledger cannot derive from the container and actor:
 * the attempt of a pipeline agent, or the lineage of a managed delegate. The
 * handlers add the bound `ledgerId`. User, chat and Summary origins are
 * derived from the binding itself and need none.
 */
export type LedgerCallerOrigin =
  | Omit<Extract<LedgerOrigin, { kind: 'pipeline_agent' }>, 'ledgerId'>
  | LedgerCallerDelegationOrigin;

export interface LedgerCallerBindingRegistration {
  container: LedgerContainer;
  /** Creation time of the container; with the container it keys the scope. */
  containerCreatedAt: string;
  actor: LedgerCallerActor;
  role: LedgerCallerRole;
  /** Author details as the host observed them when registering. */
  authorDetails: LedgerAuthorDetails;
  /** Runtime generation of the calling surface when it registered. */
  runtimeGeneration: number;
  /**
   * Required for the `pipeline_agent` and `managed_delegation` roles before
   * they can write; ignored for the others.
   */
  origin?: LedgerCallerOrigin;
  /**
   * Exact values the caller's writes must never store, such as a pipeline
   * step's configured secrets. Host-supplied; never sent anywhere.
   */
  secretValues?: readonly string[];
  /** Lifetime in milliseconds. Omit to keep the binding until it is revoked. */
  ttlMs?: number;
}

/** A registered binding: a frozen snapshot of what the host registered. */
export interface LedgerCallerBinding {
  readonly bindingId: string;
  readonly container: Readonly<LedgerContainer>;
  readonly containerCreatedAt: string;
  readonly actor: Readonly<LedgerCallerActor>;
  readonly role: LedgerCallerRole;
  readonly authorDetails: Readonly<LedgerAuthorDetails>;
  readonly runtimeGeneration: number;
  /** Present only when the host registered one. */
  readonly origin?: Readonly<LedgerCallerOrigin>;
  /** Exact values masked out of every write; present only when registered. */
  readonly secretValues?: readonly string[];
  /** Clock time of registration, in epoch milliseconds. */
  readonly registeredAt: number;
  /** Clock time from which the binding no longer resolves; null if never. */
  readonly expiresAt: number | null;
}

export interface LedgerCallerBindingRegistryOptions {
  /** Epoch-millisecond clock. */
  now?: () => number;
}

function sameContainer(left: LedgerContainer, right: LedgerContainer): boolean {
  switch (left.kind) {
    case 'code_worktree':
      return (
        right.kind === 'code_worktree' &&
        left.workspaceId === right.workspaceId &&
        left.worktreeId === right.worktreeId
      );
    case 'cowork_entry':
      return (
        right.kind === 'cowork_entry' &&
        left.workspaceId === right.workspaceId &&
        left.entryId === right.entryId
      );
    case 'advisor_entry':
      return (
        right.kind === 'advisor_entry' &&
        left.appWorkspaceId === right.appWorkspaceId &&
        left.entryId === right.entryId
      );
    case 'global':
      return (
        right.kind === 'global' &&
        left.owner.kind === right.owner.kind &&
        (left.owner.kind !== 'organization' ||
          (right.owner.kind === 'organization' &&
            left.owner.organizationId === right.owner.organizationId))
      );
  }
}

/**
 * In-memory registry of trusted Ledger caller bindings. Host code registers
 * who is calling and receives an unguessable opaque ID, which it passes as
 * `caller.principalId` on `core.ledger.*` calls; handlers resolve it and
 * reject IDs that are unknown, revoked or expired. Bindings are never
 * persisted, so none survive a restart.
 */
export class LedgerCallerBindingRegistry {
  private readonly bindings = new Map<string, LedgerCallerBinding>();
  private readonly now: () => number;

  constructor(options: LedgerCallerBindingRegistryOptions = {}) {
    this.now = options.now ?? ((): number => Date.now());
  }

  /** Registers a binding and returns its opaque ID. */
  register(registration: LedgerCallerBindingRegistration): string {
    const { runtimeGeneration, ttlMs } = registration;
    if (!Number.isSafeInteger(runtimeGeneration) || runtimeGeneration < 0) {
      throw new RangeError(
        'A Ledger caller runtime generation must be a non-negative integer',
      );
    }
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new RangeError(
        'A Ledger caller binding lifetime must be a positive duration',
      );
    }
    const registeredAt = this.now();
    this.dropExpired(registeredAt);
    const bindingId = randomUUID();
    const binding: LedgerCallerBinding = Object.freeze({
      bindingId,
      container: Object.freeze({ ...registration.container }),
      containerCreatedAt: registration.containerCreatedAt,
      actor: Object.freeze({ ...registration.actor }),
      role: registration.role,
      authorDetails: Object.freeze({ ...registration.authorDetails }),
      runtimeGeneration,
      ...(registration.origin === undefined
        ? {}
        : { origin: freezeCallerOrigin(registration.origin) }),
      ...(registration.secretValues === undefined ||
      registration.secretValues.length === 0
        ? {}
        : { secretValues: Object.freeze([...registration.secretValues]) }),
      registeredAt,
      expiresAt: ttlMs === undefined ? null : registeredAt + ttlMs,
    });
    this.bindings.set(bindingId, binding);
    return bindingId;
  }

  /** The live binding for an ID, or undefined if unknown, revoked or expired. */
  resolve(bindingId: string): LedgerCallerBinding | undefined {
    const binding = this.bindings.get(bindingId);
    if (!binding) return undefined;
    if (isExpired(binding, this.now())) {
      this.bindings.delete(bindingId);
      return undefined;
    }
    return binding;
  }

  /**
   * Live caller bindings for one container incarnation. This is a read-only
   * view of the trusted host registrations, used to resolve running pipeline
   * and delegate actors that are not owner-picker candidates.
   */
  listForScope(
    container: LedgerContainer,
    containerCreatedAt: string,
  ): readonly LedgerCallerBinding[] {
    const now = this.now();
    return Array.from(this.bindings.values()).filter(
      (binding) =>
        sameContainer(binding.container, container) &&
        binding.containerCreatedAt === containerCreatedAt &&
        !isExpired(binding, now),
    );
  }

  /** Revokes one binding. Returns whether it was live. */
  revoke(bindingId: string): boolean {
    const live = this.resolve(bindingId) !== undefined;
    this.bindings.delete(bindingId);
    return live;
  }

  /** Revokes every live binding the predicate matches and returns the count. */
  revokeWhere(predicate: (binding: LedgerCallerBinding) => boolean): number {
    const now = this.now();
    let revoked = 0;
    this.bindings.forEach((binding, bindingId): void => {
      if (isExpired(binding, now)) {
        this.bindings.delete(bindingId);
      } else if (predicate(binding)) {
        this.bindings.delete(bindingId);
        revoked += 1;
      }
    });
    return revoked;
  }

  private dropExpired(now: number): void {
    this.bindings.forEach((binding, bindingId): void => {
      if (isExpired(binding, now)) this.bindings.delete(bindingId);
    });
  }
}

function isExpired(binding: LedgerCallerBinding, now: number): boolean {
  return binding.expiresAt !== null && now >= binding.expiresAt;
}

function freezeCallerOrigin(
  origin: LedgerCallerOrigin,
): Readonly<LedgerCallerOrigin> {
  if (origin.kind === 'managed_delegation') {
    return Object.freeze({
      ...origin,
      parent: Object.freeze({ ...origin.parent }),
      root: Object.freeze({ ...origin.root }),
    });
  }
  return Object.freeze({ ...origin });
}

let defaultRegistry: LedgerCallerBindingRegistry | undefined;

/** The app's caller-binding registry. */
export function getLedgerCallerBindingRegistry(): LedgerCallerBindingRegistry {
  defaultRegistry ??= new LedgerCallerBindingRegistry();
  return defaultRegistry;
}
