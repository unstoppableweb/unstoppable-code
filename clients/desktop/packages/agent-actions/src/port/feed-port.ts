import type {
  LedgerCommandReceipt,
  LedgerEntriesSearchResult,
  LedgerEntryAddParams,
  LedgerEntryUpdateParams,
  LedgerSearchEntriesToolInput,
  LedgerToolFailure,
  LedgerToolsUnavailableReason,
} from '@canopy/protocol/canopy-core';
import type { AgentActionCall } from '../surface/family';

/**
 * The Feed (Agent Ledger) behind AddFeedEntry, SearchFeedEntries and
 * UpdateFeedEntry on a host that serves them through the agent action
 * surface (CAN-6313). Each member runs one `core.ledger.*` operation as the
 * calling chat, in the Ledger its host binds to that chat; the scope, the
 * actor, author details and time come from the trusted call, never from
 * the tool's arguments.
 */
export interface AgentFeedPort<H> {
  /** `core.ledger.entry.add` as the calling chat. */
  add(
    params: AgentFeedParams<LedgerEntryAddParams>,
    idempotencyKey: string | undefined,
    call: AgentActionCall<H>,
  ): Promise<AgentFeedCommandResult>;
  /** `core.ledger.entry.update` as the calling chat. */
  update(
    params: AgentFeedParams<LedgerEntryUpdateParams>,
    idempotencyKey: string | undefined,
    call: AgentActionCall<H>,
  ): Promise<AgentFeedCommandResult>;
  /** `core.ledger.entries.search`, with `self` meaning the calling chat. */
  search(
    params: LedgerSearchEntriesToolInput,
    call: AgentActionCall<H>,
  ): Promise<AgentFeedSearchResult>;
}

/**
 * A keyed write's params without their request metadata. The port sends
 * `idempotencyKey` as the write's key (`_meta.idempotencyKey`): the tool's
 * `requestKey` (`request:<key>`), else the provider invocation
 * (`invocation:<toolUseId>`), else undefined, for which the port mints a
 * fresh key that cannot dedupe. A port hashes a key longer than the
 * request metadata allows.
 */
export type AgentFeedParams<Params> = Omit<Params, '_meta'>;

/** The calling chat's own actor, which results mark with `isSelf`. */
interface AgentFeedSelf {
  readonly selfActorId: string;
}

export interface AgentFeedCommandResult extends AgentFeedSelf {
  readonly receipt: LedgerCommandReceipt;
}

export interface AgentFeedSearchResult extends AgentFeedSelf {
  readonly result: LedgerEntriesSearchResult;
}

/**
 * Why a Feed call did not run or was refused, as the tool reports it:
 * `unavailable` when the calling chat has no usable Feed, `refused` with the
 * Ledger's typed refusal. Any other error is a failure whose outcome is
 * unknown.
 */
export type AgentFeedRefusal =
  | {
      readonly kind: 'unavailable';
      readonly reason: LedgerToolsUnavailableReason;
    }
  | { readonly kind: 'refused'; readonly failure: LedgerToolFailure };

export class AgentFeedError extends Error {
  /**
   * @param selfActorId The calling chat's actor when the port knows it, so a
   *   refusal's current entry marks the chat's own ownership.
   */
  constructor(
    readonly refusal: AgentFeedRefusal,
    readonly selfActorId: string | null = null,
  ) {
    super(
      refusal.kind === 'unavailable'
        ? refusal.reason
        : (refusal.failure.details?.reason ??
            refusal.failure.kind ??
            'refused'),
    );
    this.name = 'AgentFeedError';
  }
}
