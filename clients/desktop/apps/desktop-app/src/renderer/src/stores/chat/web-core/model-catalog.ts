import { create } from 'zustand';
import { CatalogSnapshotGetResultSchema } from '@canopy/protocol/canopy-core';
import type { ModelCatalog, ModelCatalogOption } from '@canopy/protocol/models';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import {
  mapCloudChatCatalog,
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
 * fast mode come from here.
 */
export interface WebCoreModelCatalogState {
  /** Each workspace's models by id, keyed by the qualified workspace id. */
  readonly byProject: Readonly<
    Record<string, ReadonlyMap<string, ModelCatalogOption>>
  >;
}

export const useWebCoreModelCatalogStore = create<WebCoreModelCatalogState>(
  () => ({ byProject: {} }),
);

const reads = new Map<string, Promise<void>>();
/** Moves when the connection goes offline: an older read publishes nothing. */
let generation = 0;

/**
 * Reads a web core workspace's models once; a later call reuses the read in
 * flight or its result. A failed read is reported and read again next time.
 */
export function loadWebCoreModelCatalog(
  projectId: string,
  invoker: () => CoreCoworkInvoker | null,
): Promise<void> {
  const workspaceId = webCoreLocalId(projectId);
  if (workspaceId === null) return Promise.resolve();
  if (projectId in useWebCoreModelCatalogStore.getState().byProject)
    return Promise.resolve();
  const inFlight = reads.get(projectId);
  if (inFlight !== undefined) return inFlight;
  const connection = invoker();
  if (connection === null) return Promise.resolve();
  const readGeneration = generation;
  const read: Promise<void> = connection
    .request('core.catalog.snapshot.get', {
      scope: { workspaceId },
      kinds: ['model'],
      includeUnavailable: false,
    })
    .then((reply) => {
      if (!reply.ok) throw new Error(reply.error.message);
      const parsed = CatalogSnapshotGetResultSchema.safeParse(reply.value);
      if (!parsed.success)
        throw new Error('The web core returned an invalid catalog.');
      const models = new Map(
        mapCloudChatCatalog(parsed.data.entries).models.map((model) => [
          model.id,
          model,
        ]),
      );
      if (readGeneration !== generation) return;
      useWebCoreModelCatalogStore.setState((state) => ({
        byProject: { ...state.byProject, [projectId]: models },
      }));
    })
    .catch((error: unknown) => {
      reportClientAppError(error);
    })
    .finally(() => {
      if (reads.get(projectId) === read) reads.delete(projectId);
    });
  reads.set(projectId, read);
  return read;
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

/** A web core workspace's models as the shared model picker lists them. */
export function webCoreModelList(
  state: WebCoreModelCatalogState,
  projectId: string,
): ModelCatalog {
  const models = state.byProject[projectId];
  return models === undefined ? NO_MODELS : [...models.values()];
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
  useWebCoreModelCatalogStore.setState({ byProject: {} });
}
