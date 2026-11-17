import { create } from 'zustand';
import {
  CORE_CATALOG_SNAPSHOT_GET_SCHEMA_REVISION,
  CatalogSnapshotGetResultSchema,
} from '@canopy/protocol/canopy-core';
import type {
  ModelCatalog,
  ModelCatalogOption,
  ModelLibraryAccess,
} from '@canopy/protocol/models';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import {
  cloudChatModels,
  cloudChatPickerModels,
  type CoreCoworkInvoker,
} from '@canopy/app-state/core-cowork';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { ThinkingLevel } from '@canopy/protocol/thinking';
import { webCoreLocalId } from '@/lib/chat-authority';
import { isServedThinkingLevel } from './translate';

/**
 * The models a web core workspace runs, from `core.catalog.snapshot.get`
 * (CAN-6175 R5). A cloud chat's model id is a Core model definition id the
 * desktop model registry does not know, so its label, thinking levels and
 * fast mode come from here. Read at revision 2 and projected as the web's
 * picker projects them, so the rows group by vendor and family and carry
 * the AI Credits source, the Legacy flag and the default (CAN-6753).
 */
export interface WebCoreModelCatalogState {
  /** Each workspace's models by id, keyed by the qualified workspace id. */
  readonly byProject: Readonly<
    Record<string, ReadonlyMap<string, ModelCatalogOption>>
  >;
  /** Workspaces whose catalog every read failed for, until Try again. */
  readonly failed: Readonly<Record<string, true>>;
  /**
   * The picker's rows for a workspace whose owner's library keeps models
   * locked, with the access that unlocks them (CAN-6937). Only the picker
   * reads them: a locked model is never in `byProject`, so nothing a chat
   * runs, restores or defaults to can be one.
   */
  readonly lockedByProject: Readonly<Record<string, WebCoreLockedModels>>;
}

/** A workspace's picker rows with locked models, and how to unlock them. */
export interface WebCoreLockedModels {
  readonly access: Exclude<ModelLibraryAccess, 'unlocked'>;
  readonly models: ModelCatalog;
}

export const useWebCoreModelCatalogStore = create<WebCoreModelCatalogState>(
  () => ({ byProject: {}, failed: {}, lockedByProject: {} }),
);

/** Waits before the second and third read of a catalog that failed. */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000];

/** The longest a Retry-After may hold a read back, so retrying stays bounded. */
const MAX_RETRY_DELAY_MS = 30_000;

interface CatalogReadOptions {
  /** Waits between reads; a test passes its own. */
  readonly wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A catalog read that failed, and whether reading again may help. */
class CatalogReadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** How long the web core asked to wait (its Retry-After), if it did. */
    readonly delayMs?: number,
  ) {
    super(message);
    this.name = 'CatalogReadError';
  }
}

const reads = new Map<string, Promise<void>>();
/** Each workspace's newest re-read: an older one that answers later is dropped. */
const rereads = new Map<string, number>();
/** Moves when the connection goes offline: an older read publishes nothing. */
let generation = 0;

async function readCatalog(
  connection: CoreCoworkInvoker,
  workspaceId: string,
): Promise<{
  readonly models: Map<string, ModelCatalogOption>;
  readonly locked: WebCoreLockedModels | null;
}> {
  const reply = await connection.request('core.catalog.snapshot.get', {
    scope: { workspaceId },
    kinds: ['model'],
    includeUnavailable: false,
    // Revision 2 answers the hosted catalog the web's picker reads.
    revision: CORE_CATALOG_SNAPSHOT_GET_SCHEMA_REVISION,
  });
  if (!reply.ok)
    throw new CatalogReadError(
      reply.error.message,
      reply.error.retry?.kind !== 'never',
      reply.error.retry === undefined || reply.error.retry.kind === 'never'
        ? undefined
        : reply.error.retry.delayMs,
    );
  const parsed = CatalogSnapshotGetResultSchema.safeParse(reply.value);
  if (!parsed.success)
    throw new CatalogReadError(
      'The web core returned an invalid catalog.',
      false,
    );
  return {
    models: new Map(
      cloudChatModels(parsed.data.entries, parsed.data.cloudModels).map(
        (model) => [model.id, model],
      ),
    ),
    locked: cloudChatPickerModels(parsed.data.cloudModels),
  };
}

