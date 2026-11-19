import {
  LABS_EXPERIMENTS,
  parseLabsExperimentFixtures,
  validateLabsExperiments,
  type LabsExperiment,
  type LabsExperimentsSnapshot,
} from '@canopy/desktop-shared/lib/labs-experiments';
import {
  EARLY_ACCESS_EXPERIMENT_ID,
  isLabsExperimentAvailability,
  labsExperimentChoiceRequestSchema,
  labsExperimentChoiceResultSchema,
  labsExperimentChoicesSchema,
  migrateExtractedLabsChoices,
  resolveLabsExperiment,
  type LabsExperimentAvailability,
  type LabsExperimentChoiceRequest,
} from '@canopy/protocol/experiments';
import { readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type {
  LabsAvailabilityFallbackPolicy,
  LabsAvailabilityState,
  ResolvedLabsAvailability,
} from '../feature-flags/labs-availability';
import { resolveLabsAvailabilityWithSource } from '../feature-flags/labs-availability';
import { writeFileAtomically } from '../lib/atomic-file';
import { setExperimentalFeaturesEnabled } from '../lib/experimental-features';
import {
  getLabsExperimentAvailabilityCachePath,
  getLabsExperimentChoicesPath,
  getLabsExperimentPendingSyncPath,
} from '../lib/paths';

const choicesFileSchema = z.strictObject({
  version: z.literal(1),
  accounts: z.record(z.string(), labsExperimentChoicesSchema),
});
const availabilityFileSchema = z.strictObject({
  version: z.literal(1),
  contexts: z.record(
    z.string().regex(/^[a-f0-9]{64}$/),
    z.record(z.string(), z.enum(['hidden', 'offered', 'on'])),
  ),
});
// Signed-in choices committed locally but not yet confirmed by the account
// service. The value to send is always the account's current local choice.
const pendingSyncFileSchema = z.strictObject({
  version: z.literal(1),
  accounts: z.record(z.string(), z.array(z.string())),
});
type ChoicesFile = z.output<typeof choicesFileSchema>;
type AvailabilityFile = z.output<typeof availabilityFileSchema>;
export interface LabsAccountSession {
  scope: string;
  signedIn: boolean;
  ready: boolean;
}
export interface LabsExperimentsDependencies {
  choicesPath: string;
  availabilityPath: string;
  pendingSyncPath: string;
  read(path: string): unknown;
  write(path: string, data: string): Promise<void>;
  availability(): LabsAvailabilityState;
  availabilityFallback?: LabsAvailabilityFallbackPolicy;
  fetchChoices(session: LabsAccountSession): Promise<unknown>;
  putChoice(
    session: LabsAccountSession,
    request: LabsExperimentChoiceRequest,
  ): Promise<unknown>;
  diagnostic(error: unknown): void;
  mirror(enabled: boolean): void;
  /** A PUT refusal the account service will repeat, such as the choice cap. */
  isPermanentRejection?(error: unknown): boolean;
}
export class LabsExperimentError extends Error {
  constructor(
    readonly code:
      | 'invalid_payload'
      | 'missing_capability'
      | 'surface_unavailable',
    message: string,
  ) {
    super(message);
  }
}

/** One main-owned evaluator and writer for all windows and agent actions. */
export class LabsExperimentsService {
  private accounts: ChoicesFile['accounts'];
  private pendingSync: Record<string, string[]>;
  private contexts: AvailabilityFile['contexts'];
  private session: LabsAccountSession;
  private generation = 0;
  private revision = 0;
  private choicesReady = false;
  private listeners = new Set<(snapshot: LabsExperimentsSnapshot) => void>();
  private writes = new Map<string, Promise<unknown>>();
  private syncs = new Map<string, Promise<void>>();
  private queuedSyncs = new Map<string, Promise<void>>();
  private syncSessions = new Map<string, LabsAccountSession>();
  private loads = new Set<Promise<void>>();
  private writeVersions = new Map<string, number>();
  private persistence: Promise<unknown> = Promise.resolve();
  private snapshot: LabsExperimentsSnapshot;

  constructor(
    private readonly deps: LabsExperimentsDependencies,
    session: LabsAccountSession,
    private readonly entries: readonly LabsExperiment[] = LABS_EXPERIMENTS,
  ) {
    validateLabsExperiments(entries, true);
    this.session = { ...session };
    const rawChoices = deps.read(deps.choicesPath);
    const parsedChoices = choicesFileSchema.safeParse(rawChoices);
    const cachedAccounts = parsedChoices.data?.accounts ?? {};
    // The old choice is already durable. Materialize the same preference in
    // its own scope before any later mutation of Early access can change it.
    this.accounts = Object.fromEntries(
      Object.entries(cachedAccounts).map(([scope, choices]) => [
        scope,
        migrateExtractedLabsChoices(choices),
      ]),
    );
    if (
      !session.signedIn &&
      !Object.prototype.hasOwnProperty.call(this.accounts, session.scope)
    )
      this.accounts[session.scope] = migrateExtractedLabsChoices({});
    const rawPendingSync = deps.read(deps.pendingSyncPath);
    const parsedPendingSync = pendingSyncFileSchema.safeParse(rawPendingSync);
    this.pendingSync = parsedPendingSync.data?.accounts ?? {};
    if (rawPendingSync !== undefined && !parsedPendingSync.success)
      deps.diagnostic(
        new Error(
          'Ignored an unreadable Labs pending-sync file; unsynced choices stay local until they change again.',
        ),
      );
    this.contexts = Object.fromEntries(
      Object.entries(
        availabilityFileSchema.safeParse(deps.read(deps.availabilityPath)).data
          ?.contexts ?? {},
      ).slice(-32),
    );
    this.choicesReady = this.hasLocalChoices(session);
    this.snapshot = this.evaluate();
    deps.mirror(this.snapshot.earlyAccessEnabled);
    if (
      (parsedChoices.success || rawChoices === undefined) &&
      JSON.stringify(cachedAccounts) !== JSON.stringify(this.accounts)
    ) {
      const write = deps.write.bind(deps);
      const data = JSON.stringify({ version: 1, accounts: this.accounts });
      // Serialize this durable upgrade ahead of normal saves. The initial
      // effective value is unchanged from the already durable old preference.
      void this.queuePersistence(() => write(deps.choicesPath, data)).catch(
        (error) => deps.diagnostic(error),
      );
    }
  }
  getSnapshot(): LabsExperimentsSnapshot {
    return structuredClone(this.snapshot);
  }
  isExperimentEnabled(id: string): boolean {
    return (
      this.snapshot.ready &&
      this.snapshot.experiments.some(
        (entry) => entry.id === id && entry.enabled === true,
      )
    );
  }
  onSnapshotChanged(
    listener: (snapshot: LabsExperimentsSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }
  activate(session: LabsAccountSession): Promise<void> {
    this.generation++;
    this.session = { ...session };
    if (
      !session.signedIn &&
      !Object.prototype.hasOwnProperty.call(this.accounts, session.scope)
    )
      this.accounts[session.scope] = migrateExtractedLabsChoices({});
    this.choicesReady = this.hasLocalChoices(session);
    this.publish();
    return this.refreshChoices();
  }
  refreshChoices(): Promise<void> {
    const load = this.loadChoices();
    this.loads.add(load);
    void load
      .finally(() => {
        this.loads.delete(load);
      })
      .catch(() => undefined);
    return load;
  }
  private async loadChoices(): Promise<void> {
    const session = this.session;
    const generation = this.generation;
    if (!session.signedIn || !session.ready) return;
    await this.writes.get(session.scope)?.catch(() => undefined);
    // Offer unsynced local choices first so the GET can reflect them.
    await this.syncPending(session);
    if (generation !== this.generation) return;
    const version = this.writeVersions.get(session.scope) ?? 0;
    try {
      const response = z
        .strictObject({ choices: labsExperimentChoicesSchema })
        .parse(await this.deps.fetchChoices(session));
      if (
        generation !== this.generation ||
        version !== (this.writeVersions.get(session.scope) ?? 0)
      )
        return;
      this.accounts = {
        ...this.accounts,
        [session.scope]: this.withPendingChoices(
          session.scope,
          response.choices,
        ),
      };
      this.choicesReady = true;
      this.publish();
      await this.persistChoices();
    } catch (error) {
      this.deps.diagnostic(error);
      if (
        generation === this.generation &&
        version === (this.writeVersions.get(session.scope) ?? 0)
      ) {
        this.choicesReady = true;
        this.publish();
      }
    }
  }
  availabilityChanged(): void {
    const state = this.deps.availability();
    if (state.contextIdentity) {
      const cached = Object.prototype.hasOwnProperty.call(
        this.contexts,
        state.contextIdentity,
      )
        ? (this.contexts[state.contextIdentity] ?? {})
        : {};
      const values: Record<string, LabsExperimentAvailability> = { ...cached };
      for (const entry of this.entries) {
        const live = state.liveValues[entry.flagKey];
        if (
          entry.fixtureAvailability === undefined &&
          isLabsExperimentAvailability(live)
        )
          values[entry.flagKey] = live;
      }
      if (JSON.stringify(values) !== JSON.stringify(cached)) {
        const contexts = { ...this.contexts };
        delete contexts[state.contextIdentity];
        contexts[state.contextIdentity] = values;
        this.contexts = Object.fromEntries(Object.entries(contexts).slice(-32));
        void this.queuePersistence(() =>
          this.deps.write(
            this.deps.availabilityPath,
            JSON.stringify({ version: 1, contexts: this.contexts }),
          ),
        ).catch((error) => this.deps.diagnostic(error));
      }
    }
    this.publish();
  }
  setChoice(
    raw: LabsExperimentChoiceRequest,
  ): Promise<LabsExperimentsSnapshot> {
    const request = labsExperimentChoiceRequestSchema.safeParse(raw);
    if (!request.success)
      return Promise.reject(
        new LabsExperimentError(
          'invalid_payload',
          'Invalid experiment choice.',
        ),
      );
    const session = this.session;
    const generation = this.generation;
    this.writeVersions.set(
      session.scope,
      (this.writeVersions.get(session.scope) ?? 0) + 1,
    );
    const previous = this.writes.get(session.scope) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async (): Promise<LabsExperimentsSnapshot> => {
        this.assertGeneration(generation);
        const current = this.snapshot.experiments.find(
          (entry) => entry.id === request.data.experimentId,
        );
        if (!current)
          throw new LabsExperimentError(
            'invalid_payload',
            'Unknown experiment.',
          );
        if (!this.snapshot.ready || !session.ready)
          throw new LabsExperimentError(
            'surface_unavailable',
            'Experiment state is not ready.',
          );
        if (request.data.enabled && current.blockedBy !== undefined)
          throw new LabsExperimentError(
            'missing_capability',
            'Experiment is unavailable.',
          );
        if (
          current.availability === 'hidden' ||
          (current.requiresEarlyAccess &&
            request.data.enabled &&
            !this.snapshot.earlyAccessEnabled)
        )
          throw new LabsExperimentError(
            'missing_capability',
            'Experiment is unavailable.',
          );
        // The local commit is the save for every scope; the account service
        // is synchronized in the background and never gates the switch.
        const { experimentId, enabled } = request.data;
        await this.queuePersistence(async (): Promise<void> => {
          this.assertGeneration(generation);
          if (session.signedIn)
            // Mark it pending on disk before the choice lands: a spare pending
            // id only re-sends the current value, while a choice without one
            // would be replaced by the next GET.
            await this.deps.write(
              this.deps.pendingSyncPath,
              JSON.stringify({
                version: 1,
                accounts: this.withPendingId(session.scope, experimentId),
              }),
            );
          try {
            await this.deps.write(
              this.deps.choicesPath,
              JSON.stringify({
                version: 1,
                accounts: {
                  ...this.accounts,
                  [session.scope]: {
                    ...this.accountChoices(session.scope),
                    [experimentId]: enabled,
                  },
                },
              }),
            );
          } catch (error) {
            // A failed save must not leave its id to re-send the old value.
            if (session.signedIn)
              await this.deps
                .write(
                  this.deps.pendingSyncPath,
                  JSON.stringify({ version: 1, accounts: this.pendingSync }),
                )
                .catch((cleanupError) => this.deps.diagnostic(cleanupError));
            throw error;
          }
          // Apply both in one step, from current state: a sync pass that ran
          // during the writes may have merged a server map or cleared this id
          // after sending the previous value.
          this.accounts = {
            ...this.accounts,
            [session.scope]: {
              ...this.accountChoices(session.scope),
              [experimentId]: enabled,
            },
          };
          if (session.signedIn)
            this.pendingSync = this.withPendingId(session.scope, experimentId);
        });
        if (session.signedIn) void this.syncPending(session);
        this.assertGeneration(generation);
        if (session.signedIn) this.choicesReady = true;
        this.publish();
        this.assertGeneration(generation);
        return this.getSnapshot();
      });
    this.writes.set(session.scope, write);
    void write
      .finally(() => {
        if (this.writes.get(session.scope) === write)
          this.writes.delete(session.scope);
      })
      .catch(() => undefined);
    return write;
  }
  /** Pushes the current account's unsynced choices; failures stay pending. */
  retryPendingSync(): Promise<void> {
    return this.syncPending(this.session);
  }
  /** Settles local work; background syncs are already durable as pending ids. */
  async flush(): Promise<void> {
    await Promise.allSettled([
      ...Array.from(this.writes.values()),
      ...Array.from(this.loads),
    ]);
    await this.persistence;
  }
  private hasLocalChoices(session: LabsAccountSession): boolean {
    return (
      !session.signedIn ||
      Object.prototype.hasOwnProperty.call(this.accounts, session.scope)
    );
  }
  private withPendingId(
    scope: string,
    experimentId: string,
  ): Record<string, string[]> {
    const pending = this.pendingSync[scope] ?? [];
    return pending.includes(experimentId)
      ? this.pendingSync
      : { ...this.pendingSync, [scope]: [...pending, experimentId] };
  }
  private persistPendingSync(): Promise<void> {
    return this.queuePersistence(() =>
      this.deps.write(
        this.deps.pendingSyncPath,
        JSON.stringify({ version: 1, accounts: this.pendingSync }),
      ),
    );
  }
  /** Server choices with this account's unsynced local choices on top. */
  private withPendingChoices(
    scope: string,
    server: Record<string, boolean>,
  ): Record<string, boolean> {
    const local = this.accountChoices(scope);
    const merged = { ...server };
    for (const id of this.pendingSync[scope] ?? [])
      if (Object.prototype.hasOwnProperty.call(local, id))
        merged[id] = local[id] ?? false;
    return merged;
  }
  /** Best effort and never rejects; at most one pass waits per account. */
  private syncPending(session: LabsAccountSession): Promise<void> {
    if (!session.signedIn || !session.ready) return Promise.resolve();
    const scope = session.scope;
    // The newest credentials win; a waiting pass reads every id at its start.
    this.syncSessions.set(scope, session);
    const queued = this.queuedSyncs.get(scope);
    if (queued) return queued;
    const previous = this.syncs.get(scope) ?? Promise.resolve();
    const sync = previous
      .catch(() => undefined)
      .then(() => {
        this.queuedSyncs.delete(scope);
        return this.pushPending(this.syncSessions.get(scope) ?? session);
      })
      .catch((error) => this.deps.diagnostic(error));
    this.queuedSyncs.set(scope, sync);
    this.syncs.set(scope, sync);
    void sync.finally(() => {
      if (this.syncs.get(scope) === sync) this.syncs.delete(scope);
    });
    return sync;
  }
  private async pushPending(session: LabsAccountSession): Promise<void> {
    const scope = session.scope;
    for (;;) {
      const experimentId = this.pendingSync[scope]?.[0];
      if (experimentId === undefined) return;
      const choices = this.accountChoices(scope);
      const enabled = Object.prototype.hasOwnProperty.call(
        choices,
        experimentId,
      )
        ? choices[experimentId]
        : undefined;
      let committed: Record<string, boolean> | undefined;
      let sent = false;
      if (enabled !== undefined) {
        try {
          const result = labsExperimentChoiceResultSchema.parse(
            await this.deps.putChoice(session, { experimentId, enabled }),
          );
          if (
            result.experimentId !== experimentId ||
            result.enabled !== enabled ||
            (result.choices !== undefined &&
              result.choices[experimentId] !== enabled)
          )
            throw new Error('Invalid experiment choice response.');
          committed = result.choices;
          sent = true;
        } catch (error) {
          this.deps.diagnostic(error);
          // Offline or transient: keep it pending for the next attempt. A
          // refusal the server will repeat drops the id so it cannot hold back
          // the account's other choices; the local choice then lasts until
          // the next account refresh replaces it.
          if (!this.deps.isPermanentRejection?.(error)) return;
        }
      }
      // A newer local change to the same id stays pending for the next pass.
      if (this.accountChoices(scope)[experimentId] === enabled) {
        const rest = (this.pendingSync[scope] ?? []).filter(
          (id) => id !== experimentId,
        );
        const pendingSync = { ...this.pendingSync };
        if (rest.length > 0) pendingSync[scope] = rest;
        else delete pendingSync[scope];
        this.pendingSync = pendingSync;
      }
      // A GET issued before this commit must not replace it.
      if (sent)
        this.writeVersions.set(scope, (this.writeVersions.get(scope) ?? 0) + 1);
      if (committed) {
        const next = this.withPendingChoices(scope, committed);
        if (
          JSON.stringify(next) !== JSON.stringify(this.accountChoices(scope))
        ) {
          this.accounts = { ...this.accounts, [scope]: next };
          if (scope === this.session.scope) this.publish();
        }
        await this.persistChoices().catch((error) =>
          this.deps.diagnostic(error),
        );
      }
      await this.persistPendingSync().catch((error) =>
        this.deps.diagnostic(error),
      );
    }
  }
  private assertGeneration(generation: number): void {
    if (generation !== this.generation)
      throw new LabsExperimentError(
        'surface_unavailable',
        'Account changed during the request.',
      );
  }
  private accountChoices(scope: string): Record<string, boolean> {
    return Object.prototype.hasOwnProperty.call(this.accounts, scope)
      ? (this.accounts[scope] ?? {})
      : {};
  }
  private queuePersistence(operation: () => Promise<void>): Promise<void> {
    const pending = this.persistence.catch(() => undefined).then(operation);
    this.persistence = pending;
    return pending;
  }
  private persistChoices(): Promise<void> {
    return this.queuePersistence(() =>
      this.deps.write(
        this.deps.choicesPath,
        JSON.stringify({ version: 1, accounts: this.accounts }),
      ),
    );
  }
  private evaluate(): LabsExperimentsSnapshot {
    const state = this.deps.availability();
    const cached =
      state.contextIdentity &&
      Object.prototype.hasOwnProperty.call(this.contexts, state.contextIdentity)
        ? (this.contexts[state.contextIdentity] ?? {})
        : {};
    const choices = this.accountChoices(this.session.scope);
    const ready =
      this.session.ready &&
      (state.snapshot.status === 'not_configured' ||
        state.contextIdentity !== null ||
        Object.keys(state.liveValues).length > 0);
    const availability = (entry: LabsExperiment): ResolvedLabsAvailability =>
      resolveLabsAvailabilityWithSource(
        entry,
        state,
        cached,
        this.deps.availabilityFallback,
      );
    const choice = (id: string): boolean | null =>
      Object.prototype.hasOwnProperty.call(choices, id)
        ? (choices[id] ?? null)
        : null;
    const early = this.entries.find(
      (entry) => entry.id === EARLY_ACCESS_EXPERIMENT_ID,
    );
    const earlyAccessEnabled =
      ready &&
      !!early &&
      resolveLabsExperiment({
        availability: availability(early).availability,
        choice: choice(early.id),
        earlyAccessEnabled: false,
        requiresEarlyAccess: false,
      }).enabled;
    const own = (entry: LabsExperiment): boolean =>
      ready &&
      resolveLabsExperiment({
        availability: availability(entry).availability,
        choice: choice(entry.id),
        earlyAccessEnabled,
        requiresEarlyAccess: entry.requiresEarlyAccess,
      }).enabled;
    return {
      generation: this.generation,
      revision: this.revision,
      scope: this.session.scope,
      ready,
      choicesReady: this.choicesReady,
      earlyAccessEnabled,
      updatedAt: new Date().toISOString(),
      experiments: this.entries.map((entry) => {
        const resolved = availability(entry);
        // Prerequisites are single level (validateLabsExperiments), so the
        // target's own resolution is its effective state.
        const prerequisite = this.entries.find(
          (candidate) => candidate.id === entry.requiresExperiment,
        );
        const prerequisiteEnabled =
          entry.requiresExperiment === undefined ||
          (!!prerequisite && own(prerequisite));
        const blockedBy = prerequisiteEnabled
          ? undefined
          : entry.requiresExperiment;
        return {
          ...entry,
          pages: [...entry.pages],
          sidebarKeys: [...entry.sidebarKeys],
          availability: resolved.availability,
          availabilitySource: resolved.source,
          choice: choice(entry.id),
          ...(!ready
            ? { listed: false, enabled: false }
            : resolveLabsExperiment({
                availability: resolved.availability,
                choice: choice(entry.id),
                earlyAccessEnabled,
                requiresEarlyAccess: entry.requiresEarlyAccess,
                prerequisiteEnabled,
              })),
          ...(blockedBy === undefined ? {} : { blockedBy }),
        };
      }),
    };
  }
  private publish(): void {
    this.revision++;
    this.snapshot = this.evaluate();
    try {
      this.deps.mirror(this.snapshot.earlyAccessEnabled);
    } catch (error) {
      this.deps.diagnostic(error);
    }
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(this.getSnapshot());
      } catch (error) {
        this.deps.diagnostic(error);
      }
    }
  }
}

