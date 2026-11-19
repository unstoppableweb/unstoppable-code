/** Process-wide limits, shared by requested and unsolicited snapshots. */
export function createPortalSnapshotWorkBudget(): {
  section: <T>(work: () => Promise<T>) => Promise<T>;
  expensive: <T>(work: () => Promise<T>) => Promise<T>;
  warm: <T>(work: () => Promise<T>) => Promise<T>;
  setForegroundBusy: (busy: boolean) => void;
} {
  const sections: Array<() => void> = [];
  const expensive: Array<() => void> = [];
  const warming: Array<() => void> = [];
  let activeSections = 0;
  let activeExpensive = 0;
  let foregroundBusy = false;

  const pump = (): void => {
    while (activeSections < 4 && sections.length > 0) sections.shift()?.();
    if (activeExpensive === 0) {
      const next =
        expensive.shift() ?? (!foregroundBusy ? warming.shift() : undefined);
      next?.();
    }
  };
  const run = <T>(
    kind: 'section' | 'expensive' | 'warm',
    work: () => Promise<T>,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const queue =
        kind === 'section'
          ? sections
          : kind === 'expensive'
            ? expensive
            : warming;
      queue.push((): void => {
        if (kind === 'section') activeSections += 1;
        else activeExpensive += 1;
        // Release capacity for success, rejection and synchronous exceptions.
        // Warming yields between worktrees, never mid-subprocess.
        void Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            if (kind === 'section') activeSections -= 1;
            else activeExpensive -= 1;
            pump();
          });
      });
      pump();
    });
  return {
    section: <T>(work: () => Promise<T>): Promise<T> => run('section', work),
    expensive: <T>(work: () => Promise<T>): Promise<T> =>
      run('expensive', work),
    warm: <T>(work: () => Promise<T>): Promise<T> => run('warm', work),
    setForegroundBusy: (busy): void => {
      foregroundBusy = busy;
      pump();
    },
  };
}

export const portalSnapshotWorkBudget = createPortalSnapshotWorkBudget();
