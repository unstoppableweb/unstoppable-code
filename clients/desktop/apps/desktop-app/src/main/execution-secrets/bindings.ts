import { brandEnvName } from '@canopy/execution-engine/brand/env';
import { resolveLinearToken } from '../lib/linear-auth';
import {
  EXECUTION_SECRET_BINDINGS_MAX,
  type ExecutionSecretBinding,
  type WorkerScriptContext,
} from '@canopy/protocol/canopy-core';
import {
  ExecutionSecretStageError,
  executionSecretUnavailableError,
} from '@canopy/core-runtime/node/execution-secrets';
import { resolveEnvironmentSecretSlots } from '@canopy/desktop-shared/lib/user-environment';
import type {
  ResolveEnvironmentRequest,
  UserEnvironmentEntry,
} from '@canopy/execution-engine/types/user-environment';
import { readEnvironmentConfig } from '../lib/user-environment-store';
import {
  environmentSecretSlot,
  ENVIRONMENT_SECRET_RECORD,
} from '../lib/environment-secret-view';
import { storedSecretRef } from '../lib/stored-secrets';
import { readGitHubPatForExecution } from '../lib/github-pat-env';
import { readSharedContainerRunEnvironment } from '../shared-containers/run-env-store';
import { isAllowedSharedContainerRunEnvName } from '../lib/shared-container-run-env';

async function environmentBindings(
  request: ResolveEnvironmentRequest,
): Promise<ExecutionSecretBinding[]> {
  try {
    const { data } = await readEnvironmentConfig();
    return resolveEnvironmentSecretSlots(data, request).map(
      ({ key, environmentId }) => ({
        name: key,
        source: {
          kind: 'stored-secret',
          family: 'environment',
          record: ENVIRONMENT_SECRET_RECORD,
          ref: storedSecretRef(
            'environment',
            ENVIRONMENT_SECRET_RECORD,
            environmentSecretSlot(environmentId, key),
          ),
        },
      }),
    );
  } catch {
    throw executionSecretUnavailableError();
  }
}
/**
 * Whether a GitHub PAT should be bound. `refuse` turns an unreadable stored
 * PAT into the fixed unavailable error; `omit` leaves the binding out.
 */
function githubPatConfigured(onUnreadable: 'omit' | 'refuse'): boolean {
  try {
    return readGitHubPatForExecution() !== null;
  } catch {
    if (onUnreadable === 'omit') return false;
    throw executionSecretUnavailableError();
  }
}
function checkedBindings(
  bindings: Iterable<ExecutionSecretBinding>,
): ExecutionSecretBinding[] {
  const byName = new Map<string, ExecutionSecretBinding>();
  for (const binding of bindings) byName.set(binding.name, binding);
  if (byName.size > EXECUTION_SECRET_BINDINGS_MAX)
    throw new ExecutionSecretStageError(
      'invalid_bindings',
      'This work would receive more than 64 secrets, or two with the same name. Mark fewer variables as secret.',
    );
  return Array.from(byName.values());
}
export async function buildScriptSecretBindings(args: {
  context: WorkerScriptContext;
  workspaceId: string | undefined;
  worktreeId: string | undefined;
}): Promise<ExecutionSecretBinding[]> {
  if (args.context.kind === 'shared-container') {
    const record = args.worktreeId;
    if (record === undefined) return [];
    const declared = new Set(args.context.environmentKeys);
    let values: UserEnvironmentEntry[];
    try {
      values = await readSharedContainerRunEnvironment(record);
    } catch {
      throw executionSecretUnavailableError();
    }
    return checkedBindings(
      values
        .filter(
          (entry) =>
            declared.has(entry.key) &&
            isAllowedSharedContainerRunEnvName(entry.key),
        )
        .map(
          (entry): ExecutionSecretBinding => ({
            name: entry.key,
            source: {
              kind: 'stored-secret',
              family: 'shared_container.run_env',
              record,
              ref: storedSecretRef(
                'shared_container.run_env',
                record,
                entry.key,
              ),
            },
          }),
        ),
    );
  }
  const bindings = await environmentBindings({
    runtime: 'canopy',
    ...(args.context.kind !== 'automation-home' &&
    args.workspaceId !== undefined
      ? { workspaceId: args.workspaceId }
      : {}),
  });
  // Scripts keep their best-effort GH_TOKEN: an unreadable PAT omits the
  // binding (the read already reported it) instead of refusing the script.
  if (githubPatConfigured('omit'))
    bindings.push({
      name: 'GH_TOKEN',
      source: { kind: 'integration-token', provider: 'github-pat' },
    });
  return checkedBindings(bindings);
}

export async function buildPipelineSecretBindings(args: {
  workspaceId: string | undefined;
}): Promise<ExecutionSecretBinding[]> {
  const bindings: ExecutionSecretBinding[] = [];
  // A stored but unreadable PAT refuses the run before any step starts.
  if (githubPatConfigured('refuse'))
    bindings.push({
      name: 'GH_TOKEN',
      source: { kind: 'integration-token', provider: 'github-pat' },
    });
  bindings.push(
    ...(await environmentBindings({
      runtime: 'pipeline',
      ...(args.workspaceId !== undefined
        ? { workspaceId: args.workspaceId }
        : {}),
    })),
  );
  if (await resolveLinearToken())
    bindings.push({
      name: brandEnvName('LINEAR_API_KEY'),
      source: { kind: 'integration-token', provider: 'linear' },
    });
  return checkedBindings(bindings);
}
