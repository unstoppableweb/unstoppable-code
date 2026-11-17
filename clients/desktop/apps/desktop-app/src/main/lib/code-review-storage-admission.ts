import {
  assertAdmittedWriter,
  STORAGE_OWNERSHIP,
} from '@canopy/core-runtime/storage';
import {
  getCodeReviewRegistryFilePath,
  withCodeReviewStorageIdentity,
} from './paths';

type ReviewNamespace =
  | 'code_review_registry'
  | 'code_review_chats_dir'
  | 'code_review_chats_legacy'
  | 'code_review_state';

/** Current-owner protection, not namespace qualification or a writer transfer. */
export function assertCodeReviewStorageWriter(
  namespace: ReviewNamespace,
  module: string,
): void {
  assertAdmittedWriter(namespace, 'electron_main', module, STORAGE_OWNERSHIP);
}

// A root/key lease spans teardown, never the global registry mutation queue.
const lifecycles = new Map<string, Promise<unknown>>();

export async function withCodeReviewTargetLifecycle<T>(
  registryPath: string,
  scopeKey: string,
  operation: (waited: boolean) => Promise<T>,
): Promise<T> {
  return withCodeReviewStorageIdentity(async () => {
    if (getCodeReviewRegistryFilePath() !== registryPath)
      throw new Error('Code review storage routing changed before admission.');
    const key = JSON.stringify([registryPath, scopeKey]);
    const previous = lifecycles.get(key);
    const next = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => operation(previous !== undefined));
    lifecycles.set(key, next);
    try {
      return await next;
    } finally {
      if (lifecycles.get(key) === next) lifecycles.delete(key);
    }
  });
}
