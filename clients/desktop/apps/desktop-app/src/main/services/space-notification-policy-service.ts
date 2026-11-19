// ---------------------------------------------------------------------------
// Per-space notification policy replica (CAN-3615).
//
// The server owns each user's saved choice per space (a code worktree or a
// Cowork Work Entry). Main keeps an account-keyed replica under app data,
// registers this install's spaces and refreshes their choices on startup,
// sign-in, focus and a bounded interval, and is the one writer of the
// replica. Native and in-app delivery read it synchronously: main-side
// senders through `evaluate`, the renderer through the broadcast snapshot.
// Recording (history, unread, audit) never consults it.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  SPACE_NOTIFICATION_SYNC_MAX_SPACES,
  spaceNotificationLevelSchema,
  type SpaceNotificationSource,
} from '@canopy/protocol/space-notifications';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
  spaceNotificationScopeKey,
} from '@canopy/desktop-shared/lib/space-notification-policy';
import type {
  SpaceNotificationPolicySnapshot,
  SpaceNotificationScope,
  SpaceNotificationSetRequest,
  SpaceNotificationSetResult,
  SpaceNotificationSpaceState,
} from '@canopy/desktop-shared/types';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
} from '../canopy-cloud/client';
import { getDesktopOAuthClientDeviceId } from '../canopy-cloud/oauth-login';
import {
  spaceNotificationProducerId,
  spaceNotificationSourceRef,
} from '../lib/space-notification-ref';
import {
  loadCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';
import { writeFileAtomically } from '../lib/atomic-file';
import { listWorkEntryIds } from '../lib/cowork-work-entries';
import { getSpaceNotificationPolicyDir } from '../lib/paths';
import { publishSpaceNotificationPolicy } from '../lib/space-notification-gate';
import { scheduleDesktopStructureChanged } from './desktop-structure-signal';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { logMainProcessWarn } from '../lib/main-process-logging';

const SPACES_PATH = '/api/v1/notification-spaces';
/** Remote changes reach this install within this interval at most. */
export const SPACE_NOTIFICATION_SYNC_INTERVAL_MS = 60_000;
/** Focus-triggered refreshes are coalesced to at most one per window. */
const FOCUS_SYNC_MIN_INTERVAL_MS = 10_000;

const transitionSchema = z.object({
  revision: z.number().int().nonnegative(),
  effectiveAt: z.string(),
  priorOverride: spaceNotificationLevelSchema.nullable(),
  nextOverride: spaceNotificationLevelSchema.nullable(),
});
const spaceStateSchema = z.object({
  notificationSpaceId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  override: spaceNotificationLevelSchema.nullable(),
  transitions: z.array(transitionSchema),
});
const persistedSchema = z.object({
  version: z.literal(1),
  accountKey: z.string().min(1),
  writesEnabled: z.boolean(),
  serverOffsetMs: z.number(),
  syncedAt: z.string().nullable(),
  spaces: z.record(z.string(), spaceStateSchema),
});
const syncResultSchema = z.object({
  serverTime: z.string(),
  transitionsSince: z.string(),
  writesEnabled: z.boolean(),
  spaces: z.array(
    z.object({
      workspaceId: z.string(),
      spaceId: z.string(),
      policy: z.object({
        spaceId: z.string().min(1),
        revision: z.number().int().nonnegative(),
        override: spaceNotificationLevelSchema.nullable(),
        transitions: z.array(transitionSchema),
      }),
    }),
  ),
});
const patchResultSchema = z.object({
  spaceId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  override: spaceNotificationLevelSchema.nullable(),
  writesEnabled: z.boolean(),
  transitions: z.array(transitionSchema),
  nextRevision: z.number().int().nullable().optional(),
});

/** Signed-in, non-guest accounts have server-stored choices. */
function accountKeyOf(entry: CanopyCloudAccountEntry | null): string | null {
  if (!entry || isGuestAccount(entry)) return null;
  return entry.account?.id ?? null;
}

function accountFileName(accountKey: string): string {
  return `${createHash('sha256').update(accountKey).digest('hex')}.json`;
}

function sameSpaceState(
  a: SpaceNotificationSpaceState | undefined,
  b: SpaceNotificationSpaceState,
): boolean {
  return (
    a !== undefined &&
    a.notificationSpaceId === b.notificationSpaceId &&
    a.revision === b.revision &&
    a.override === b.override &&
    a.transitions.length === b.transitions.length &&
    a.transitions.every(
      (t, i) =>
        t.revision === b.transitions[i]?.revision &&
        t.effectiveAt === b.transitions[i]?.effectiveAt,
    )
  );
}

export interface SpaceNotificationSourceListing {
  readonly sources: SpaceNotificationSource[];
  /** False when some project's spaces could not be read: the listing is
   * still worth synchronizing, but absence from it proves nothing. */
  readonly complete: boolean;
}

/** Every space this install can produce chat or pipeline activity for. */
export async function listLocalNotificationSources(): Promise<SpaceNotificationSourceListing> {
  const { items } = await readAllSidebarItems();
  const sources: SpaceNotificationSource[] = [];
  let complete = true;
  for (const item of items) {
    if (item.type === 'cowork') {
      const ids = await listWorkEntryIds(item.id).catch((): null => null);
      if (ids === null) complete = false;
      for (const id of ids ?? [])
        sources.push({ workspaceId: item.id, spaceId: id });
    } else {
      for (const worktree of item.worktrees) {
        sources.push({ workspaceId: item.id, spaceId: worktree.id });
      }
    }
  }
  return { sources, complete };
}

function refKey(source: SpaceNotificationSource): string {
  return `${source.workspaceId}\u001f${source.spaceId}`;
}

export interface SpaceNotificationPolicyServiceDeps {
  readonly loadAccount: () => Promise<CanopyCloudAccountEntry | null>;
  readonly subscribeAccount: (
    listener: (entry: CanopyCloudAccountEntry | null) => void,
  ) => () => void;
  readonly producerId: () => Promise<string>;
  readonly listSources: () => Promise<SpaceNotificationSourceListing>;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly dir: () => string;
  readonly now: () => number;
}

export class SpaceNotificationPolicyService {
  private snapshot: SpaceNotificationPolicySnapshot =
    EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT;
  private readonly listeners = new Set<
    (snapshot: SpaceNotificationPolicySnapshot) => void
  >();
  private inFlight: Promise<void> | null = null;
  private syncQueued = false;
  private lastFocusSyncAt = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private unsubscribeAccount: (() => void) | null = null;
  /** Bumped on every account change; stale responses are discarded. */
  private generation = 0;

  constructor(private readonly deps: SpaceNotificationPolicyServiceDeps) {}

  async start(): Promise<void> {
    this.unsubscribeAccount = this.deps.subscribeAccount((entry) => {
      void this.activateAccount(accountKeyOf(entry));
    });
    await this.activateAccount(accountKeyOf(await this.deps.loadAccount()));
    this.interval = setInterval(() => {
      void this.sync();
    }, SPACE_NOTIFICATION_SYNC_INTERVAL_MS);
    this.interval.unref?.();
  }

  stop(): void {
    this.unsubscribeAccount?.();
    this.unsubscribeAccount = null;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  getSnapshot(): SpaceNotificationPolicySnapshot {
    return this.snapshot;
  }

  subscribe(
    listener: (snapshot: SpaceNotificationPolicySnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /** Window focus: refresh, coalesced so focus churn stays cheap. */
  onFocus(): void {
    const now = this.deps.now();
    if (now - this.lastFocusSyncAt < FOCUS_SYNC_MIN_INTERVAL_MS) return;
    this.lastFocusSyncAt = now;
    void this.sync();
  }

  /** Synchronize every local space. Concurrent calls share one pass, and a
   * call during a pass schedules exactly one more. */
  sync(): Promise<void> {
    if (this.inFlight) {
      this.syncQueued = true;
      return this.inFlight;
    }
    const run = async (): Promise<void> => {
      try {
        const { sources, complete } = await this.deps.listSources();
        const generation = this.generation;
        const known = Object.keys(this.snapshot.spaces);
        await this.syncSources(sources);
        // Forget spaces deleted locally once a full pass has completed. A
        // partial listing, or an empty one (indistinguishable from a failed
        // read), never prunes: absence from it proves nothing, and forgetting
        // a saved Mute would let local notifications through again. Spaces
        // added during the pass are left alone.
        if (generation === this.generation && complete && sources.length > 0)
          await this.forgetUnlisted(known, sources);
      } catch (error) {
        logMainProcessWarn('[space-notifications] sync failed', error);
      }
    };
    this.inFlight = run().finally(() => {
      this.inFlight = null;
      if (this.syncQueued) {
        this.syncQueued = false;
        void this.sync();
      }
    });
    return this.inFlight;
  }

  /** Register one space if needed and re-read its saved choice. */
  async refresh(
    scope: SpaceNotificationScope,
  ): Promise<SpaceNotificationPolicySnapshot> {
    try {
      await this.syncSources([
        { workspaceId: scope.projectId, spaceId: scope.worktreeId },
      ]);
    } catch (error) {
      logMainProcessWarn('[space-notifications] refresh failed', error);
    }
    return this.snapshot;
  }

  async set(
    request: SpaceNotificationSetRequest,
  ): Promise<SpaceNotificationSetResult> {
    const accountKey = this.snapshot.accountKey;
    const key = spaceNotificationScopeKey(request);
    const space = this.snapshot.spaces[key];
    if (!accountKey || !space)
      return { status: 'unavailable', snapshot: this.snapshot };
    if (!this.snapshot.writesEnabled)
      return { status: 'disabled', snapshot: this.snapshot };
    // All activity is stored as no override; send and compare it that way.
    const override = request.override === 'all' ? null : request.override;
    const generation = this.generation;
    try {
      const body = patchResultSchema.parse(
        await this.deps.request<unknown>(
          `${SPACES_PATH}/${encodeURIComponent(space.notificationSpaceId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              expectedRevision: request.expectedRevision,
              override,
            }),
          },
        ),
      );
      if (generation !== this.generation)
        return { status: 'failed', snapshot: this.snapshot };
      if (
        body.spaceId === space.notificationSpaceId &&
        body.override === override &&
        body.revision >= request.expectedRevision
      ) {
        this.putSpace(key, {
          notificationSpaceId: body.spaceId,
          revision: body.revision,
          override: body.override,
          transitions: body.transitions,
        });
        // A long history arrives paged from the oldest; re-read the recent
        // window the replica evaluates against.
        if (typeof body.nextRevision === 'number') await this.refresh(request);
        return { status: 'saved', snapshot: this.snapshot };
      }
    } catch (error) {
      if (generation !== this.generation)
        return { status: 'failed', snapshot: this.snapshot };
      if (error instanceof CanopyCloudClientError && error.status === 404)
        return { status: 'unavailable', snapshot: this.snapshot };
      if (error instanceof CanopyCloudClientError && error.status === 503) {
        await this.refresh(request);
        return { status: 'disabled', snapshot: this.snapshot };
      }
      if (error instanceof CanopyCloudClientError && error.status === 423) {
        await this.refresh(request);
        return { status: 'busy', snapshot: this.snapshot };
      }
      // Anything else, including a lost response, is settled by reading the
      // space again rather than by assuming the write failed.
    }
    await this.refresh(request);
    const latest = this.snapshot.spaces[key];
    if (
      latest &&
      latest.revision > request.expectedRevision &&
      latest.override === override
    )
      return { status: 'saved', snapshot: this.snapshot };
    return {
      status:
        latest && latest.revision > request.expectedRevision
          ? 'conflict'
          : 'failed',
      snapshot: this.snapshot,
    };
  }

  private async activateAccount(accountKey: string | null): Promise<void> {
    if (accountKey === this.snapshot.accountKey) return;
    this.generation += 1;
    const generation = this.generation;
    // The previous account's choices stop applying at once.
    this.snapshot = { ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT, accountKey };
    this.emit();
    if (!accountKey) return;
    const loaded = await this.readPersisted(accountKey);
    if (generation !== this.generation) return;
    if (loaded) {
      this.snapshot = loaded;
      this.emit();
    }
    void this.sync();
  }

  private async syncSources(
    sources: readonly SpaceNotificationSource[],
  ): Promise<void> {
    const accountKey = this.snapshot.accountKey;
    if (!accountKey || sources.length === 0) return;
    const generation = this.generation;
    const producerId = await this.deps.producerId();
    for (
      let index = 0;
      index < sources.length;
      index += SPACE_NOTIFICATION_SYNC_MAX_SPACES
    ) {
      // The server sees only keyed references to local ids; answers are
      // mapped back through the references this chunk sent.
      const local = new Map<string, SpaceNotificationSource>();
      const chunk = sources
        .slice(index, index + SPACE_NOTIFICATION_SYNC_MAX_SPACES)
        .map((source) => {
          const ref = spaceNotificationSourceRef(producerId, source);
          local.set(refKey(ref), source);
          return ref;
        });
      const startedAt = this.deps.now();
      const result = syncResultSchema.parse(
        await this.deps.request<unknown>(
          `${SPACES_PATH}/producers/${encodeURIComponent(producerId)}`,
          { method: 'POST', body: JSON.stringify({ spaces: chunk }) },
        ),
      );
      if (generation !== this.generation) return;
      const receivedAt = this.deps.now();
      const serverMs = Date.parse(result.serverTime);
      const serverOffsetMs = Number.isFinite(serverMs)
        ? Math.round(serverMs - (startedAt + receivedAt) / 2)
        : this.snapshot.serverOffsetMs;
      const spaces = { ...this.snapshot.spaces };
      let registered = false;
      let changed =
        result.writesEnabled !== this.snapshot.writesEnabled ||
        Math.abs(serverOffsetMs - this.snapshot.serverOffsetMs) > 1_000;
      for (const entry of result.spaces) {
        const source = local.get(refKey(entry));
        if (!source) continue;
        const key = spaceNotificationScopeKey({
          projectId: source.workspaceId,
          worktreeId: source.spaceId,
        });
        const next: SpaceNotificationSpaceState = {
          notificationSpaceId: entry.policy.spaceId,
          revision: entry.policy.revision,
          override: entry.policy.override,
          transitions: entry.policy.transitions,
        };
        const previous = spaces[key];
        // A late response never rolls a space back to an older revision. A
        // different id is a recreated space, which always replaces the old.
        if (
          previous?.notificationSpaceId === next.notificationSpaceId &&
          previous.revision > next.revision
        )
          continue;
        if (sameSpaceState(previous, next)) continue;
        if (previous?.notificationSpaceId !== next.notificationSpaceId)
          registered = true;
        spaces[key] = next;
        changed = true;
      }
      this.snapshot = {
        ...this.snapshot,
        writesEnabled: result.writesEnabled,
        serverOffsetMs,
        syncedAt: new Date(receivedAt).toISOString(),
        spaces,
      };
      if (changed) this.emit();
      // Remote Control rows carry each space's server id; republish once new
      // spaces are registered so web and mobile can offer their choices.
      if (registered)
        scheduleDesktopStructureChanged('structural.space-notification-policy');
      // `syncedAt` alone is not worth a disk write every minute.
      if (changed) await this.persist();
    }
  }

  private async forgetUnlisted(
    known: readonly string[],
    sources: readonly SpaceNotificationSource[],
  ): Promise<void> {
    const listed = new Set(
      sources.map((source) =>
        spaceNotificationScopeKey({
          projectId: source.workspaceId,
          worktreeId: source.spaceId,
        }),
      ),
    );
    const stale = known.filter(
      (key) => !listed.has(key) && key in this.snapshot.spaces,
    );
    if (stale.length === 0) return;
    const spaces = { ...this.snapshot.spaces };
    for (const key of stale) delete spaces[key];
    this.snapshot = { ...this.snapshot, spaces };
    this.emit();
    await this.persist();
  }

  private putSpace(key: string, state: SpaceNotificationSpaceState): void {
    const previous = this.snapshot.spaces[key];
    if (previous && previous.revision > state.revision) return;
    this.snapshot = {
      ...this.snapshot,
      spaces: { ...this.snapshot.spaces, [key]: state },
    };
    this.emit();
    void this.persist();
  }

  private async readPersisted(
    accountKey: string,
  ): Promise<SpaceNotificationPolicySnapshot | null> {
    try {
      const raw = await readFile(
        join(this.deps.dir(), accountFileName(accountKey)),
        'utf8',
      );
      const parsed = persistedSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || parsed.data.accountKey !== accountKey) return null;
      return {
        accountKey: parsed.data.accountKey,
        writesEnabled: parsed.data.writesEnabled,
        serverOffsetMs: parsed.data.serverOffsetMs,
        syncedAt: parsed.data.syncedAt,
        spaces: parsed.data.spaces,
      };
    } catch {
      return null;
    }
  }

  private persistChain: Promise<void> = Promise.resolve();

  /** Writes run one at a time, and each writes the snapshot current when it
   * starts, so an older write can never land after a newer one. */
  private persist(): Promise<void> {
    const write = this.persistChain.then(() => this.writeSnapshot());
    this.persistChain = write;
    return write;
  }

  private async writeSnapshot(): Promise<void> {
    const { accountKey } = this.snapshot;
    if (!accountKey) return;
    try {
      await mkdir(this.deps.dir(), { recursive: true });
      await writeFileAtomically(
        join(this.deps.dir(), accountFileName(accountKey)),
        JSON.stringify({ version: 1, ...this.snapshot, accountKey }),
      );
    } catch (error) {
      logMainProcessWarn('[space-notifications] persist failed', error);
    }
  }

  private emit(): void {
    publishSpaceNotificationPolicy(this.snapshot);
    this.listeners.forEach((listener): void => listener(this.snapshot));
  }
}

let service: SpaceNotificationPolicyService | null = null;

export function getSpaceNotificationPolicyService(): SpaceNotificationPolicyService {
  service ??= new SpaceNotificationPolicyService({
    loadAccount: loadCanopyCloudAccount,
    subscribeAccount: subscribeCanopyCloudAccountChanges,
    producerId: async (): Promise<string> =>
      spaceNotificationProducerId(await getDesktopOAuthClientDeviceId()),
    listSources: listLocalNotificationSources,
    request: requestCanopyCloudJson,
    dir: getSpaceNotificationPolicyDir,
    now: (): number => Date.now(),
  });
  return service;
}
