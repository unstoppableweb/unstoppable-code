import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  LEDGER_LIMITS,
  LedgerDisplayNameSchema,
  LedgerOpaqueIdSchema,
  LedgerOwnerPipelineAgentSchema,
  type LedgerActorKind,
  type LedgerActorLabel,
  type LedgerContainer,
  type LedgerOwnerCandidate,
  type LedgerOwnerCandidatePage,
  type LedgerOwnerPipelineAgent,
} from '@canopy/protocol/canopy-core';
import type { LedgerViewActorHost } from '@canopy/protocol/ledger-view';
import { chatDisplayLabel } from '@canopy/desktop-shared/lib/chat-display-label';
import type { LedgerActorRecord } from '@canopy/desktop-shared/node/ledger';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { isRecord } from '../lib/type-guards';
import type { LedgerCallerActor } from './caller-bindings';
import {
  getLedgerCallerBindingRegistry,
  type LedgerCallerBinding,
  type LedgerCallerBindingRegistry,
} from './caller-bindings';
import type {
  LedgerDelegateLineageOwner,
  LedgerDelegateLivenessSource,
  LedgerLiveDelegate,
} from './delegate-owners';
import { readLedgerNewDelegates } from './delegate-owners';
import type { LedgerStoreClient } from './ledger-store-client';
import type {
  LedgerPausedPipelineAgent,
  LedgerPipelineAgentSource,
} from './pipeline-agent-owners';
import { ledgerContainerKey, type LedgerBoundScope } from './scope-bindings';

/*
 * The actor directory registers actors in each ledger (the local user "You",
 * the calling binding's actor and the container's chats) and caches their
 * references. It also owns owner eligibility: who may be assigned, the tokens
 * that prove a picker offered that choice recently, and the admission fence
 * that keeps a token check and its commit together.
 */

/** Store origin key of the local user actor, the same in every ledger. */
export const LEDGER_USER_ACTOR_ORIGIN_KEY = 'user:local';
export const LEDGER_USER_ACTOR_DISPLAY_NAME = 'You';
/** How long an owner eligibility token stays valid. */
export const LEDGER_ELIGIBILITY_TOKEN_LIFETIME_MS = 10 * 60 * 1_000;

const TOKEN_VERSION = 'v1';
const TOKEN_EXPIRY_TEXT = /^[0-9]{1,16}$/;
const REVISION_TEXT = /^(0|[1-9][0-9]{0,15})$/;
const OWNER_CURSOR_VERSION = 1;
const CHAT_ORIGIN_PREFIX = 'chat:';
const DELEGATE_ORIGIN_PREFIX = 'managed_delegation:';
const PIPELINE_AGENT_ORIGIN_PREFIX = 'pipeline_agent:';
/** Mirrors `validateId`: persisted workspace, worktree and entry IDs. */
const SAFE_CONTAINER_ID = /^[a-z0-9][a-z0-9-]*$/;

const DEFAULT_DISPLAY_NAMES: { readonly [Kind in LedgerActorKind]: string } = {
  user: LEDGER_USER_ACTOR_DISPLAY_NAME,
  chat: 'Chat',
  pipeline_agent: 'Workflow agent',
  managed_delegation: 'Delegate',
  background: 'Background task',
  ledger_sidecar: 'Feed sidecar',
};

/**
 * The store origin key of a host actor: `<kind>:<host key>`, so a chat ID and
 * a pipeline session ID can never collide. Every user-kind actor is the one
 * local user, `user:local`.
 */
export function ledgerActorOriginKey(actor: {
  readonly kind: LedgerActorKind;
  readonly originKey: string;
}): string {
  return actor.kind === 'user'
    ? LEDGER_USER_ACTOR_ORIGIN_KEY
    : `${actor.kind}:${actor.originKey}`;
}

function replaceControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    result +=
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? ' '
        : character;
  }
  return result;
}

/** A single-line display name within the Ledger limit, or the fallback. */
export function toLedgerDisplayName(value: string, fallback: string): string {
  const singleLine = replaceControlCharacters(value).replace(/\s+/g, ' ');
  const bounded = Array.from(singleLine.trim())
    .slice(0, LEDGER_LIMITS.displayNameMaxCodePoints)
    .join('')
    .trim();
  return LedgerDisplayNameSchema.safeParse(bounded).success
    ? bounded
    : fallback;
}

/** A nondeleted, nonarchived persisted chat in a container. */
export interface LedgerLiveChat {
  readonly chatId: string;
  /** The chat's name as people see it (see `chatDisplayLabel`); may be empty. */
  readonly title: string;
  /** Orders owner candidates; null when unknown. */
  readonly createdAt: string | null;
  /** Latest persisted message time, absent when the chat has no messages. */
  readonly lastActivityAt?: string;
}

/** Lists a container's live chats, idle ones included. */
export type LedgerChatLivenessSource = (
  container: LedgerContainer,
) => Promise<readonly LedgerLiveChat[]>;

/**
 * The chat-state scope of a container: an entry ID fills the worktree slot.
 * Null for a global (workflow) Ledger, which has no chats.
 */
function chatScopeOf(container: LedgerContainer): {
  projectId: string;
  worktreeId: string;
} | null {
  switch (container.kind) {
    case 'code_worktree':
      return {
        projectId: container.workspaceId,
        worktreeId: container.worktreeId,
      };
    case 'cowork_entry':
      return {
        projectId: container.workspaceId,
        worktreeId: container.entryId,
      };
    case 'advisor_entry':
      return {
        projectId: container.appWorkspaceId,
        worktreeId: container.entryId,
      };
    case 'global':
      return null;
  }
}

/**
 * The container's live chats from canonical chat state. Only metadata is
 * read: no transcript is selected. Archived chats are not live tabs, deleted
 * ones are gone, and file tabs are not chats. Each chat is named as its tab
 * and the archived chat list name it: its generated name before the one it
 * was created with.
 */
export async function readLedgerContainerLiveChats(
  container: LedgerContainer,
): Promise<LedgerLiveChat[]> {
  const chatScope = chatScopeOf(container);
  if (chatScope === null) return [];
  const { projectId, worktreeId } = chatScope;
  if (
    !SAFE_CONTAINER_ID.test(projectId) ||
    !SAFE_CONTAINER_ID.test(worktreeId)
  ) {
    return [];
  }
  const tabs = await readChatTabsFile(projectId, worktreeId);
  return tabs.tabs
    .filter((tab) => tab.kind !== 'file')
    .map((tab): LedgerLiveChat => {
      // Metadata only: the compatibility read may leave `messages` unloaded.
      const lastMessageAt = tab.transcript?.lastMessageAt;
      const lastActivityAt =
        typeof lastMessageAt === 'number' && Number.isFinite(lastMessageAt)
          ? new Date(lastMessageAt).toISOString()
          : undefined;
      return {
        chatId: tab.id,
        // An unnamed chat falls back to the Ledger's default name for chats.
        title: chatDisplayLabel({
          title: tab.title,
          customTitle: tab.customTitle,
          description: tab.description,
          fallback: '',
        }),
        createdAt: typeof tab.createdAt === 'string' ? tab.createdAt : null,
        ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
      };
    });
}

