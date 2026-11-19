import { getLabsExperimentsService } from '../services/labs-experiments-runtime';

export interface BotsExperimentSnapshot {
  ready: boolean;
  experiments: readonly { id: string; enabled: boolean }[];
}

export function createBotsExperimentGate(
  readSnapshot: () => BotsExperimentSnapshot,
): () => boolean {
  return (): boolean => {
    try {
      const snapshot = readSnapshot();
      return (
        snapshot.ready &&
        snapshot.experiments.some(
          (entry) => entry.id === 'bots' && entry.enabled,
        )
      );
    } catch {
      return false;
    }
  };
}

const gate = createBotsExperimentGate(() =>
  getLabsExperimentsService().getSnapshot(),
);

export function isBotsExperimentEnabled(): boolean {
  return gate();
}
