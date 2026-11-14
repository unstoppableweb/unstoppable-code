import type { CostClient } from '@canopy/app-core';
import type { CostScopeRef, CostViewResult } from '@canopy/protocol/cost-view';
import type { CostApi } from '@canopy/desktop-shared/types';
import { webCoreLocalId } from '../chat-authority';
import { createWebCoreCostClient } from './web-core-cost-client';

/*
 * The desktop cost client: the preload's cost API, which reads through main's
 * `core.cost.*` operations. `CostClient` calls resolve and never reject, so a
 * transport failure (an IPC rejection, or a preload without the cost API)
 * becomes a result the views can tell apart from "no cost yet".
 */

const COST_READ_FAILED = "Couldn't read cost.";

const noop = (): void => undefined;

function readError<Value>(error: unknown): CostViewResult<Value> {
  return {
    status: 'error',
    reason: 'UNKNOWN',
    message:
      error instanceof Error && error.message.length > 0
        ? error.message
        : COST_READ_FAILED,
  };
}

const RUNTIME_UNAVAILABLE: Extract<
  CostViewResult<never>,
  { status: 'unavailable' }
> = { status: 'unavailable', reason: 'runtime_unavailable' };

/** The preload cost API, or `undefined` in a host without it. */
function defaultCostApi(): CostApi | undefined {
  return typeof window === 'undefined' ? undefined : window.api?.cost;
}

/**
 * Runs one read against the API, folding a missing API into
 * `runtime_unavailable` and a rejection into an `UNKNOWN` error.
 */
async function read<Value>(
  api: CostApi | undefined,
  call: (api: CostApi) => Promise<CostViewResult<Value>>,
): Promise<CostViewResult<Value>> {
  if (api === undefined) return RUNTIME_UNAVAILABLE;
  try {
    return await call(api);
  } catch (error) {
    return readError(error);
  }
}

export function createIpcCostClient(
  api: () => CostApi | undefined = defaultCostApi,
): CostClient {
  return {
    getScope: (request) => read(api(), (cost) => cost.getScope(request)),
    getChat: (request) => read(api(), (cost) => cost.getChat(request)),
    getPipelineRun: (request) =>
      read(api(), (cost) => cost.getPipelineRun(request)),
    refresh: (request) => read(api(), (cost) => cost.refresh(request)),
    watchScope: (scope): (() => void) => {
      const cost = api();
      if (cost === undefined) return noop;
      let release: () => void;
      try {
        release = cost.watchScope(scope);
      } catch {
        return noop;
      }
      let released = false;
      return (): void => {
        if (released) return;
        released = true;
        release();
      };
    },
    subscribeUpdates: (handler): (() => void) => {
      const cost = api();
      if (cost === undefined) return noop;
      try {
        return cost.onUpdated(handler);
      } catch {
        return noop;
      }
    },
  };
}

/**
 * The cost client a scope reads through: a cloud task's (`web-core:` ids)
 * goes to the web core over the relay, every other scope to main's cost
 * index, so main never sees a cloud id (CAN-6180).
 */
export function createScopeRoutedCostClient(
  local: CostClient,
  cloud: CostClient,
): CostClient {
  const pick = (scope: CostScopeRef): CostClient =>
    webCoreLocalId(scope.projectId) === null ? local : cloud;
  return {
    getScope: (request) => pick(request.scope).getScope(request),
    getChat: (request) => pick(request.scope).getChat(request),
    getPipelineRun: (request) => pick(request.scope).getPipelineRun(request),
    refresh: (request) => pick(request.scope).refresh(request),
    watchScope: (scope) => pick(scope).watchScope(scope),
    // Only main's cost index announces updates.
    subscribeUpdates: (handler) => local.subscribeUpdates(handler),
  };
}

/** The renderer's one cost client. */
export const desktopCostClient: CostClient = createScopeRoutedCostClient(
  createIpcCostClient(),
  createWebCoreCostClient(() =>
    typeof window === 'undefined' ? undefined : window.canopyCore,
  ),
);