/** Invalidates outstanding owner eligibility tokens. */
export interface LedgerOwnerEligibilityTarget {
  readonly container: LedgerContainer;
  /**
   * One actor, by kind and host key (for a chat, its persisted chat ID). Omit
   * to cover every actor in the container.
   */
  readonly actor?: {
    readonly kind: LedgerActorKind;
    readonly originKey: string;
  };
}

/** What an eligibility token vouches for. */
export interface LedgerEligibilityClaim {
  readonly ledgerId: string;
  readonly actorId: string;
  readonly container: LedgerContainer;
  /** The actor's store origin key. */
  readonly originKey: string;
  /**
   * A managed delegate's run generation when the token was issued, so a
   * token goes stale once the delegate is continued. Absent for other actors.
   */
  readonly runGeneration?: number;
  /**
   * A paused pipeline agent's checkpoint and its execution's lifecycle
   * generation when the token was issued, so a token goes stale once the
   * execution resumes, pauses again or is cancelled. Absent for other actors.
   */
  readonly checkpoint?: LedgerPipelineAgentCheckpoint;
  /** A new delegate token is valid only for the chat/delegate that spawned it. */
  readonly delegateOwner?: LedgerDelegateLineageOwner;
}

/** The checkpoint a paused pipeline agent's eligibility is bound to. */
export interface LedgerPipelineAgentCheckpoint {
  readonly checkpointId: string;
  readonly executionGeneration: number;
}

export interface LedgerOwnerEligibilityOptions {
  /** Epoch-millisecond clock. */
  readonly now?: () => number;
  readonly tokenLifetimeMs?: number;
}

function incrementRevision(revisions: Map<string, number>, key: string): void {
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
}

function actorRevisionKey(containerKey: string, originKey: string): string {
  return JSON.stringify([containerKey, originKey]);
}

function tokenMacInput(
  claim: LedgerEligibilityClaim,
  fields: readonly string[],
): string {
  return [
    'ledger-owner-token',
    claim.ledgerId,
    claim.actorId,
    // The generation rides in the MAC, not the token text: a token issued
    // for one run generation fails against any other.
    ...(claim.runGeneration === undefined
      ? []
      : [`run-generation:${String(claim.runGeneration)}`]),
    // Likewise a paused pipeline agent's checkpoint and execution generation.
    ...(claim.checkpoint === undefined
      ? []
      : [
          `checkpoint:${claim.checkpoint.checkpointId}`,
          `execution-generation:${String(claim.checkpoint.executionGeneration)}`,
        ]),
    ...(claim.delegateOwner === undefined
      ? []
      : [
          claim.delegateOwner.kind === 'chat'
            ? `delegate-owner:chat:${claim.delegateOwner.chatId}`
            : `delegate-owner:managed_delegation:${claim.delegateOwner.delegationId}`,
        ]),
    ...fields,
  ].join('\n');
}

/**
 * In-memory owner eligibility state. Each actor has an eligibility revision,
 * and each container a revision covering all of its actors; lifecycle hooks
 * bump them when a candidate stops being assignable. Tokens are HMACs over the
 * ledger, the actor, both revisions and a short expiry, keyed by a random
 * secret held only in memory, so a restart invalidates every token.
 */
export class LedgerOwnerEligibility {
  private readonly secret: Buffer = randomBytes(32);
  private readonly now: () => number;
  private readonly tokenLifetimeMs: number;
  private readonly containerRevisions = new Map<string, number>();
  private readonly actorRevisions = new Map<string, number>();
  private readonly fences = new Map<string, Promise<void>>();

  constructor(options: LedgerOwnerEligibilityOptions = {}) {
    this.now = options.now ?? ((): number => Date.now());
    this.tokenLifetimeMs =
      options.tokenLifetimeMs ?? LEDGER_ELIGIBILITY_TOKEN_LIFETIME_MS;
  }

  /** Makes every token issued so far for the target fail its check. */
  invalidate(target: LedgerOwnerEligibilityTarget): void {
    const containerKey = ledgerContainerKey(target.container);
    if (target.actor === undefined) {
      incrementRevision(this.containerRevisions, containerKey);
      return;
    }
    incrementRevision(
      this.actorRevisions,
      actorRevisionKey(containerKey, ledgerActorOriginKey(target.actor)),
    );
  }

  issueToken(claim: LedgerEligibilityClaim): string {
    const fields = [
      TOKEN_VERSION,
      String(this.now() + this.tokenLifetimeMs),
      ...this.revisions(claim),
    ];
    return [...fields, this.mac(tokenMacInput(claim, fields))].join('.');
  }

  /**
   * True when the token was issued here for this claim, has not expired and
   * both of its revisions are still current.
   */
  checkToken(claim: LedgerEligibilityClaim, token: string): boolean {
    const parts = token.split('.');
    if (parts.length !== 5) return false;
    const [version, expiresAt, containerRevision, actorRevision, mac] = parts;
    if (
      version !== TOKEN_VERSION ||
      !TOKEN_EXPIRY_TEXT.test(expiresAt) ||
      !REVISION_TEXT.test(containerRevision) ||
      !REVISION_TEXT.test(actorRevision) ||
      !this.macMatches(
        tokenMacInput(claim, [
          version,
          expiresAt,
          containerRevision,
          actorRevision,
        ]),
        mac,
      )
    ) {
      return false;
    }
    if (this.now() >= Number(expiresAt)) return false;
    const [currentContainer, currentActor] = this.revisions(claim);
    return (
      containerRevision === currentContainer && actorRevision === currentActor
    );
  }

