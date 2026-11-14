export interface WorkspaceStartupBarrier {
  wait: () => Promise<void>;
  complete: () => void;
  cancel: () => void;
  refuse: (error: Error) => void;
}

/** A window may paint before migrations, but its workspace consumers may not. */
export function createWorkspaceStartupBarrier(): WorkspaceStartupBarrier {
  let cancelled = false;
  let complete = (): void => undefined;
  let refuse: (error: Error) => void = (): void => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    complete = resolve;
    refuse = reject;
  });
  // Startup failure can precede the first renderer's subscription.
  void ready.catch(() => undefined);
  return {
    wait: () => ready,
    complete: (): void => {
      if (!cancelled) complete();
    },
    // Keep the loading screen during normal quit, not a spurious root error.
    cancel: (): void => {
      cancelled = true;
    },
    refuse: (error: Error): void => {
      if (!cancelled) refuse(error);
    },
  };
}

export const workspaceStartup: WorkspaceStartupBarrier =
  createWorkspaceStartupBarrier();