function readCache(path: string): unknown {
  try {
    if (statSync(path).size > 512 * 1024) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    return null;
  }
}
export function labsExperimentRegistry(): readonly LabsExperiment[] {
  if (__CANOPY_E2E__ && process.env.CANOPY_E2E_LABS_EXPERIMENTS)
    return [
      ...LABS_EXPERIMENTS,
      ...parseLabsExperimentFixtures(
        JSON.parse(process.env.CANOPY_E2E_LABS_EXPERIMENTS),
      ),
    ];
  return LABS_EXPERIMENTS;
}
export function labsExperimentStorageDependencies(): Pick<
  LabsExperimentsDependencies,
  | 'choicesPath'
  | 'availabilityPath'
  | 'pendingSyncPath'
  | 'read'
  | 'write'
  | 'mirror'
> {
  return {
    choicesPath: getLabsExperimentChoicesPath(),
    pendingSyncPath: getLabsExperimentPendingSyncPath(),
    availabilityPath: getLabsExperimentAvailabilityCachePath(),
    read: readCache,
    write: async (path, data): Promise<void> => {
      await mkdir(dirname(path), { recursive: true });
      await writeFileAtomically(path, data, {
        durable: true,
        encoding: 'utf8',
        mode: 0o600,
      });
    },
    mirror: setExperimentalFeaturesEnabled,
  };
}
