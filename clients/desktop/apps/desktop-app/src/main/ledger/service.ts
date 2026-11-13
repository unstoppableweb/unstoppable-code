import type { ZodType } from 'zod';
import {
  LEDGER_LIMITS,
  LedgerAuthorDetailsSchema,
  LedgerContentSchema,
  LedgerFileRefSchema,
  LedgerHighlightSchema,
  LedgerOriginSchema,
  ledgerSourceKindOfOrigin,
  LedgerTitleSchema,
  type LedgerActorFilter,
  type LedgerActorKind,
  type LedgerActorRef,
  type LedgerAddEntryParams,
  type LedgerAttribution,
  type LedgerAuthorDetails,
  type LedgerChangesListParams,
  type LedgerChangesListResult,
  type LedgerCommandReceipt,
  type LedgerEntriesSearchParams,
  type LedgerEntriesSearchResult,
  type LedgerEntry,
  type LedgerEntryAddParams,
  type LedgerEntryAddResult,
  type LedgerEntryGetParams,
  type LedgerEntryGetResult,
  type LedgerEntrySearchItem,
  type LedgerEntryUpdateParams,
  type LedgerEntryUpdateResult,
  type LedgerWorkSummaryGetParams,
  type LedgerWorkSummaryGetResult,
  type LedgerRollupsListParams,
  type LedgerRollupsListResult,
  type LedgerFileRef,
  type LedgerMutation,
  type LedgerOrigin,
  type LedgerOwnerCandidatePage,
  type LedgerOwnersListParams,
  type LedgerOwnersListResult,
  type LedgerSourceAvailability,
  type LedgerPublishSummaryParams,
  type LedgerSummaryPublishParams,
  type LedgerSummaryPublishResult,
  type LedgerSyncState,
} from '@canopy/protocol/canopy-core';
import type { CanopyHandlerContext } from '@canopy/core-runtime';
import {
  redactSecrets,
  redactValues,
} from '@canopy/execution-engine/lib/redaction';
import {
  LedgerActorDirectory,
  type LedgerChatLivenessSource,
  type LedgerOwnerEligibility,
} from './actor-directory';
import type { LedgerEntryChange } from './change-events';
import {
  readLedgerDelegateLineage,
  type LedgerDelegateLineageOwner,
  type LedgerDelegateLivenessSource,
} from './delegate-owners';
import type { LedgerPipelineAgentSource } from './pipeline-agent-owners';
import type {
  LedgerPendingTitleRecord,
  LedgerRelatedEntryChange,
  LedgerScopeRecord,
  LedgerStoreCommandReceipt,
} from '@canopy/desktop-shared/node/ledger';
import {
  getLedgerCallerBindingRegistry,
  type LedgerCallerBinding,
  type LedgerCallerBindingRegistry,
  type LedgerCallerDelegationOrigin,
  type LedgerCallerRole,
} from './caller-bindings';
import type { LedgerStoreClient } from './ledger-store-client';
import { LedgerScopeBindings, type LedgerBoundScope } from './scope-bindings';
import {
  ledgerDisabledError,
  ledgerOperationError,
  toLedgerOperationError,
  type LedgerErrorSite,
  type LedgerOperation,
} from './service-errors';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { LedgerStorageHostError } from './storage-host';
import type { LedgerSyncHold } from './sync-policy';

/**
 * Handler logic for the `core.ledger.*` operations. Every call is
 * gated by `canopy-ledger-enabled`, then resolved to a trusted caller binding;
 * scope, actor, origin, attribution and author details come from that
 * binding, never from params. Title, content and highlights are redacted
 * before any commit (LD02).
 */