  /**
   * Runs `fn` while holding the ledger's owner admission fence. Owner-changing
   * commands hold it from the eligibility check through the commit, and
   * lifecycle hooks take it before changing eligibility, so a check can never
   * pass against a candidate whose eligibility is changing.
   */
  async withAdmission<T>(ledgerId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.fences.get(ledgerId) ?? Promise.resolve();
    let release: () => void = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.fences.set(ledgerId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.fences.get(ledgerId) === tail) this.fences.delete(ledgerId);
    }
  }

  /** HMAC-SHA256 under the in-memory secret, base64url. */
  mac(input: string): string {
    return createHmac('sha256', this.secret).update(input).digest('base64url');
  }

  macMatches(input: string, mac: string): boolean {
    const expected = Buffer.from(this.mac(input), 'utf8');
    const actual = Buffer.from(mac, 'utf8');
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  private revisions(claim: LedgerEligibilityClaim): [string, string] {
    const containerKey = ledgerContainerKey(claim.container);
    return [
      String(this.containerRevisions.get(containerKey) ?? 0),
      String(
        this.actorRevisions.get(
          actorRevisionKey(containerKey, claim.originKey),
        ) ?? 0,
      ),
    ];
  }
}

let defaultEligibility: LedgerOwnerEligibility | undefined;

/** The app's owner eligibility state. */
export function getLedgerOwnerEligibility(): LedgerOwnerEligibility {
  defaultEligibility ??= new LedgerOwnerEligibility();
  return defaultEligibility;
}

/**
 * Called by lifecycle hooks when an owner candidate stops being assignable
 * (a chat archived or deleted, a container archived). Take the ledger's
 * admission fence first when the change can race an owner commit.
 */
export function invalidateLedgerOwnerEligibility(
  target: LedgerOwnerEligibilityTarget,
): void {
  getLedgerOwnerEligibility().invalidate(target);
}

/** Runs `fn` under the ledger's owner admission fence. */
export function withLedgerOwnerAdmission<T>(
  ledgerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return getLedgerOwnerEligibility().withAdmission(ledgerId, fn);
}

/** An assignable owner, with the label and order a picker shows. */
export interface LedgerOwnerCandidateEntry {
  readonly record: LedgerActorRecord;
  /** Current label; the record keeps the snapshot from registration. */
  readonly displayName: string;
  readonly sortKey: LedgerOwnerSortKey;
  /** A managed delegate's current run generation; its token binds it. */
  readonly runGeneration?: number;
  /** A paused pipeline agent's checkpoint; its token binds it. */
  readonly checkpoint?: LedgerPipelineAgentCheckpoint;
  /** New delegates are assignable only by the owner named here. */
  readonly delegateOwner?: LedgerDelegateLineageOwner;
  /** Exactly which pause a paused pipeline agent is, for pickers. */
  readonly pipelineAgent?: LedgerOwnerPipelineAgent;
}

/**
 * `[group, createdAt, id]`: "You" first, then chats, retained delegates and
 * paused pipeline agents, each oldest first.
 */
export type LedgerOwnerSortKey = readonly [number, string, string];

