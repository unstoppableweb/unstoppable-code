import type {
  LedgerActorKind,
  LedgerAuthorDetails,
  LedgerContainer,
  LedgerOrigin,
} from '@canopy/protocol/canopy-core';

/*
 * What a host registers to bind a Feed tool caller to a Ledger scope: the
 * caller's role, actor, author details and origin. Registries are the
 * host's own; these shapes are shared so every host's tools runtime speaks
 * the same registration (CAN-6422).
 */

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