export interface LedgerService {
  searchEntries(
    params: LedgerEntriesSearchParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerEntriesSearchResult>;
  getEntry(
    params: LedgerEntryGetParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerEntryGetResult>;
  listOwners(
    params: LedgerOwnersListParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerOwnersListResult>;
  getWorkSummary(
    params: LedgerWorkSummaryGetParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerWorkSummaryGetResult>;
  listChanges(
    params: LedgerChangesListParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerChangesListResult>;
  listRollups(
    params: LedgerRollupsListParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerRollupsListResult>;
  addEntry(
    params: LedgerEntryAddParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerEntryAddResult>;
  updateEntry(
    params: LedgerEntryUpdateParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerEntryUpdateResult>;
  publishSummary(
    params: LedgerSummaryPublishParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerSummaryPublishResult>;
}

/** What a source-availability override is asked about. */
export type LedgerSourceAvailabilitySubject =
  | { readonly kind: 'entry'; readonly entry: LedgerEntry }
  | {
      readonly kind: 'search_item';
      readonly item: LedgerEntrySearchItem;
      /** The item's origin, which a search item itself leaves out. */
      readonly origin: LedgerOrigin;
    };

export interface LedgerSourceAvailabilityRequest {
  readonly scope: LedgerBoundScope;
  readonly subject: LedgerSourceAvailabilitySubject;
  /** The value the store reported. */
  readonly stored: LedgerSourceAvailability;
  /**
   * The read this request belongs to: every item of one search page shares
   * it, so an override can read each source store once for the page.
   */
  readonly page: object;
}

/** Decides where an entry's source can be opened, after the store read. */
export type LedgerSourceAvailabilityOverride = (
  request: LedgerSourceAvailabilityRequest,
) => LedgerSourceAvailability | Promise<LedgerSourceAvailability>;

/**
 * What the host knows about a scope's sync beyond the store's facts (LD02):
 * whether its unsent revisions may go anywhere now, and whether a change of
 * who may read it has reached the mirror.
 */
export interface LedgerSyncStatusSource {
  /** Why the scope's unsent revisions are not on their way; null when they are. */
  hold(scope: LedgerBoundScope): Promise<LedgerSyncHold | null>;
  /** A change of who may read the scope has not reached the mirror yet. */
  audienceChangePending(scope: LedgerBoundScope): Promise<boolean>;
}

/**
 * A revision's sync state as reported: the store's fact, unless the scope
 * does not sync right now, which its unsent revisions then show instead.
 */
function withSyncHold(
  stored: LedgerSyncState,
  hold: LedgerSyncHold | null,
): LedgerSyncState {
  return hold !== null && (stored === 'pending' || stored === 'repair_needed')
    ? hold
    : stored;
}

export type LedgerCallerBindingResolver = Pick<
  LedgerCallerBindingRegistry,
  'resolve'
>;

export interface LedgerServiceOptions {
  /** The store client. Called only once an operation reaches storage. */
  readonly store: () => LedgerStoreClient;
  /** `canopy-ledger-enabled`; checked first on every call. */
  readonly isEnabled: () => boolean;
  /** Signed-in account recorded when a ledger is minted. */
  readonly getAccountId: () => string | null | Promise<string | null>;
  /**
   * The account a global (workflow) Ledger belongs to; throws when it cannot
   * be read. Defaults to `getAccountId`.
   */
  readonly getGlobalAccountId?: () => Promise<string | null>;
  readonly liveChats: LedgerChatLivenessSource;
  /** Retained managed delegates offered as owners; none when omitted. */
  readonly liveDelegates?: LedgerDelegateLivenessSource;
  /** Paused pipeline agents offered as owners; none when omitted. */
  readonly pipelineAgents?: LedgerPipelineAgentSource;
  /** Defaults to the app's registry. */
  readonly callerBindings?: LedgerCallerBindingResolver;
  /** Defaults to the app's eligibility state. */
  readonly eligibility?: LedgerOwnerEligibility;
  /** Defaults to keeping the store's value. */
  readonly resolveSourceAvailability?: LedgerSourceAvailabilityOverride;
  /**
   * Sync facts the store does not keep. Without it, results report the
   * store's sync states and no scope sync.
   */
  readonly syncStatus?: LedgerSyncStatusSource;
  /**
   * Told about every command that changed an entry, after it committed. A
   * throwing listener never fails the command.
   */
  readonly onEntryChanged?: (change: LedgerEntryChange) => void;
  /** Defaults to `redactSecrets`. */
  readonly redact?: (text: string) => string;
  /** Epoch-millisecond clock for owner cursors. */
  readonly now?: () => number;
}

let pendingTitleScheduler:
  | ((record: LedgerPendingTitleRecord) => void)
  | undefined;

/** Connects committed local adds to the desktop's durable title queue. */
export function setLedgerPendingTitleScheduler(
  schedule: ((record: LedgerPendingTitleRecord) => void) | undefined,
): void {
  pendingTitleScheduler = schedule;
}

/** Reads the durable marker only for an add that requested a provisional title. */
export async function schedulePendingTitleFromStore(
  store: {
    listPendingTitles(): Promise<LedgerPendingTitleRecord[]>;
  },
  ledgerId: string,
  entryId: string,
  requestedTitle: string | undefined,
): Promise<void> {
  const schedule = pendingTitleScheduler;
  if (requestedTitle !== undefined || schedule === undefined) return;
  try {
    const records = await store.listPendingTitles();
    const pending = records.find(
      (record) => record.ledgerId === ledgerId && record.entryId === entryId,
    );
    if (pending !== undefined) schedule(pending);
  } catch {
    // The committed marker remains eligible for the startup or periodic sweep.
  }
}

/** The actor kind each caller role must be bound to. */
const ROLE_ACTOR_KIND: {
  readonly [Role in LedgerCallerRole]: LedgerActorKind;
} = {
  user: 'user',
  interactive_chat: 'chat',
  pipeline_agent: 'pipeline_agent',
  managed_delegation: 'managed_delegation',
  summary_publisher: 'background',
};

/** A Summary publisher may only publish; every other role may do the rest. */
function roleMayUse(
  role: LedgerCallerRole,
  operation: LedgerOperation,
): boolean {
  const publishing = operation === 'core.ledger.summary.publish';
  return role === 'summary_publisher' ? publishing : !publishing;
}

interface LedgerResolvedCaller {
  readonly binding: LedgerCallerBinding;
  readonly scope: LedgerBoundScope;
  /** The caller's effective actor; the local user for the user role. */
  readonly actor: LedgerActorRef;
}

type OwnerCommit<Result> = (
  owner: LedgerActorRef,
  ownerEligible: boolean,
) => Promise<Result>;

function resolveActorFilter(
  filter: LedgerActorFilter | undefined,
  self: LedgerActorRef,
): string | undefined {
  if (filter === undefined) return undefined;
  return filter === 'self' ? self.actorId : filter.actorId;
}

function boundScopeFromRecord(scope: LedgerScopeRecord): LedgerBoundScope {
  return {
    ledgerId: scope.scope.ledgerId,
    authorityId: scope.scope.authorityId,
    container: scope.scope.container,
    containerCreatedAt: scope.containerCreatedAt,
    accountId: scope.accountId,
  };
}

/** Every actor an entry and its history page name, in reading order. */
function entryActorIds(
  entry: LedgerEntry,
  mutations: readonly LedgerMutation[],
): string[] {
  const ids = [
    entry.author.actorId,
    entry.owner.actorId,
    entry.attribution.recordedBy.actorId,
  ];
  for (const mutation of mutations) {
    ids.push(
      mutation.attribution.effectiveActor.actorId,
      mutation.attribution.recordedBy.actorId,
    );
    if (mutation.owner !== undefined) {
      if (mutation.owner.from !== null) ids.push(mutation.owner.from.actorId);
      ids.push(mutation.owner.to.actorId);
    }
  }
  return ids;
}

function keepStoredAvailability(
  request: LedgerSourceAvailabilityRequest,
): LedgerSourceAvailability {
  return request.stored;
}

export class LedgerCoreService implements LedgerService {
  readonly scopes: LedgerScopeBindings;
  readonly actors: LedgerActorDirectory;
  private readonly options: LedgerServiceOptions;
  private readonly callerBindings: LedgerCallerBindingResolver;
  private readonly redact: (text: string) => string;
  private readonly resolveSourceAvailability: LedgerSourceAvailabilityOverride;

  /** Construction only records dependencies; nothing touches storage. */
  constructor(options: LedgerServiceOptions) {
    this.options = options;
    this.callerBindings =
      options.callerBindings ?? getLedgerCallerBindingRegistry();
    this.redact = options.redact ?? redactSecrets;
    this.resolveSourceAvailability =
      options.resolveSourceAvailability ?? keepStoredAvailability;
    this.scopes = new LedgerScopeBindings({
      store: options.store,
      getAccountId: options.getAccountId,
      ...(options.getGlobalAccountId === undefined
        ? {}
        : { getGlobalAccountId: options.getGlobalAccountId }),
    });
    this.actors = new LedgerActorDirectory({
      store: options.store,
      liveChats: options.liveChats,
      liveDelegates: options.liveDelegates,
      pipelineAgents: options.pipelineAgents,
      eligibility: options.eligibility,
      now: options.now,
    });
  }

  searchEntries(
    params: LedgerEntriesSearchParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerEntriesSearchResult> {
    const site: LedgerErrorSite = {
      operation: 'core.ledger.entries.search',
      mode: 'query',
    };
    return this.run(site, context, async (caller) => {
      const { scope, actor } = caller;
      const sync = this.scopeSync(scope);
      let ownerIn: readonly string[] | undefined;
      if (params.ownerDelegationId !== undefined) {
        ownerIn = await this.actors.managedDelegationActorIds(scope, [
          params.ownerDelegationId,
        ]);
      }
      if (params.updatableByCaller === true) {
        const updatableOwnerIds = await this.updatableOwnerActorIds(caller);
        if (updatableOwnerIds !== undefined) {
          ownerIn =
            ownerIn === undefined
              ? updatableOwnerIds
              : ownerIn.filter((actorId) =>
                  updatableOwnerIds.includes(actorId),
                );
        }
      }
      // Without rootOnly, what anyone on the chat's line owns matches too.
      const rootChat = params.rootChat;
      const rootChatOwnerIn =
        rootChat?.chatId === undefined || rootChat.rootOnly
          ? undefined
          : await this.actors.rootChatActorIds(scope, rootChat.chatId);
      const result = await this.options.store().searchEntries({
        ledgerId: scope.ledgerId,
        query: params.query,
        entryIds: params.entryIds,
        ...(ownerIn === undefined ? {} : { ownerIn }),
        ...(params.updatableByCaller === true ? { openOnly: true } : {}),
        ownerActorId: resolveActorFilter(params.owner, actor),
        authorActorId: resolveActorFilter(params.author, actor),
        ...(params.parentEntryId === undefined
          ? {}
          : { parentEntryId: params.parentEntryId }),
        ...(params.rootEntryId === undefined
          ? {}
          : { rootEntryId: params.rootEntryId }),
        ...(params.authorIn === undefined ? {} : { authorIn: params.authorIn }),
        ...(params.sourceKinds === undefined
          ? {}
          : { sourceKinds: params.sourceKinds }),
        ...(rootChat === undefined ? {} : { rootChat }),
        ...(rootChatOwnerIn === undefined ? {} : { rootChatOwnerIn }),
        types: params.types,
        statuses: params.statuses,
        attribution: params.attribution,
        createdAfter: params.createdAfter,
        createdBefore: params.createdBefore,
        updatedAfter: params.updatedAfter,
        updatedBefore: params.updatedBefore,
        sort: params.sort,
        limit: params.limit,
        cursor: params.cursor,
      });
      const { hold, audienceChangePending } = await sync;
      const page = {};
      const entries = await Promise.all(
        result.entries.map(
          async (item, index): Promise<LedgerEntrySearchItem> => {
            const origin = result.origins[index];
            const sourceKind =
              origin === undefined
                ? undefined
                : ledgerSourceKindOfOrigin(origin);
            return {
              ...item,
              ...(item.syncState === undefined
                ? {}
                : { syncState: withSyncHold(item.syncState, hold) }),
              sourceAvailability:
                origin === undefined
                  ? item.sourceAvailability
                  : await this.resolveSourceAvailability({
                      scope,
                      subject: { kind: 'search_item', item, origin },
                      stored: item.sourceAvailability,
                      page,
                    }),
              ...(sourceKind === undefined ? {} : { sourceKind }),
            };
          },
        ),
      );
      const owners =
        params.includeAssignableOwners === true
          ? await this.ownersPage(
              caller,
              { cursor: params.ownersCursor },
              'ownersCursor',
              site,
            )
          : undefined;
      const actors = await this.actors.labelsFor(
        scope,
        entries.flatMap((item): string[] => [
          item.author.actorId,
          item.owner.actorId,
        ]),
      );
      return {
        entries,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
        watermark: result.watermark,
        ...(owners === undefined ? {} : { owners }),
        actors,
        ...(this.options.syncStatus === undefined
          ? {}
          : { scopeSync: { audienceChangePending } }),
      };
    });
  }

  getEntry(
    params: LedgerEntryGetParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerEntryGetResult> {
    const site: LedgerErrorSite = {
      operation: 'core.ledger.entry.get',
      mode: 'query',
    };
    return this.run(site, context, async ({ scope }) => {
      const hold = this.syncHold(scope);
      const result = await this.options.store().getEntry({
        ledgerId: scope.ledgerId,
        entryId: params.entryId,
        includeHistory: params.includeHistory,
        historyLimit: params.historyLimit,
        historyCursor: params.historyCursor,
      });
      const syncState =
        result.syncState === undefined
          ? undefined
          : withSyncHold(result.syncState, await hold);
      const actors = await this.actors.labelsFor(
        scope,
        entryActorIds(result.entry, result.history?.mutations ?? []),
      );
      return {
        entry: result.entry,
        sourceAvailability: await this.resolveSourceAvailability({
          scope,
          subject: { kind: 'entry', entry: result.entry },
          stored: result.sourceAvailability,
          page: {},
        }),
        history: result.history,
        actors,
        ...(result.titlePending === true ? { titlePending: true } : {}),
        ...(syncState === undefined ? {} : { syncState }),
      };
    });
  }

  listOwners(
    params: LedgerOwnersListParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerOwnersListResult> {
    const site: LedgerErrorSite = {
      operation: 'core.ledger.owners.list',
      mode: 'query',
    };
    return this.run(site, context, (caller) =>
      this.ownersPage(
        caller,
        {
          limit: params.limit,
          cursor: params.cursor,
          ...(params.delegationId === undefined
            ? {}
            : { delegationId: params.delegationId }),
        },
        'cursor',
        site,
      ),
    );
  }

  getWorkSummary(
    params: LedgerWorkSummaryGetParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerWorkSummaryGetResult> {
    const site: LedgerErrorSite = {
      operation: 'core.ledger.workSummary.get',
      mode: 'query',
    };
    return this.run(site, context, async (caller) => {
      const delegationIds = await readLedgerDelegateLineage(
        caller.scope.container,
        {
          kind: 'managed_delegation',
          delegationId: params.delegationId,
        },
      );
      const actorIds = await this.actors.managedDelegationActorIds(
        caller.scope,
        delegationIds === null
          ? [params.delegationId]
          : [params.delegationId, ...delegationIds],
      );
      return this.options.store().getWorkSummary({
        ledgerId: caller.scope.ledgerId,
        actorIds,
      });
    });
  }

  listChanges(
    params: LedgerChangesListParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerChangesListResult> {
    const site: LedgerErrorSite = {
      operation: 'core.ledger.changes.list',
      mode: 'query',
    };
    return this.run(site, context, ({ scope }) =>
      this.options.store().listChanges({
        ledgerId: scope.ledgerId,
        afterSequence: params.afterSequence,
        limit: params.limit,
      }),
    );
  }

  async listRollups(
    params: LedgerRollupsListParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerRollupsListResult> {
    const site: LedgerErrorSite = {
      operation: 'core.ledger.rollups.list',
      mode: 'query',
    };
    if (!this.isEnabled()) throw ledgerDisabledError(site);
    const binding = this.resolveBinding(context, site);
    try {
      const accountId = await this.options.getAccountId();
      const store = this.options.store();
      // Authorize every scope before resolving any per-scope actor. In
      // particular, a denied second ID cannot partially prepare the query.
      const records = await Promise.all(
        params.ledgerIds.map((ledgerId) => store.getScope(ledgerId)),
      );
      if (
        records.some(
          (record, index) =>
            record === null ||
            record.scope.ledgerId !== params.ledgerIds[index] ||
            record.lifecycleState !== 'active' ||
            record.accountId !== accountId,
        )
      ) {
        throw ledgerOperationError('NOT_FOUND', site, {
          field: 'ledgerIds',
        });
      }
      const scopes = await Promise.all(
        records.map(async (record) => {
          // The previous all-ID check narrows null and inactive scopes.
          if (record === null || record.lifecycleState !== 'active') {
            throw ledgerOperationError('NOT_FOUND', site, {
              field: 'ledgerIds',
            });
          }
          const user = await this.actors.findCaller(
            boundScopeFromRecord(record),
            binding.actor,
          );
          // A scope can be bound before the person's actor registers in it;
          // then nothing there is owned by the caller, but it still rolls up.
          if (user === null) {
            return { ledgerId: record.scope.ledgerId, callerActorId: null };
          }
          if (user.actor.kind !== 'user') {
            throw ledgerOperationError('NOT_FOUND', site, {
              field: 'ledgerIds',
            });
          }
          return {
            ledgerId: record.scope.ledgerId,
            callerActorId: user.actor.actorId,
          };
        }),
      );
      const result = await store.listRollups({
        scopes,
        ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
      });
      if ((await this.options.getAccountId()) !== accountId) {
        throw ledgerOperationError('NOT_FOUND', site, {
          field: 'ledgerIds',
        });
      }
      return result;
    } catch (error) {
      throw toLedgerOperationError(error, site);
    }
  }

  addEntry(
    params: LedgerEntryAddParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerEntryAddResult> {
    const site: LedgerErrorSite = {
      operation: 'core.ledger.entry.add',
      mode: 'command',
    };
    return this.run(site, context, async (caller) => {
      const { _meta: requestMeta, ...entry } = params;
      const idempotencyKey = requireIdempotencyKey(context, site, requestMeta);
      const authorDetails = this.authorDetails(caller, site);
      const origin = await this.origin(caller, site);
      const secrets = caller.binding.secretValues ?? [];
      const redacted: LedgerAddEntryParams = {
        ...entry,
        ...(entry.title === undefined
          ? {}
          : { title: this.redactField(entry.title, 'title', site, secrets) }),
        content: this.redactField(entry.content, 'content', site, secrets),
        ...(entry.highlights === undefined
          ? {}
          : {
              highlights: this.redactHighlights(
                entry.highlights,
                site,
                secrets,
              ),
            }),
        ...(entry.referenceFiles === undefined
          ? {}
          : {
              referenceFiles: this.redactFileRefs(
                entry.referenceFiles,
                site,
                secrets,
              ),
            }),
      };
      const commit: OwnerCommit<LedgerStoreCommandReceipt> = (
        owner,
        ownerEligible,
      ) =>
        this.options.store().addEntry({
          ledgerId: caller.scope.ledgerId,
          author: caller.actor,
          authorDetails,
          origin,
          attribution: attributionFor(caller, authorDetails),
          owner,
          ownerEligible,
          params: redacted,
          idempotencyKey,
        });
      const target = entry.owner;
      const receipt =
        target === undefined || target === 'self'
          ? await commit(caller.actor, true)
          : await this.withEligibleOwner(caller, target, site, commit);
      const result = this.committed(
        caller.scope,
        await this.held(caller, receipt),
      );
      if (receipt.changed && entry.title === undefined) {
        try {
          void schedulePendingTitleFromStore(
            this.options.store(),
            caller.scope.ledgerId,
            receipt.entry.entryId,
            entry.title,
          );
        } catch {
          // The committed marker remains eligible for the startup sweep.
        }
      }
      return result;
    });
  }

  updateEntry(
    params: LedgerEntryUpdateParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerEntryUpdateResult> {
    const site: LedgerErrorSite = {
      operation: 'core.ledger.entry.update',
      mode: 'command',
    };
    return this.run(site, context, async (caller) => {
      const { _meta: requestMeta, ...update } = params;
      const idempotencyKey = requireIdempotencyKey(context, site, requestMeta);
      const authorDetails = this.authorDetails(caller, site);
      const invocationOrigin = await this.origin(caller, site);
      const delegateOwnerActorIds = await this.delegateOwnerActorIds(caller);
      const commit = (
        newOwner: LedgerActorRef | null,
        ownerEligible: boolean,
      ): Promise<LedgerStoreCommandReceipt> =>
        this.options.store().updateEntry({
          ledgerId: caller.scope.ledgerId,
          attribution: attributionFor(caller, authorDetails),
          invocationOrigin,
          params: update,
          newOwner,
          ownerEligible,
          // Only the user may change entries regardless of their current owner.
          mayUpdateAnyOpenEntry: caller.binding.role === 'user',
          ...(delegateOwnerActorIds === undefined
            ? {}
            : { delegateOwnerActorIds }),
          idempotencyKey,
        });
      const target = update.owner;
      const receipt =
        target === undefined
          ? await commit(null, true)
          : target === 'self'
            ? await commit(caller.actor, true)
            : await this.withEligibleOwner(caller, target, site, commit);
      return this.committed(caller.scope, await this.held(caller, receipt));
    });
  }

  private async delegateOwnerActorIds(
    caller: LedgerResolvedCaller,
  ): Promise<readonly string[] | undefined> {
    const owner = delegateLineageOwnerForCaller(caller.binding);
    if (owner === undefined) return undefined;
    const delegationIds = await readLedgerDelegateLineage(
      caller.scope.container,
      owner,
    );
    if (delegationIds === null) return undefined;
    try {
      return await this.actors.managedDelegationActorIds(
        caller.scope,
        delegationIds,
      );
    } catch {
      // A partial or failed actor map must never widen update authority.
      return undefined;
    }
  }

  /** Current owners the caller could update; undefined means any open owner. */
  private async updatableOwnerActorIds(
    caller: LedgerResolvedCaller,
  ): Promise<readonly string[] | undefined> {
    switch (caller.binding.role) {
      case 'user':
        return undefined;
      case 'interactive_chat':
      case 'managed_delegation': {
        const descendantActorIds = await this.delegateOwnerActorIds(caller);
        return [caller.actor.actorId, ...(descendantActorIds ?? [])];
      }
      case 'pipeline_agent':
        return [caller.actor.actorId];
      case 'summary_publisher':
        return [];
    }
  }

  publishSummary(
    params: LedgerSummaryPublishParams,
    context: CanopyHandlerContext,
  ): Promise<LedgerSummaryPublishResult> {
    const site: LedgerErrorSite = {
      operation: 'core.ledger.summary.publish',
      mode: 'command',
    };
    return this.run(site, context, async (caller) => {
      const { _meta: requestMeta, ...publication } = params;
      const idempotencyKey = requireIdempotencyKey(context, site, requestMeta);
      const helperDetails = this.authorDetails(caller, site);
      const redacted: LedgerPublishSummaryParams = {
        ...publication,
        title: this.redactField(publication.title, 'title', site),
        content: this.redactField(publication.content, 'content', site),
        ...(publication.highlights === undefined
          ? {}
          : {
              highlights: this.redactHighlights(publication.highlights, site),
            }),
      };
      const receipt = await this.options.store().publishSummary({
        ledgerId: caller.scope.ledgerId,
        helper: caller.actor,
        helperDetails,
        params: redacted,
        idempotencyKey,
      });
      return this.committed(caller.scope, await this.held(caller, receipt));
    });
  }

  /** Why the scope does not sync right now; null when it does or unknown. */
  private async syncHold(
    scope: LedgerBoundScope,
  ): Promise<LedgerSyncHold | null> {
    const source = this.options.syncStatus;
    if (source === undefined) return null;
    try {
      return await source.hold(scope);
    } catch {
      // The store's facts stand.
      return null;
    }
  }

  private async scopeSync(scope: LedgerBoundScope): Promise<{
    readonly hold: LedgerSyncHold | null;
    readonly audienceChangePending: boolean;
  }> {
    const source = this.options.syncStatus;
    const [hold, audienceChangePending] = await Promise.all([
      this.syncHold(scope),
      source === undefined
        ? Promise.resolve(false)
        : source.audienceChangePending(scope).catch((): boolean => false),
    ]);
    return { hold, audienceChangePending };
  }

  /** A receipt with the scope's hold applied to its sync state. */
  private async held<Receipt extends LedgerCommandReceipt>(
    caller: LedgerResolvedCaller,
    receipt: Receipt,
  ): Promise<Receipt> {
    const hold = await this.syncHold(caller.scope);
    const syncState = withSyncHold(receipt.syncState, hold);
    return syncState === receipt.syncState
      ? receipt
      : { ...receipt, syncState };
  }

  /**
   * Reports a command that changed an entry to the change listener, in the
   * scope's current container, followed by every other entry the command
   * revised (close cascades and operation auto-start). Returns the protocol
   * receipt, without the store-internal `relatedChanges`.
   */
  private committed(
    scope: LedgerBoundScope,
    receipt: LedgerStoreCommandReceipt,
  ): LedgerCommandReceipt {
    const { relatedChanges, ...protocolReceipt } = receipt;
    const changes: LedgerRelatedEntryChange[] = receipt.changed
      ? [
          {
            entryId: receipt.entry.entryId,
            revision: receipt.entry.revision,
          },
        ]
      : [];
    changes.push(...(relatedChanges ?? []));
    for (const change of changes) {
      try {
        this.options.onEntryChanged?.({
          container: scope.container,
          ledgerId: scope.ledgerId,
          entryId: change.entryId,
          revision: change.revision,
        });
      } catch {
        // The command has committed; a listener cannot undo it.
      }
    }
    return protocolReceipt;
  }

  /**
   * Gates on the flag, resolves the caller binding and its scope and actor,
   * then runs the operation, mapping every failure into the core envelope.
   */
  private async run<Result>(
    site: LedgerErrorSite,
    context: CanopyHandlerContext,
    body: (caller: LedgerResolvedCaller) => Promise<Result>,
  ): Promise<Result> {
    if (!this.isEnabled()) throw ledgerDisabledError(site);
    const binding = this.resolveBinding(context, site);
    let ledgerId: string | undefined;
    try {
      const caller = await this.resolveCaller(binding, site);
      ledgerId = caller.scope.ledgerId;
      return await body(caller);
    } catch (error) {
      throw toLedgerOperationError(error, { ...site, ledgerId });
    }
  }

  /**
   * Binds the caller's scope and actor, registering each on first use. A
   * database a newer build wrote opens read-only and refuses both; a query
   * then reads with the scope and actor it already holds, so a downgrade
   * keeps the Ledger readable. Writes still fail `UNSUPPORTED_SCHEMA`.
   */
  private async resolveCaller(
    binding: LedgerCallerBinding,
    site: LedgerErrorSite,
  ): Promise<LedgerResolvedCaller> {
    try {
      const scope = await this.scopes.resolve(
        binding.container,
        binding.containerCreatedAt,
      );
      await this.assertGlobalAccount(scope, site);
      const record = await this.actors.ensureCaller(scope, binding.actor);
      return { binding, scope, actor: record.actor };
    } catch (error) {
      if (
        site.mode !== 'query' ||
        !(error instanceof LedgerStorageHostError) ||
        error.reason !== 'UNSUPPORTED_SCHEMA'
      ) {
        throw error;
      }
      const scope = await this.scopes.find(
        binding.container,
        binding.containerCreatedAt,
      );
      const record =
        scope === null
          ? null
          : await this.actors.findCaller(scope, binding.actor);
      if (scope === null || record === null) throw error;
      await this.assertGlobalAccount(scope, site);
      return { binding, scope, actor: record.actor };
    }
  }

  /**
   * A global (workflow) Ledger serves only the account it was bound under,
   * or the signed-out one while signed out: after an account switch, a
   * binding opened before it fails closed rather than writing to, or
   * reading, another account's Ledger.
   */
  private async assertGlobalAccount(
    scope: LedgerBoundScope,
    site: LedgerErrorSite,
  ): Promise<void> {
    if (scope.container.kind !== 'global') return;
    // An account that cannot be read is no account's: it fails closed.
    const accountId = await this.scopes
      .readGlobalAccountId()
      .catch((): undefined => undefined);
    if (scope.accountId !== accountId) {
      throw ledgerOperationError('FORBIDDEN', site, { field: 'ledgerId' });
    }
  }

  private isEnabled(): boolean {
    try {
      return this.options.isEnabled();
    } catch {
      return false;
    }
  }

  /**
   * Unknown, revoked and expired bindings are forbidden, as is a role outside
   * its operations or bound to the wrong kind of actor.
   */
  private resolveBinding(
    context: CanopyHandlerContext,
    site: LedgerErrorSite,
  ): LedgerCallerBinding {
    const binding = this.callerBindings.resolve(context.caller.principalId);
    if (
      binding === undefined ||
      !roleMayUse(binding.role, site.operation) ||
      binding.actor.kind !== ROLE_ACTOR_KIND[binding.role] ||
      (site.operation === 'core.ledger.rollups.list' &&
        (binding.role !== 'user' ||
          context.caller.interfaceKind !== 'desktop' ||
          context.caller.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID))
    ) {
      throw ledgerOperationError('FORBIDDEN', site);
    }
    return binding;
  }

  private ownersPage(
    caller: LedgerResolvedCaller,
    request: {
      readonly limit?: number;
      readonly cursor?: string;
      readonly delegationId?: string;
    },
    cursorField: string,
    site: LedgerErrorSite,
  ): Promise<LedgerOwnerCandidatePage> {
    const delegateOwner = delegateLineageOwnerForCaller(caller.binding);
    return this.actors
      .pageOwnerCandidates(caller.scope, {
        callerActorId: caller.actor.actorId,
        ...(delegateOwner === undefined ? {} : { delegateOwner }),
        ...(request.delegationId === undefined
          ? {}
          : { delegationId: request.delegationId }),
        limit: request.limit,
        cursor: request.cursor,
      })
      .then((result): LedgerOwnerCandidatePage => {
        if (result.kind === 'cursor_expired') {
          throw ledgerOperationError('CURSOR_EXPIRED', site, {
            field: cursorField,
          });
        }
        return result.page;
      });
  }

  /**
   * Resolves an explicit owner in the caller's own ledger and checks its
   * eligibility token under the ledger's admission fence, holding the fence
   * through the commit. A paused pipeline agent's execution fence is held as
   * well, so the execution cannot resume or be cancelled in between. The
   * store applies the verdict only after its receipt lookup, so an exact
   * replay still returns its receipt once the token has gone stale.
   */
  private withEligibleOwner<Result>(
    caller: LedgerResolvedCaller,
    target: { readonly actorId: string; readonly eligibilityToken: string },
    site: LedgerErrorSite,
    commit: OwnerCommit<Result>,
  ): Promise<Result> {
    const { scope } = caller;
    return this.actors.withOwnerAdmission(scope.ledgerId, async () => {
      const owner = await this.actors.findActor(scope, target.actorId);
      if (owner === null) {
        // Not an actor of this ledger, so never an accepted owner here.
        throw ledgerOperationError('OWNER_UNAVAILABLE', site, {
          field: 'owner',
        });
      }
      return this.actors.withOwnerLifecycleAdmission(owner, async () => {
        const eligible = await this.actors.verifyOwnerEligibility(
          scope,
          owner,
          target.eligibilityToken,
          delegateLineageOwnerForCaller(caller.binding),
        );
        return commit(owner.actor, eligible);
      });
    });
  }

  /** The binding's author details; a malformed snapshot cannot write. */
  private authorDetails(
    caller: LedgerResolvedCaller,
    site: LedgerErrorSite,
  ): LedgerAuthorDetails {
    const parsed = LedgerAuthorDetailsSchema.safeParse(
      caller.binding.authorDetails,
    );
    if (!parsed.success) {
      throw ledgerOperationError('FORBIDDEN', site, { field: 'authorDetails' });
    }
    return parsed.data;
  }

  /** The caller's origin; a binding that cannot supply one cannot write. */
  private async origin(
    caller: LedgerResolvedCaller,
    site: LedgerErrorSite,
  ): Promise<LedgerOrigin> {
    const parsed = LedgerOriginSchema.safeParse(
      await this.callerOrigin(caller),
    );
    if (!parsed.success) {
      throw ledgerOperationError('FORBIDDEN', site, { field: 'origin' });
    }
    return parsed.data;
  }

  /**
   * Where a call comes from: the user or the chat from the binding itself, or
   * the pipeline attempt or delegate lineage the host registered with it. A
   * delegate's parent arrives as a host key and is resolved to its actor in
   * this ledger; undefined for a binding that cannot supply an origin.
   */
  private async callerOrigin(
    caller: LedgerResolvedCaller,
  ): Promise<LedgerOrigin | undefined> {
    const { binding, scope, actor } = caller;
    switch (binding.role) {
      case 'user':
        return {
          kind: 'user',
          ledgerId: scope.ledgerId,
          userActorId: actor.actorId,
        };
      case 'interactive_chat':
        return {
          kind: 'chat',
          ledgerId: scope.ledgerId,
          chatId: binding.actor.originKey,
        };
      case 'pipeline_agent': {
        const hostOrigin = binding.origin;
        // The attempt must be the binding's own agent session, and a retry
        // cannot name itself as its predecessor.
        return hostOrigin?.kind === 'pipeline_agent' &&
          hostOrigin.agentSessionId === binding.actor.originKey &&
          hostOrigin.predecessorAgentSessionId !== hostOrigin.agentSessionId
          ? { ...hostOrigin, ledgerId: scope.ledgerId }
          : undefined;
      }
      case 'managed_delegation': {
        const hostOrigin = binding.origin;
        if (
          hostOrigin?.kind !== 'managed_delegation' ||
          !isConsistentDelegateLineage(binding, hostOrigin)
        ) {
          return undefined;
        }
        const { parent, ...lineage } = hostOrigin;
        const parentActor = await this.actors.ensureHostActor(scope, parent);
        return {
          ...lineage,
          ledgerId: scope.ledgerId,
          parentActorId: parentActor.actor.actorId,
        };
      }
      case 'summary_publisher':
        return undefined;
    }
  }

  private redactField(
    value: string,
    field: 'title' | 'content',
    site: LedgerErrorSite,
    secretValues: readonly string[] = [],
  ): string {
    return field === 'title'
      ? this.redactText(
          value,
          LedgerTitleSchema,
          field,
          LEDGER_LIMITS.titleMaxCodePoints,
          site,
          secretValues,
        )
      : this.redactText(
          value,
          LedgerContentSchema,
          field,
          LEDGER_LIMITS.contentMaxCodePoints,
          site,
          secretValues,
        );
  }

  private redactHighlights(
    highlights: readonly string[],
    site: LedgerErrorSite,
    secretValues: readonly string[] = [],
  ): string[] {
    return highlights.map((highlight, index) =>
      this.redactText(
        highlight,
        LedgerHighlightSchema,
        `highlights.${String(index)}`,
        LEDGER_LIMITS.highlightMaxCodePoints,
        site,
        secretValues,
      ),
    );
  }

  /**
   * Masks the caller's configured secret values out of reference files,
   * whose root and path the agent chooses. A reference the masking leaves
   * invalid is refused rather than stored.
   */
  private redactFileRefs(
    refs: readonly LedgerFileRef[],
    site: LedgerErrorSite,
    secretValues: readonly string[],
  ): LedgerFileRef[] {
    if (secretValues.length === 0) return [...refs];
    return refs.map((ref, index): LedgerFileRef => {
      const parsed = LedgerFileRefSchema.safeParse({
        ...ref,
        rootId: redactValues(ref.rootId, secretValues),
        path: redactValues(ref.path, secretValues),
      });
      if (!parsed.success) {
        throw ledgerOperationError('INVALID_INPUT', site, {
          field: `referenceFiles.${String(index)}`,
        });
      }
      return parsed.data;
    });
  }

  /**
   * Redacts secrets and PII (LD02): first the exact values the caller's
   * binding names, such as a pipeline step's configured secrets, whatever
   * their shape, then anything that looks like a secret. A masked value can
   * be longer than the original; rather than truncate silently, the field's
   * limit is reported.
   */
  private redactText(
    value: string,
    schema: ZodType<string>,
    field: string,
    limit: number,
    site: LedgerErrorSite,
    secretValues: readonly string[],
  ): string {
    const masked =
      secretValues.length === 0 ? value : redactValues(value, secretValues);
    const parsed = schema.safeParse(this.redact(masked));
    if (!parsed.success) {
      throw ledgerOperationError('INVALID_INPUT', site, { field, limit });
    }
    return parsed.data;
  }
}

/**
 * A keyed instruction carries its key twice: in the request metadata the
 * dispatcher requires, and in its wire params' `_meta`. Both must agree.
 */
function requireIdempotencyKey(
  context: CanopyHandlerContext,
  site: LedgerErrorSite,
  requestMeta: { readonly idempotencyKey: string },
): string {
  const key = context.metadata.idempotencyKey;
  if (
    key === undefined ||
    key.length === 0 ||
    requestMeta.idempotencyKey !== key
  ) {
    throw ledgerOperationError('INVALID_INPUT', site, {
      field: '_meta.idempotencyKey',
    });
  }
  return key;
}

/**
 * A delegate's lineage must describe the binding it came with: the actor is
 * the delegation itself, the binding's generation is the run generation, and
 * the parent is another actor (a chat, or another delegation). Anything else
 * is a host error, and the delegate cannot write.
 */
function isConsistentDelegateLineage(
  binding: LedgerCallerBinding,
  origin: LedgerCallerDelegationOrigin,
): boolean {
  const { parent } = origin;
  return (
    origin.delegationId === binding.actor.originKey &&
    origin.runGeneration === binding.runtimeGeneration &&
    (parent.kind === 'chat' ||
      (parent.kind === 'managed_delegation' &&
        parent.originKey !== origin.delegationId))
  );
}

/** A chat/delegate caller may offer its own new delegates to owner pickers. */
function delegateLineageOwnerForCaller(
  binding: LedgerCallerBinding,
): LedgerDelegateLineageOwner | undefined {
  switch (binding.role) {
    case 'interactive_chat':
      return binding.actor.kind === 'chat'
        ? { kind: 'chat', chatId: binding.actor.originKey }
        : undefined;
    case 'managed_delegation':
      return binding.actor.kind === 'managed_delegation' &&
        binding.origin?.kind === 'managed_delegation' &&
        isConsistentDelegateLineage(binding, binding.origin)
        ? {
            kind: 'managed_delegation',
            delegationId: binding.actor.originKey,
          }
        : undefined;
    default:
      return undefined;
  }
}

/** Agents self-report; the user's own changes are attributed to the user. */
function attributionFor(
  caller: LedgerResolvedCaller,
  executorDetails: LedgerAuthorDetails,
): LedgerAttribution {
  const actor = caller.actor;
  return caller.binding.role === 'user'
    ? {
        kind: 'user',
        effectiveActor: actor,
        recordedBy: actor,
        executorDetails,
      }
    : {
        kind: 'self_reported',
        effectiveActor: actor,
        recordedBy: actor,
        executorDetails,
      };
}

/**
 * The Ledger service over a store client. Construction is lazy: it opens no
 * database, starts no worker and makes no storage call.
 */
export function createLedgerService(
  options: LedgerServiceOptions,
): LedgerCoreService {
  return new LedgerCoreService(options);
}