export interface LedgerOwnerPageRequest {
  /** Marks the caller's own candidate with `isSelf`. */
  readonly callerActorId: string;
  /** Offers the caller's own not-yet-retained delegates only. */
  readonly delegateOwner?: LedgerDelegateLineageOwner;
  /** Restricts the page to the caller's exact requested delegate, if eligible. */
  readonly delegationId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export type LedgerOwnerPageResult =
  | { readonly kind: 'page'; readonly page: LedgerOwnerCandidatePage }
  | { readonly kind: 'cursor_expired' };

export interface LedgerActorDirectoryOptions {
  /** The store client. Called only when an actor is first needed. */
  readonly store: () => LedgerStoreClient;
  readonly liveChats: LedgerChatLivenessSource;
  /** Retained managed delegates; none when omitted. */
  readonly liveDelegates?: LedgerDelegateLivenessSource;
  /** Paused pipeline agents; none when omitted. */
  readonly pipelineAgents?: LedgerPipelineAgentSource;
  /** Running pipeline and delegate callers, including non-picker actors. */
  readonly callerBindings?: Pick<LedgerCallerBindingRegistry, 'listForScope'>;
  /** Defaults to the app's eligibility state. */
  readonly eligibility?: LedgerOwnerEligibility;
  /** Epoch-millisecond clock for owner cursors. */
  readonly now?: () => number;
}

/** The scope fields required for read-only actor labels and host resolution. */
export type LedgerActorReadScope = Pick<
  LedgerBoundScope,
  'ledgerId' | 'container' | 'containerCreatedAt'
>;

export interface LedgerActorWorkView {
  readonly actors: readonly LedgerActorLabel[];
  readonly actorHosts: Readonly<Record<string, LedgerViewActorHost>>;
}

function compareSortKeys(
  left: LedgerOwnerSortKey,
  right: LedgerOwnerSortKey,
): number {
  if (left[0] !== right[0]) return left[0] - right[0];
  if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
  if (left[2] !== right[2]) return left[2] < right[2] ? -1 : 1;
  return 0;
}

function actorCacheKey(ledgerId: string, key: string): string {
  return `${ledgerId}\u0000${key}`;
}

/** Plain, frozen copy of a record that crossed the storage worker boundary. */
function copyActorRecord(record: LedgerActorRecord): LedgerActorRecord {
  return Object.freeze({
    actor: Object.freeze({
      actorId: record.actor.actorId,
      kind: record.actor.kind,
      authorityId: record.actor.authorityId,
    }),
    ledgerId: record.ledgerId,
    originKey: record.originKey,
    displayName: record.displayName,
    createdAt: record.createdAt,
  });
}

function uniqueLiveChats(chats: readonly LedgerLiveChat[]): LedgerLiveChat[] {
  const seen = new Set<string>();
  return chats.filter((chat) => {
    if (
      seen.has(chat.chatId) ||
      !LedgerOpaqueIdSchema.safeParse(chat.chatId).success
    ) {
      return false;
    }
    seen.add(chat.chatId);
    return true;
  });
}

/**
 * A delegate actor's delegation and the chat its tree started from, from its
 * live binding or else this device's delegation records; null when neither
 * knows it.
 */
function delegateLineage(
  record: LedgerActorRecord,
  bindings: readonly LedgerCallerBinding[],
  delegates: readonly LedgerLiveDelegate[],
): {
  readonly delegationId: string;
  readonly rootChatId: string | null;
} | null {
  if (!record.originKey.startsWith(DELEGATE_ORIGIN_PREFIX)) return null;
  const bindingOrigin = latestBindingForActor(
    bindings,
    record,
    'managed_delegation',
  )?.origin;
  if (bindingOrigin?.kind === 'managed_delegation') {
    return {
      delegationId: record.originKey.slice(DELEGATE_ORIGIN_PREFIX.length),
      rootChatId:
        bindingOrigin.root.kind === 'chat' ? bindingOrigin.root.chatId : null,
    };
  }
  const delegate = delegates.find(
    (candidate) =>
      ledgerActorOriginKey({
        kind: 'managed_delegation',
        originKey: candidate.delegationId,
      }) === record.originKey,
  );
  return delegate === undefined
    ? null
    : { delegationId: delegate.delegationId, rootChatId: delegate.rootChatId };
}

function latestBindingForActor(
  bindings: readonly LedgerCallerBinding[],
  actor: LedgerActorRecord,
  role: LedgerCallerBinding['role'],
): LedgerCallerBinding | undefined {
  let latest: LedgerCallerBinding | undefined;
  for (const binding of bindings) {
    if (
      binding.role !== role ||
      ledgerActorOriginKey(binding.actor) !== actor.originKey ||
      (latest !== undefined && binding.registeredAt <= latest.registeredAt)
    ) {
      continue;
    }
    latest = binding;
  }
  return latest;
}

/**
 * Exactly which pause a paused agent is, as owner pickers show it. A pause
 * time that is not a Ledger timestamp is left out, and a locator the
 * contract would reject is not offered at all rather than failing the page.
 */
function pipelineAgentLocator(agent: LedgerPausedPipelineAgent): {
  readonly pipelineAgent?: LedgerOwnerPipelineAgent;
} {
  const locator = {
    executionId: agent.executionId,
    jobId: agent.jobId,
    stepId: agent.stepId,
    attempt: agent.attempt,
    checkpointId: agent.checkpointId,
  };
  const exact = LedgerOwnerPipelineAgentSchema.safeParse({
    ...locator,
    pausedAt: agent.pausedAt,
  });
  if (exact.success) return { pipelineAgent: exact.data };
  const withoutTime = LedgerOwnerPipelineAgentSchema.safeParse({
    ...locator,
    pausedAt: null,
  });
  return withoutTime.success ? { pipelineAgent: withoutTime.data } : {};
}

/**
 * The delegates that are selectable: well-formed, one row per delegation, and
 * belonging to a live chat of the container (the parent scope).
 */
function selectableDelegates(
  delegates: readonly LedgerLiveDelegate[],
  liveChats: readonly LedgerLiveChat[],
): LedgerLiveDelegate[] {
  const liveChatIds = new Set(liveChats.map((chat) => chat.chatId));
  const seen = new Set<string>();
  return delegates.filter((delegate) => {
    if (
      seen.has(delegate.delegationId) ||
      !LedgerOpaqueIdSchema.safeParse(delegate.delegationId).success ||
      !Number.isSafeInteger(delegate.runGeneration) ||
      delegate.runGeneration < 1 ||
      !liveChatIds.has(delegate.rootChatId)
    ) {
      return false;
    }
    seen.add(delegate.delegationId);
    return true;
  });
}

/**
 * Registers and caches the actors of each ledger, and decides who may own an
 * entry. Registration is idempotent in the store, so concurrent and repeated
 * uses are safe; this cache only saves the round trips. Nothing touches
 * storage until an actor is first needed.
 *
 * Owner candidates are "You" (always selectable, LD04), the container's live
 * chats, idle ones included, the retained managed delegates of those chats
 * that can still accept a continuation, and the pipeline agents paused on a
 * checkpoint their session resumes. A delegate's token binds its run
 * generation and a paused agent's its checkpoint and execution generation,
 * so continuing, resuming, cancelling or releasing makes the token stale.
 */
export class LedgerActorDirectory {
  readonly eligibility: LedgerOwnerEligibility;
  private readonly options: LedgerActorDirectoryOptions;
  private readonly now: () => number;
  private readonly registrations = new Map<
    string,
    Promise<LedgerActorRecord>
  >();
  private readonly byActorId = new Map<string, LedgerActorRecord>();
  constructor(options: LedgerActorDirectoryOptions) {
    this.options = options;
    this.eligibility = options.eligibility ?? getLedgerOwnerEligibility();
    this.now = options.now ?? ((): number => Date.now());
  }

  /** The local user actor ("You") of a ledger. */
  ensureUser(scope: LedgerBoundScope): Promise<LedgerActorRecord> {
    return this.ensureRegistered(
      scope,
      'user',
      LEDGER_USER_ACTOR_ORIGIN_KEY,
      LEDGER_USER_ACTOR_DISPLAY_NAME,
    );
  }

  /**
   * The actor a caller binding speaks for, registering "You" in the ledger
   * as well. A user-kind binding is the local user.
   */
  async ensureCaller(
    scope: LedgerBoundScope,
    actor: Readonly<LedgerCallerActor>,
  ): Promise<LedgerActorRecord> {
    const user = await this.ensureUser(scope);
    if (actor.kind === 'user') return user;
    return this.ensureHostActor(scope, actor);
  }

  /**
   * The actor a caller binding speaks for, when the ledger already holds it,
   * looked up without registering anything: for reads of a database this
   * build may only read. Null when the ledger has no such actor.
   */
  async findCaller(
    scope: LedgerBoundScope,
    actor: Readonly<LedgerCallerActor>,
  ): Promise<LedgerActorRecord | null> {
    const originKey =
      actor.kind === 'user'
        ? LEDGER_USER_ACTOR_ORIGIN_KEY
        : ledgerActorOriginKey(actor);
    const actors = await this.options.store().listActors(scope.ledgerId);
    const found = actors.find(
      (record) =>
        record.originKey === originKey && record.actor.kind === actor.kind,
    );
    return found === undefined ? null : copyActorRecord(found);
  }

  /**
   * A host actor by kind and host key, such as the chat or delegate that
   * spawned a managed delegate, registered under `displayName` on first use.
   * An actor the ledger already knows keeps the name it was registered with.
   */
  ensureHostActor(
    scope: LedgerBoundScope,
    actor: Readonly<LedgerCallerActor>,
  ): Promise<LedgerActorRecord> {
    if (actor.kind === 'user') return this.ensureUser(scope);
    return this.ensureRegistered(
      scope,
      actor.kind,
      ledgerActorOriginKey(actor),
      toLedgerDisplayName(actor.displayName, DEFAULT_DISPLAY_NAMES[actor.kind]),
    );
  }

  /** The actor of a persisted chat. */
  ensureChat(
    scope: LedgerBoundScope,
    chat: LedgerLiveChat,
  ): Promise<LedgerActorRecord> {
    return this.ensureRegistered(
      scope,
      'chat',
      ledgerActorOriginKey({ kind: 'chat', originKey: chat.chatId }),
      toLedgerDisplayName(chat.title, DEFAULT_DISPLAY_NAMES.chat),
    );
  }

