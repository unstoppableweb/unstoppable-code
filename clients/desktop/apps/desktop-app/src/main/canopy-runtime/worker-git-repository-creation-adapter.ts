import {
  createWorkerGitRepositoryCreationHandlers,
  type WorkerGitRepositoryCreationHandlers,
  type WorkerGitRepositoryCreationHost,
} from '@canopy/core-runtime/node/git';
import {
  cloneRepo,
  cloneRepoWithLiveProgress,
  initGitRepo,
  initLocalRepo,
} from '../lib/git';
import {
  consumeRepositoryCreationBinding,
  type RepositoryCreationEffect,
} from './worker-git-repository-creation-binding';

// The lib/git helpers stay the effect ports, CAN-7169's clone refusal and
// its existedBefore cleanup included.
function runEffect({
  operation,
  effect,
}: RepositoryCreationEffect): Promise<void> {
  if (operation === 'worker.git.repository.initialize')
    return effect.kind === 'empty'
      ? initGitRepo(effect.directory)
      : initLocalRepo(effect.directory, effect.name);
  return effect.kind === 'clone'
    ? cloneRepo(effect.url, effect.destination, {
        signal: effect.signal,
        destinationCreatedByRequest: effect.destinationCreatedByRequest,
      })
    : cloneRepoWithLiveProgress(effect.url, effect.destination, {
        signal: effect.signal,
        onProgress: effect.onProgress,
      });
}

const host: WorkerGitRepositoryCreationHost = {
  consume: (id, operation) => {
    const staged = consumeRepositoryCreationBinding(id, operation);
    return () => runEffect(staged);
  },
};
export function createWorkerGitRepositoryCreationAdapter(): WorkerGitRepositoryCreationHandlers {
  return createWorkerGitRepositoryCreationHandlers(host);
}
