import { CodexCapabilityStore } from '@canopy/execution-engine/node/codex-runtime';
import { getDataDir } from '../lib/paths';

let store: CodexCapabilityStore | null = null;
let garbageCollectionPromise: Promise<void> | null = null;

export function getDesktopCodexCapabilityStore(): CodexCapabilityStore {
  store ??= new CodexCapabilityStore(getDataDir());
  return store;
}

export function collectDesktopCodexCapabilityGarbage(): Promise<void> {
  garbageCollectionPromise ??= getDesktopCodexCapabilityStore()
    .collectGarbage()
    .then(() => undefined)
    .finally(() => {
      garbageCollectionPromise = null;
    });
  return garbageCollectionPromise;
}

export function resetDesktopCodexCapabilityStoreForTests(): void {
  store = null;
  garbageCollectionPromise = null;
}