  /** An actor registered in this ledger, or null; never another ledger's. */
  async findActor(
    scope: LedgerBoundScope,
    actorId: string,
  ): Promise<LedgerActorRecord | null> {
    const key = actorCacheKey(scope.ledgerId, actorId);
    const cached = this.byActorId.get(key);
    if (cached !== undefined) return cached;
    const actors = await this.options.store().listActors(scope.ledgerId);
    for (const actor of actors) this.remember(copyActorRecord(actor));
    return this.byActorId.get(key) ?? null;
  }

  private async actorRecordsFor(
    scope: LedgerActorReadScope,
    actorIds: readonly string[],
  ): Promise<LedgerActorRecord[]> {
    if (
      actorIds.some(
        (actorId) =>
          this.byActorId.get(actorCacheKey(scope.ledgerId, actorId)) ===
          undefined,
      )
    ) {
      const actors = await this.options.store().listActors(scope.ledgerId);
      for (const actor of actors) this.remember(copyActorRecord(actor));
    }
    return actorIds.flatMap((actorId): LedgerActorRecord[] => {
      const record = this.byActorId.get(actorCacheKey(scope.ledgerId, actorId));
      return record === undefined ? [] : [record];
    });
  }

  /**
   * The labels of the actors a read names, in the order first named. Reads
   * the ledger's actors at most once, when any is not cached; an ID the
   * ledger does not know gets no label. Referenced chats take their current
   * names from canonical metadata, independently of the owner picker. The
   * registered snapshot remains the fallback and the name other devices see.
   */
  async labelsFor(
    scope: LedgerActorReadScope,
    actorIds: readonly string[],
  ): Promise<LedgerActorLabel[]> {
    const unique = Array.from(new Set(actorIds));
    const records = await this.actorRecordsFor(scope, unique);
    const chatNames = new Map<string, string>();
    if (records.some((record) => record.actor.kind === 'chat')) {
      const chats = uniqueLiveChats(
        await this.liveChats(scope.container).catch(() => []),
      );
      for (const chat of chats) {
        chatNames.set(
          ledgerActorOriginKey({ kind: 'chat', originKey: chat.chatId }),
          chat.title,
        );
      }
    }
    return records.map((record): LedgerActorLabel => {
      const chatName =
        record.actor.kind === 'chat'
          ? chatNames.get(record.originKey)
          : undefined;
      return {
        actorId: record.actor.actorId,
        kind: record.actor.kind,
        displayName:
          chatName === undefined
            ? record.displayName
            : toLedgerDisplayName(chatName, record.displayName),
      };
    });
  }

  /**
   * Read labels and this-device hosts for a Feed work page. Unlike owner
   * eligibility, host lookup includes running pipeline/delegate bindings;
   * neither path registers actors or changes their eligibility.
   */
  async workViewFor(
    scope: LedgerActorReadScope,
    actorIds: readonly string[],
  ): Promise<LedgerActorWorkView> {
    const unique = Array.from(new Set(actorIds));
    const records = await this.actorRecordsFor(scope, unique);
    const hasChats = records.some(
      (record) =>
        record.actor.kind === 'chat' ||
        record.actor.kind === 'managed_delegation',
    );
    const chats = hasChats
      ? uniqueLiveChats(
          await this.options
            .liveChats(scope.container)
            .catch((): readonly LedgerLiveChat[] => []),
        )
      : [];
    const chatNames = new Map<string, string>();
    const liveChatIds = new Set<string>();
    for (const chat of chats) {
      const originKey = ledgerActorOriginKey({
        kind: 'chat',
        originKey: chat.chatId,
      });
      chatNames.set(originKey, chat.title);
      liveChatIds.add(originKey);
    }
    const bindings = (
      this.options.callerBindings ?? getLedgerCallerBindingRegistry()
    ).listForScope(scope.container, scope.containerCreatedAt);
    const delegates =
      (await this.options
        .liveDelegates?.(scope.container)
        .catch((): readonly LedgerLiveDelegate[] => [])) ?? [];
    const paused = this.pausedPipelineAgents(scope);
    const chatScope = chatScopeOf(scope.container);
    const actorHosts: Record<string, LedgerViewActorHost> = {};
    const actors: LedgerActorLabel[] = [];

    for (const record of records) {
      const chatName =
        record.actor.kind === 'chat'
          ? chatNames.get(record.originKey)
          : undefined;
      actors.push({
        actorId: record.actor.actorId,
        kind: record.actor.kind,
        displayName:
          chatName === undefined
            ? record.displayName
            : toLedgerDisplayName(chatName, record.displayName),
      });
      // A global (workflow) Ledger has no chats or task to host its actors.
      if (chatScope === null) continue;
      const { projectId, worktreeId } = chatScope;

      if (record.actor.kind === 'chat' && liveChatIds.has(record.originKey)) {
        const chatId = record.originKey.slice(CHAT_ORIGIN_PREFIX.length);
        actorHosts[record.actor.actorId] = {
          kind: 'chat',
          projectId,
          worktreeId,
          chatId,
        };
        continue;
      }

      if (record.actor.kind === 'managed_delegation') {
        const lineage = delegateLineage(record, bindings, delegates);
        if (lineage !== null) {
          actorHosts[record.actor.actorId] = {
            kind: 'delegation',
            projectId,
            worktreeId,
            ...lineage,
          };
        }
        continue;
      }

      if (
        record.actor.kind === 'pipeline_agent' &&
        record.originKey.startsWith(PIPELINE_AGENT_ORIGIN_PREFIX)
      ) {
        const binding = latestBindingForActor(
          bindings,
          record,
          'pipeline_agent',
        );
        const bindingOrigin = binding?.origin;
        if (bindingOrigin?.kind === 'pipeline_agent') {
          actorHosts[record.actor.actorId] = {
            kind: 'pipeline',
            projectId,
            worktreeId,
            executionId: bindingOrigin.executionId,
          };
          continue;
        }
        const agentSessionId = record.originKey.slice(
          PIPELINE_AGENT_ORIGIN_PREFIX.length,
        );
        const agent = paused.find(
          (candidate) => candidate.agentSessionId === agentSessionId,
        );
        if (agent !== undefined) {
          actorHosts[record.actor.actorId] = {
            kind: 'pipeline',
            projectId,
            worktreeId,
            executionId: agent.executionId,
          };
        }
      }
    }

    return { actors, actorHosts };
  }

