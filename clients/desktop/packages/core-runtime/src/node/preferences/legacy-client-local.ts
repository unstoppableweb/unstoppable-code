import {
  ConfigLegacyClientLocalGetResultSchema,
  type ConfigLegacyClientLocalGetResult,
} from '@canopy/protocol/canopy-core/core';
import { CLIENT_LOCAL_PREFERENCE_KEYS } from './client-local-keys';
import { pickStoredKeys } from './preserve-stored-keys';
import type { PreferencesRepository } from './repository';

/**
 * `core.config.legacyClientLocal.get` (CAN-7956): the client-local values the
 * document keeps a frozen copy of, by the document's own recovery verdict, as
 * Electron main's seed source reads them. `pending` serves this session only.
 */
export async function readLegacyClientLocal<T extends object>(
  repository: Pick<
    PreferencesRepository<T>,
    'read' | 'isRecoveryLatched' | 'hasPersistedState'
  >,
): Promise<ConfigLegacyClientLocalGetResult> {
  const stored = await repository.read('persisted');
  const values = pickStoredKeys(stored, CLIENT_LOCAL_PREFERENCE_KEYS);
  if (repository.isRecoveryLatched())
    return ConfigLegacyClientLocalGetResultSchema.parse({
      kind: 'pending',
      served: values,
    });
  if (!(await repository.hasPersistedState())) return { kind: 'missing' };
  return ConfigLegacyClientLocalGetResultSchema.parse({ kind: 'read', values });
}
