import { useEffect, useState } from 'react';
import { selectableOllamaModels } from '@canopy/desktop-shared/lib/default-model-lane';
import {
  resolveKnownModel,
  type OllamaState,
} from '@canopy/desktop-shared/types';
import type { BillingReadinessFactState } from '@canopy/app-state/provider-choice';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { setRendererOllamaReadyModels } from '@/stores/billingLaneRuntime';

function readyModelsOf(state: OllamaState): readonly string[] {
  // A managed install whose executable is gone keeps its model cache; those
  // models cannot run, matching main's `peekInstalledModels`.
  if (state.mode === 'managed' && !state.installation.ready) return [];
  return selectableOllamaModels(
    state.models,
    (model) => resolveKnownModel(model) !== undefined,
  );
}

/**
 * Whether Ollama can run a chat here: installed with at least one model this
 * app can select. Reads `getOllamaState()` once after first paint and follows
 * `onOllamaStatus`, never the cached registry alone, and publishes the ready
 * models to `billingLaneRuntime` so the Ollama-only default uses the same
 * predicate. `unknown` until the first answer; a read that fails (Ollama off
 * in this build, or the server erroring) settles `unavailable`, so this fact
 * can never hold the gate open forever.
 *
 * Mount once per window, from the readiness sync.
 */
export function useOllamaReadiness(): BillingReadinessFactState {
  const [readyModels, setReadyModels] = useState<readonly string[] | undefined>(
    undefined,
  );
  useEffect(() => {
    let cancelled = false;
    const apply = (models: readonly string[]): void => {
      if (cancelled) return;
      setReadyModels(models);
      setRendererOllamaReadyModels(models);
    };
    const offStatus = window.api.onOllamaStatus((state) => {
      apply(readyModelsOf(state));
    });
    // Off the startup critical path: the state read can touch the local
    // server, and nothing depends on it before the first composer paints.
    const timer = window.setTimeout(() => {
      window.api
        .getOllamaState()
        .then((state) => apply(readyModelsOf(state)))
        .catch((error: unknown) => {
          // Classified like Settings › Ollama's own read. Readiness has no
          // surface for it: Ollama off in this build, or a server that errors,
          // settles `unavailable` so this fact never holds the gate open.
          void toAppError(resolveClientAppError(error));
          apply([]);
        });
    }, 0);
    return (): void => {
      cancelled = true;
      window.clearTimeout(timer);
      offStatus();
    };
  }, []);
  if (readyModels === undefined) return 'unknown';
  return readyModels.length > 0 ? 'ready' : 'unavailable';
}