  /**
   * Every assignable owner, in picker order, registering chats and delegates
   * as needed.
   */
  async listOwnerCandidates(
    scope: LedgerBoundScope,
    delegateOwner?: LedgerDelegateLineageOwner,
  ): Promise<LedgerOwnerCandidateEntry[]> {
    const user = await this.ensureUser(scope);
    const chats = uniqueLiveChats(await this.liveChats(scope.container));
    const delegates = selectableDelegates(
      await this.liveDelegates(scope.container),
      chats,
    );
    const retainedDelegateIds = new Set(
      delegates.map((delegate) => delegate.delegationId),
    );
    const newDelegates =
      delegateOwner === undefined
        ? []
        : selectableDelegates(
            await readLedgerNewDelegates(scope.container, delegateOwner),
            chats,
          ).filter(
            (delegate) => !retainedDelegateIds.has(delegate.delegationId),
          );
    const chatCandidates = await Promise.all(
      chats.map(async (chat): Promise<LedgerOwnerCandidateEntry> => {
        const record = await this.ensureChat(scope, chat);
        const displayName = toLedgerDisplayName(
          chat.title,
          DEFAULT_DISPLAY_NAMES.chat,
        );
        return {
          record,
          displayName,
          sortKey: [1, chat.createdAt ?? '', chat.chatId],
        };
      }),
    );
    const delegateCandidates = await Promise.all(
      delegates.map(async (delegate): Promise<LedgerOwnerCandidateEntry> => {
        const displayName = toLedgerDisplayName(
          delegate.description,
          DEFAULT_DISPLAY_NAMES.managed_delegation,
        );
        return {
          record: await this.ensureHostActor(scope, {
            kind: 'managed_delegation',
            originKey: delegate.delegationId,
            displayName,
          }),
          displayName,
          sortKey: [2, delegate.createdAt ?? '', delegate.delegationId],
          runGeneration: delegate.runGeneration,
        };
      }),
    );
    const pipelineAgentCandidates = await Promise.all(
      this.pausedPipelineAgents(scope).map(
        async (agent): Promise<LedgerOwnerCandidateEntry> => {
          const displayName = toLedgerDisplayName(
            agent.displayName,
            DEFAULT_DISPLAY_NAMES.pipeline_agent,
          );
          return {
            record: await this.ensureHostActor(scope, {
              kind: 'pipeline_agent',
              originKey: agent.agentSessionId,
              displayName,
            }),
            displayName,
            sortKey: [3, agent.pausedAt ?? '', agent.agentSessionId],
            checkpoint: {
              checkpointId: agent.checkpointId,
              executionGeneration: agent.executionGeneration,
            },
            ...pipelineAgentLocator(agent),
          };
        },
      ),
    );
    const newDelegateCandidates = await Promise.all(
      newDelegates.map(async (delegate): Promise<LedgerOwnerCandidateEntry> => {
        const displayName = toLedgerDisplayName(
          delegate.description,
          DEFAULT_DISPLAY_NAMES.managed_delegation,
        );
        return {
          record: await this.ensureHostActor(scope, {
            kind: 'managed_delegation',
            originKey: delegate.delegationId,
            displayName,
          }),
          displayName,
          sortKey: [2, delegate.createdAt ?? '', delegate.delegationId],
          runGeneration: delegate.runGeneration,
          ...(delegateOwner === undefined ? {} : { delegateOwner }),
        };
      }),
    );
    const candidates = [
      ...chatCandidates,
      ...delegateCandidates,
      ...newDelegateCandidates,
      ...pipelineAgentCandidates,
    ];
    candidates.sort((left, right) =>
      compareSortKeys(left.sortKey, right.sortKey),
    );
    return [
      {
        record: user,
        displayName: LEDGER_USER_ACTOR_DISPLAY_NAME,
        sortKey: [0, '', ''],
      },
      ...candidates,
    ];
  }

  /**
   * One page of owner candidates, each with a fresh eligibility token. The
   * cursor is signed and bound to the ledger; a tampered, foreign or expired
   * cursor is refused.
   */
  async pageOwnerCandidates(
    scope: LedgerBoundScope,
    request: LedgerOwnerPageRequest,
  ): Promise<LedgerOwnerPageResult> {
    let after: LedgerOwnerSortKey | null = null;
    if (request.cursor !== undefined) {
      after = this.decodeOwnerCursor(scope, request.cursor);
      if (after === null) return { kind: 'cursor_expired' };
    }
    const limit = Math.min(
      Math.max(1, request.limit ?? LEDGER_LIMITS.ownersPageDefault),
      LEDGER_LIMITS.ownersPageMax,
    );
    const candidates = await this.listOwnerCandidates(
      scope,
      request.delegateOwner,
    );
    const exactDelegateOrigin =
      request.delegationId === undefined
        ? undefined
        : `${DELEGATE_ORIGIN_PREFIX}${request.delegationId}`;
    const remaining = candidates.filter(
      (candidate) =>
        (exactDelegateOrigin === undefined ||
          (candidate.record.actor.kind === 'managed_delegation' &&
            candidate.record.originKey === exactDelegateOrigin)) &&
        (after === null || compareSortKeys(candidate.sortKey, after) > 0),
    );
    const page = remaining.slice(0, limit);
    const last = page[page.length - 1];
    return {
      kind: 'page',
      page: {
        candidates: page.map(
          (candidate): LedgerOwnerCandidate => ({
            actor: candidate.record.actor,
            displayName: candidate.displayName,
            eligibilityToken: this.issueEligibilityToken(
              scope,
              candidate.record,
              candidate.runGeneration,
              candidate.checkpoint,
              candidate.delegateOwner,
            ),
            isSelf: candidate.record.actor.actorId === request.callerActorId,
            ...(candidate.pipelineAgent === undefined
              ? {}
              : { pipelineAgent: candidate.pipelineAgent }),
          }),
        ),
        nextCursor:
          request.delegationId === undefined &&
          remaining.length > limit &&
          last !== undefined
            ? this.encodeOwnerCursor(scope, last.sortKey)
            : null,
      },
    };
  }

  /**
   * A token for an owner candidate; a managed delegate's binds the run
   * generation it was listed at, and a paused pipeline agent's its
   * checkpoint and execution generation.
   */
  issueEligibilityToken(
    scope: LedgerBoundScope,
    owner: LedgerActorRecord,
    runGeneration?: number,
    checkpoint?: LedgerPipelineAgentCheckpoint,
    delegateOwner?: LedgerDelegateLineageOwner,
  ): string {
    return this.eligibility.issueToken(
      claimFor(scope, owner, runGeneration, checkpoint, delegateOwner),
    );
  }