/**
 * Reads a web core workspace's models once; a later call reuses the read in
 * flight or its result. A read that fails retryably, as a 503 does, is read
 * again after a wait, three reads in all (CAN-6615). One that still fails is
 * reported and marks the workspace failed, so the composer says so with Try
 * again; a later call reads nothing until Try again.
 */
export function loadWebCoreModelCatalog(
  projectId: string,
  invoker: () => CoreCoworkInvoker | null,
  options: CatalogReadOptions = {},
): Promise<void> {
  const workspaceId = webCoreLocalId(projectId);
  if (workspaceId === null) return Promise.resolve();
  const state = useWebCoreModelCatalogStore.getState();
  if (projectId in state.byProject || projectId in state.failed)
    return Promise.resolve();
  const inFlight = reads.get(projectId);
  if (inFlight !== undefined) return inFlight;
  if (invoker() === null) return Promise.resolve();
  const wait = options.wait ?? sleep;
  const readGeneration = generation;
  const current = (): boolean => readGeneration === generation;
  const read: Promise<void> = (async (): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      const connection = invoker();
      if (connection === null || !current()) return;
      try {
        const read = await readCatalog(connection, workspaceId);
        if (!current()) return;
        publishCatalog(projectId, read);
        return;
      } catch (error) {
        const backoff = RETRY_DELAYS_MS[attempt];
        const retryable =
          !(error instanceof CatalogReadError) || error.retryable;
        if (retryable && backoff !== undefined) {
          // At least as long as the web core asked, within the bound.
          const asked =
            error instanceof CatalogReadError ? (error.delayMs ?? 0) : 0;
          await wait(Math.min(Math.max(backoff, asked), MAX_RETRY_DELAY_MS));
          continue;
        }
        reportClientAppError(error);
        if (!current()) return;
        useWebCoreModelCatalogStore.setState((before) => ({
          failed: { ...before.failed, [projectId]: true },
        }));
        return;
      }
    }
  })().finally(() => {
    if (reads.get(projectId) === read) reads.delete(projectId);
  });
  reads.set(projectId, read);
  return read;
}

function publishCatalog(
  projectId: string,
  { models, locked }: Awaited<ReturnType<typeof readCatalog>>,
): void {
  useWebCoreModelCatalogStore.setState((before) => ({
    byProject: { ...before.byProject, [projectId]: models },
    failed: withoutKey(before.failed, projectId),
    lockedByProject:
      locked === null
        ? withoutKey(before.lockedByProject, projectId)
        : { ...before.lockedByProject, [projectId]: locked },
  }));
}

/**
 * Reads a workspace's models again once the owner's library may have
 * unlocked some (CAN-6937). The rows shown stay until the new read lands,
 * and a read that fails keeps them; only the newest re-read lands, so an
 * older answer that arrives later never locks a model again. A workspace
 * whose first read is still in flight is read again once that read settles,
 * since its answer may predate the unlock.
 */
export function reloadWebCoreModelCatalog(
  projectId: string,
  invoker: () => CoreCoworkInvoker | null,
): Promise<void> {
  const firstRead = reads.get(projectId);
  if (firstRead !== undefined)
    return firstRead.then(() => reloadWebCoreModelCatalog(projectId, invoker));
  const workspaceId = webCoreLocalId(projectId);
  const connection = invoker();
  if (
    workspaceId === null ||
    connection === null ||
    !(projectId in useWebCoreModelCatalogStore.getState().byProject)
  )
    return Promise.resolve();
  const readGeneration = generation;
  const reread = (rereads.get(projectId) ?? 0) + 1;
  rereads.set(projectId, reread);
  return readCatalog(connection, workspaceId).then(
    (read) => {
      if (readGeneration === generation && rereads.get(projectId) === reread)
        publishCatalog(projectId, read);
    },
    (error: unknown) => {
      reportClientAppError(error);
    },
  );
}

/**
 * Reads again every workspace whose picker lists locked models, and every
 * workspace whose first read is still in flight, which may list some.
 */
export function reloadLockedWebCoreModelCatalogs(
  invoker: () => CoreCoworkInvoker | null,
): Promise<void> {
  const projectIds = new Set([
    ...Object.keys(useWebCoreModelCatalogStore.getState().lockedByProject),
    ...reads.keys(),
  ]);
  return Promise.all(
    [...projectIds].map((projectId) =>
      reloadWebCoreModelCatalog(projectId, invoker),
    ),
  ).then(() => undefined);
}

