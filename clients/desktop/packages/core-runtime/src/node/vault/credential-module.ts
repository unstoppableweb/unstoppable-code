import {
  CORE_INTEGRATION_CREDENTIAL_INSTRUCTIONS,
  type CoreIntegrationCredentialResult,
} from '@canopy/protocol/canopy-core';
import {
  defineRuntimeModule,
  type RuntimeModule,
} from '../../kernel/runtime-profile-graph';
import { CanopyOperationError } from '../../runtime/errors';
import type { VaultIoClass, VaultMutationStep } from '../../vault/contracts';
import type {
  GitHubCredentialAuthority,
  GitHubCredentialIdentity,
  GitHubCredentialMutation,
} from './github-credential-authority';

function refused(
  code: 'storageUnavailable' | 'writeFailed' | 'removeFailed',
  storage?: { readonly step: VaultMutationStep; readonly io: VaultIoClass },
): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'unavailable',
    code: `core.integration.credential.${code}`,
    message: 'Credential storage could not complete the request.',
    // Closed vault enums only; never a path, errno text or message.
    ...(storage && { details: { step: storage.step, io: storage.io } }),
    retry: { kind: 'never' },
  });
}
function unsupported(): never {
  throw new CanopyOperationError({
    kind: 'capability_unavailable',
    message: 'This credential kind is not served by this core.',
    retry: { kind: 'never' },
  });
}
function result(
  outcome: GitHubCredentialMutation,
  configured: boolean,
): CoreIntegrationCredentialResult {
  if (
    outcome.kind === 'committed' ||
    outcome.kind === 'unchanged' ||
    (!configured && outcome.kind === 'absent')
  )
    return { credentialKind: 'github.pat', configured };
  if (
    outcome.kind === 'blocked' &&
    ['locked', 'key_missing', 'unavailable'].includes(outcome.reason)
  )
    throw refused('storageUnavailable', outcome.storage);
  throw refused(configured ? 'writeFailed' : 'removeFailed');
}

export function createIntegrationCredentialModule(options: {
  readonly authority: GitHubCredentialAuthority;
  readonly identity: GitHubCredentialIdentity;
  readonly legacyGeneration: (
    source: GitHubCredentialIdentity,
  ) => Promise<string | null>;
}): RuntimeModule {
  const identity = { ...options.identity };
  return defineRuntimeModule({
    name: 'core.integration.credentials',
    plane: 'core',
    services: [],
    definitions: {
      queries: {},
      instructions: CORE_INTEGRATION_CREDENTIAL_INSTRUCTIONS,
      streams: {},
    },
    handlers: {
      queries: {},
      streams: {},
      instructions: {
        'core.integration.credential.set': async ({
          credentialKind,
          secret,
          expectedLegacyGeneration,
        }) => {
          if (credentialKind !== 'github.pat') return unsupported();
          if (!expectedLegacyGeneration) throw refused('writeFailed');
          let generation: string | null;
          try {
            generation = await options.legacyGeneration(identity);
          } catch {
            throw refused('storageUnavailable');
          }
          if (generation === null || generation !== expectedLegacyGeneration)
            throw refused('writeFailed');
          const material = Buffer.from(secret, 'utf8');
          try {
            return result(
              await options.authority.set({
                source: identity,
                legacyGeneration: generation,
                material,
              }),
              true,
            );
          } finally {
            material.fill(0);
          }
        },
        'core.integration.credential.clear': async ({ credentialKind }) => {
          if (credentialKind !== 'github.pat') return unsupported();
          return result(await options.authority.clear(), false);
        },
      },
    },
  });
}