  /**
   * True when the token is valid and current for this owner and the owner is
   * still assignable. A managed delegate must still be retained at the run
   * generation the token was issued for. Call it under the ledger's
   * admission fence and commit before releasing it.
   */
  async verifyOwnerEligibility(
    scope: LedgerBoundScope,
    owner: LedgerActorRecord,
    token: string,
    delegateOwner?: LedgerDelegateLineageOwner,
  ): Promise<boolean> {
    if (owner.actor.kind === 'pipeline_agent') {
      const agent = this.pausedPipelineAgent(scope, owner);
      return (
        agent !== undefined &&
        this.eligibility.checkToken(
          claimFor(scope, owner, undefined, {
            checkpointId: agent.checkpointId,
            executionGeneration: agent.executionGeneration,
          }),
          token,
        )
      );
    }
    if (owner.actor.kind === 'managed_delegation') {
      const delegate = await this.retainedDelegate(scope, owner);
      if (delegate !== null) {
        return this.eligibility.checkToken(
          claimFor(scope, owner, delegate.runGeneration),
          token,
        );
      }
      if (delegateOwner === undefined) return false;
      const newDelegate = await this.newDelegateForOwner(
        scope,
        owner,
        delegateOwner,
      );
      return (
        newDelegate !== null &&
        this.eligibility.checkToken(
          claimFor(
            scope,
            owner,
            newDelegate.runGeneration,
            undefined,
            delegateOwner,
          ),
          token,
        )
      );
    }
    if (!this.eligibility.checkToken(claimFor(scope, owner), token)) {
      return false;
    }
    return this.isAssignable(scope, owner);
  }

  withOwnerAdmission<T>(ledgerId: string, fn: () => Promise<T>): Promise<T> {
    return this.eligibility.withAdmission(ledgerId, fn);
  }

  /**
   * Runs `fn` under the lifecycle admission fence of a paused pipeline
   * agent's execution, shared with its resume and cancellation, so the agent
   * cannot start running between an owner check and its commit. Other owners
   * need no fence beyond the ledger's.
   */
  withOwnerLifecycleAdmission<T>(
    owner: LedgerActorRecord,
    fn: () => Promise<T>,
  ): Promise<T> {
    const source = this.options.pipelineAgents;
    if (
      source === undefined ||
      owner.actor.kind !== 'pipeline_agent' ||
      !owner.originKey.startsWith(PIPELINE_AGENT_ORIGIN_PREFIX)
    ) {
      return fn();
    }
    const agent = source.find(
      owner.originKey.slice(PIPELINE_AGENT_ORIGIN_PREFIX.length),
    );
    return agent === undefined
      ? fn()
      : source.withAdmission(agent.executionId, fn);
  }

  /**
   * Forgets every cached actor of a ledger, registered or still registering,
   * so the next use asks the store again. Scope lifecycle changes call it
   * once a scope was purged or moved to another container.
   */
  forgetLedger(ledgerId: string): void {
    const prefix = actorCacheKey(ledgerId, '');
    this.registrations.forEach((_registration, key): void => {
      if (key.startsWith(prefix)) this.registrations.delete(key);
    });
    this.byActorId.forEach((_record, key): void => {
      if (key.startsWith(prefix)) this.byActorId.delete(key);
    });
  }

  /**
   * The delegate an owner record names, while it is still selectable:
   * reported by the delegation host and belonging to a live chat.
   */
  private async retainedDelegate(
    scope: LedgerBoundScope,
    owner: LedgerActorRecord,
  ): Promise<LedgerLiveDelegate | null> {
    if (!owner.originKey.startsWith(DELEGATE_ORIGIN_PREFIX)) return null;
    const delegationId = owner.originKey.slice(DELEGATE_ORIGIN_PREFIX.length);
    const [chats, delegates] = await Promise.all([
      this.liveChats(scope.container),
      this.liveDelegates(scope.container),
    ]);
    return (
      selectableDelegates(delegates, uniqueLiveChats(chats)).find(
        (delegate) => delegate.delegationId === delegationId,
      ) ?? null
    );
  }

