export interface WorkspaceRecoveryDismissalStore {
  readonly getSnapshot: () => ReadonlySet<string>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dismiss: (keys: readonly string[]) => void;
}

function createDismissalStore(): WorkspaceRecoveryDismissalStore {
  let dismissed: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: (): ReadonlySet<string> => dismissed,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dismiss: (keys: readonly string[]): void => {
      if (keys.every((key) => dismissed.has(key))) return;
      // Like archive recovery, acknowledgements only grow. Removing entries or
      // observing hidden/unavailable status never revives acknowledged IDs.
      dismissed = new Set([...dismissed, ...keys]);
      notify();
    },
  };
}

const stores = new WeakMap<
  object,
  Map<string | null, WorkspaceRecoveryDismissalStore>
>();

/** Memory only: remounts keep dismissal; reload restores the recovery action. */
export function getWorkspaceRecoveryDismissalStore(
  scope: object,
  namespace: string | null,
): WorkspaceRecoveryDismissalStore {
  let scoped = stores.get(scope);
  if (!scoped) {
    scoped = new Map();
    stores.set(scope, scoped);
  }
  let current = scoped.get(namespace);
  if (!current) {
    current = createDismissalStore();
    scoped.set(namespace, current);
  }
  return current;
}
