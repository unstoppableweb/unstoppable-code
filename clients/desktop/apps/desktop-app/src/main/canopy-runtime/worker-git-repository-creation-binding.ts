import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { WorkerGitRepositoryCreationName } from '@canopy/core-runtime/node/git';
import type { GitCloneProgressUpdate } from '../lib/git-clone-progress';

/** Which lib/git helper the instruction runs, with its trusted host inputs. */
export type RepositoryInitializeEffect =
  /** `git init` in an existing folder (initGitRepo). */
  | { kind: 'empty'; directory: string }
  /** `git init` plus the seeded initial commit (initLocalRepo). */
  | { kind: 'seeded'; directory: string; name: string };
export type RepositoryCloneEffect =
  | {
      kind: 'clone';
      url: string;
      destination: string;
      signal?: AbortSignal;
      /** This request reserved `destination` empty, so a refused clone may remove it. */
      destinationCreatedByRequest?: boolean;
    }
  | {
      kind: 'live-progress';
      url: string;
      destination: string;
      signal?: AbortSignal;
      onProgress: (update: GitCloneProgressUpdate) => void;
    };
export type RepositoryCreationEffect =
  | {
      operation: 'worker.git.repository.initialize';
      effect: RepositoryInitializeEffect;
    }
  | { operation: 'worker.git.repository.clone'; effect: RepositoryCloneEffect };

interface RepositoryCreationBinding {
  readonly id: string;
  readonly staged: RepositoryCreationEffect;
  active: boolean;
  consumed: boolean;
}
const bindings = new AsyncLocalStorage<RepositoryCreationBinding>();

export function consumeRepositoryCreationBinding(
  id: string,
  operation: WorkerGitRepositoryCreationName,
): RepositoryCreationEffect {
  const binding = bindings.getStore();
  if (
    !binding ||
    !binding.active ||
    binding.consumed ||
    binding.id !== id ||
    binding.staged.operation !== operation
  )
    throw new CanopyOperationError({
      kind: 'failed_precondition',
      code: 'worker.git.repository.bindingUnavailable',
      message: 'The local Git request binding is unavailable.',
      retry: { kind: 'never' },
    });
  binding.consumed = true;
  return binding.staged;
}

/** The effect is a trusted host input, scoped to one instruction, never transport input. */
export async function withRepositoryCreationBinding<Result>(
  staged: RepositoryCreationEffect,
  run: (bindingId: string) => Promise<Result>,
): Promise<Result> {
  const binding: RepositoryCreationBinding = {
    id: randomUUID(),
    staged,
    active: true,
    consumed: false,
  };
  try {
    return await bindings.run(binding, () => run(binding.id));
  } finally {
    binding.active = false;
  }
}