  /** A new delegate is assignable only for the exact owner that spawned it. */
  private async newDelegateForOwner(
    scope: LedgerBoundScope,
    owner: LedgerActorRecord,
    delegateOwner: LedgerDelegateLineageOwner,
  ): Promise<LedgerLiveDelegate | null> {
    if (!owner.originKey.startsWith(DELEGATE_ORIGIN_PREFIX)) return null;
    const delegationId = owner.originKey.slice(DELEGATE_ORIGIN_PREFIX.length);
    try {
      const [chats, newDelegates] = await Promise.all([
        this.options.liveChats(scope.container),
        readLedgerNewDelegates(scope.container, delegateOwner),
      ]);
      return (
        selectableDelegates(newDelegates, uniqueLiveChats(chats)).find(
          (delegate) => delegate.delegationId === delegationId,
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  /**
   * The actors on one root chat's line in this scope: the chat itself and the
   * delegates whose tree it started, as far as this device knows their root
   * (live bindings and delegation records). Read-only: registers nothing.
   */
  async rootChatActorIds(
    scope: LedgerActorReadScope,
    chatId: string,
  ): Promise<string[]> {
    const chatOrigin = ledgerActorOriginKey({
      kind: 'chat',
      originKey: chatId,
    });
    const records = await this.options.store().listActors(scope.ledgerId);
    const actorIds = records.flatMap((record): string[] =>
      record.actor.kind === 'chat' && record.originKey === chatOrigin
        ? [record.actor.actorId]
        : [],
    );
    const delegateRecords = records.filter(
      (record) => record.actor.kind === 'managed_delegation',
    );
    if (delegateRecords.length === 0) return actorIds;
    const bindings = (
      this.options.callerBindings ?? getLedgerCallerBindingRegistry()
    ).listForScope(scope.container, scope.containerCreatedAt);
    const delegates =
      (await this.options
        .liveDelegates?.(scope.container)
        .catch((): readonly LedgerLiveDelegate[] => [])) ?? [];
    for (const record of delegateRecords) {
      if (delegateLineage(record, bindings, delegates)?.rootChatId === chatId) {
        actorIds.push(record.actor.actorId);
      }
    }
    return actorIds;
  }

  /** Resolves durable delegation IDs only through their local-ledger origins. */
  async managedDelegationActorIds(
    scope: LedgerActorReadScope,
    delegationIds: readonly string[],
  ): Promise<string[]> {
    const origins = new Set(
      delegationIds.map((delegationId) =>
        ledgerActorOriginKey({
          kind: 'managed_delegation',
          originKey: delegationId,
        }),
      ),
    );
    if (origins.size === 0) return [];
    const actors = await this.options.store().listActors(scope.ledgerId);
    return Array.from(
      new Set(
        actors.flatMap((actor): string[] =>
          actor.actor.kind === 'managed_delegation' &&
          origins.has(actor.originKey)
            ? [actor.actor.actorId]
            : [],
        ),
      ),
    );
  }

  /** The scope's paused pipeline agents, one row per agent session. */
  private pausedPipelineAgents(
    scope: Pick<LedgerBoundScope, 'container' | 'containerCreatedAt'>,
  ): LedgerPausedPipelineAgent[] {
    const seen = new Set<string>();
    return (
      this.options.pipelineAgents?.list(
        scope.container,
        scope.containerCreatedAt,
      ) ?? []
    ).filter((agent) => {
      if (
        seen.has(agent.agentSessionId) ||
        !LedgerOpaqueIdSchema.safeParse(agent.agentSessionId).success
      ) {
        return false;
      }
      seen.add(agent.agentSessionId);
      return true;
    });
  }

  /** The paused agent an owner record names, while it is still paused here. */
  private pausedPipelineAgent(
    scope: LedgerBoundScope,
    owner: LedgerActorRecord,
  ): LedgerPausedPipelineAgent | undefined {
    if (!owner.originKey.startsWith(PIPELINE_AGENT_ORIGIN_PREFIX)) {
      return undefined;
    }
    const agentSessionId = owner.originKey.slice(
      PIPELINE_AGENT_ORIGIN_PREFIX.length,
    );
    return this.pausedPipelineAgents(scope).find(
      (agent) => agent.agentSessionId === agentSessionId,
    );
  }

  /**
   * The container's live chats. A global (workflow) Ledger has none: its
   * owners are the person and its paused pipeline agents.
   */
  private liveChats(
    container: LedgerContainer,
  ): Promise<readonly LedgerLiveChat[]> {
    return container.kind === 'global'
      ? Promise.resolve([])
      : this.options.liveChats(container);
  }

  private liveDelegates(
    container: LedgerContainer,
  ): Promise<readonly LedgerLiveDelegate[]> {
    return this.options.liveDelegates === undefined ||
      container.kind === 'global'
      ? Promise.resolve([])
      : this.options.liveDelegates(container);
  }

  private async isAssignable(
    scope: LedgerBoundScope,
    owner: LedgerActorRecord,
  ): Promise<boolean> {
    if (owner.actor.kind === 'user') {
      return owner.originKey === LEDGER_USER_ACTOR_ORIGIN_KEY;
    }
    if (
      owner.actor.kind !== 'chat' ||
      !owner.originKey.startsWith(CHAT_ORIGIN_PREFIX)
    ) {
      return false;
    }
    const chatId = owner.originKey.slice(CHAT_ORIGIN_PREFIX.length);
    const chats = await this.liveChats(scope.container);
    return chats.some((chat) => chat.chatId === chatId);
  }

  private ensureRegistered(
    scope: LedgerBoundScope,
    kind: LedgerActorKind,
    originKey: string,
    displayName: string,
  ): Promise<LedgerActorRecord> {
    const key = actorCacheKey(scope.ledgerId, originKey);
    const cached = this.registrations.get(key);
    if (cached !== undefined) return cached;
    const pending = this.register(scope, kind, originKey, displayName);
    this.registrations.set(key, pending);
    // A failed registration is not cached, so the next use tries again.
    void pending.catch((): void => {
      if (this.registrations.get(key) === pending) {
        this.registrations.delete(key);
      }
    });
    return pending;
  }

  private async register(
    scope: LedgerBoundScope,
    kind: LedgerActorKind,
    originKey: string,
    displayName: string,
  ): Promise<LedgerActorRecord> {
    const { actor } = await this.options.store().registerActor({
      ledgerId: scope.ledgerId,
      kind,
      authorityId: scope.authorityId,
      originKey,
      displayName,
    });
    const record = copyActorRecord(actor);
    this.remember(record);
    return record;
  }

  private remember(record: LedgerActorRecord): void {
    this.byActorId.set(
      actorCacheKey(record.ledgerId, record.actor.actorId),
      record,
    );
  }

  private encodeOwnerCursor(
    scope: LedgerBoundScope,
    sortKey: LedgerOwnerSortKey,
  ): string {
    const payload = Buffer.from(
      JSON.stringify({
        v: OWNER_CURSOR_VERSION,
        l: scope.ledgerId,
        k: sortKey,
        t: this.now(),
      }),
      'utf8',
    ).toString('base64url');
    return `${payload}.${this.eligibility.mac(ownerCursorMacInput(payload))}`;
  }

  private decodeOwnerCursor(
    scope: LedgerBoundScope,
    cursor: string,
  ): LedgerOwnerSortKey | null {
    const parts = cursor.split('.');
    if (parts.length !== 2) return null;
    const [payload, mac] = parts;
    if (!this.eligibility.macMatches(ownerCursorMacInput(payload), mac)) {
      return null;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (
      !isRecord(decoded) ||
      decoded.v !== OWNER_CURSOR_VERSION ||
      decoded.l !== scope.ledgerId ||
      typeof decoded.t !== 'number'
    ) {
      return null;
    }
    const age = this.now() - decoded.t;
    if (!(age >= 0 && age <= LEDGER_LIMITS.cursorLifetimeMs)) return null;
    return parseSortKey(decoded.k);
  }
}

function claimFor(
  scope: LedgerBoundScope,
  owner: LedgerActorRecord,
  runGeneration?: number,
  checkpoint?: LedgerPipelineAgentCheckpoint,
  delegateOwner?: LedgerDelegateLineageOwner,
): LedgerEligibilityClaim {
  return {
    ledgerId: scope.ledgerId,
    actorId: owner.actor.actorId,
    container: scope.container,
    originKey: owner.originKey,
    ...(runGeneration === undefined ? {} : { runGeneration }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(delegateOwner === undefined ? {} : { delegateOwner }),
  };
}

function ownerCursorMacInput(payload: string): string {
  return `ledger-owner-cursor\n${payload}`;
}

function parseSortKey(value: unknown): LedgerOwnerSortKey | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const group: unknown = value[0];
  const createdAt: unknown = value[1];
  const id: unknown = value[2];
  return typeof group === 'number' &&
    Number.isSafeInteger(group) &&
    typeof createdAt === 'string' &&
    typeof id === 'string'
    ? [group, createdAt, id]
    : null;
}