/** Try again on a workspace whose catalog could not be read. */
export function retryWebCoreModelCatalog(
  projectId: string,
  invoker: () => CoreCoworkInvoker | null,
  options: CatalogReadOptions = {},
): Promise<void> {
  useWebCoreModelCatalogStore.setState((before) => ({
    failed: withoutKey(before.failed, projectId),
  }));
  return loadWebCoreModelCatalog(projectId, invoker, options);
}

function withoutKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Readonly<Record<string, T>> {
  if (!(key in record)) return record;
  return Object.fromEntries(
    Object.entries(record).filter(([each]) => each !== key),
  );
}

/** A web core chat's model as its workspace's catalog lists it. */
export function webCoreModelOption(
  state: WebCoreModelCatalogState,
  projectId: string,
  model: string | undefined,
): ModelCatalogOption | undefined {
  return model === undefined
    ? undefined
    : state.byProject[projectId]?.get(model);
}

/**
 * The thinking levels a web core chat's model runs, from its catalog: none
 * until the catalog is read, so the composer never offers a level the web
 * core would refuse.
 */
export function webCoreThinkingLevels(
  state: WebCoreModelCatalogState,
  projectId: string,
  model: string | undefined,
): readonly ThinkingLevel[] {
  return (
    webCoreModelOption(
      state,
      projectId,
      model,
    )?.supportedThinkingLevels?.filter(isServedThinkingLevel) ?? []
  );
}

/**
 * The name the model picker shows for a web core chat's model: its catalog
 * label once the catalog is read, its id before, never a placeholder.
 */
export function webCoreModelLabel(
  state: WebCoreModelCatalogState,
  projectId: string,
  model: string | undefined,
): string | undefined {
  return webCoreModelOption(state, projectId, model)?.label ?? model;
}

const NO_MODELS: ModelCatalog = [];

/**
 * The picker's rows for a cloud chat whose model is `model`. The shared
 * picker shows a row marked as the default when the chat names no model, so
 * the owner's default stays unmarked until the web core names one: a cloud
 * chat with no model reads Model (CAN-6365). Its rows are otherwise the
 * catalog's (CAN-6753).
 */
export function webCorePickerModels(
  models: ModelCatalog,
  model: string | undefined,
): ModelCatalog {
  if (model !== undefined || !models.some((row) => row.isDefault === true))
    return models;
  return models.map((row) => {
    if (row.isDefault !== true) return row;
    const unmarked: ModelCatalogOption = { ...row };
    delete unmarked.isDefault;
    return unmarked;
  });
}

/**
 * A web core workspace's models as the shared model picker lists them: with
 * the owner's locked models among them, as the web's picker lists them, when
 * the library keeps some locked and the composer can unlock them (CAN-6937).
 */
export function webCoreModelList(
  state: WebCoreModelCatalogState,
  projectId: string,
  withLocked: boolean,
): ModelCatalog {
  const models = state.byProject[projectId];
  if (models === undefined) return NO_MODELS;
  const locked = withLocked ? state.lockedByProject[projectId] : undefined;
  return locked?.models ?? [...models.values()];
}

/**
 * The owner's library access when its picker lists locked models, for the
 * picker's unlock action; undefined otherwise, and the picker locks nothing.
 */
export function webCoreLockedAccess(
  state: WebCoreModelCatalogState,
  projectId: string,
): WebCoreLockedModels['access'] | undefined {
  return state.byProject[projectId] === undefined
    ? undefined
    : state.lockedByProject[projectId]?.access;
}

const SET_MODEL_PROVIDERS: readonly AgentProviderType[] = [
  'claude',
  'codex',
  'ollama',
  'cursor',
  'opencode',
];

/**
 * The provider `chat.set_model` names for a catalog model, as the web's
 * cloud chat picker names it: its provider or harness, else Claude.
 */
export function webCoreModelProvider(
  option: ModelCatalogOption,
): AgentProviderType {
  return (
    SET_MODEL_PROVIDERS.find(
      (provider) => provider === option.provider || provider === option.harness,
    ) ?? 'claude'
  );
}

/** Forgets every workspace's models: the connection went offline. */
export function clearWebCoreModelCatalog(): void {
  generation += 1;
  reads.clear();
  rereads.clear();
  useWebCoreModelCatalogStore.setState({
    byProject: {},
    failed: {},
    lockedByProject: {},
  });
}
