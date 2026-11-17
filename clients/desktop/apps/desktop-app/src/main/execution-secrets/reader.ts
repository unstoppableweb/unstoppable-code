import { readFile } from 'node:fs/promises';
import type {
  ExecutionSecretRead,
  ExecutionSecretReader,
} from '@canopy/core-runtime/node/execution-secrets';
import type { ExecutionSecretSourceRef } from '@canopy/protocol/canopy-core';
import { readEnvironmentConfig } from '../lib/user-environment-store';
import {
  environmentSecretSlot,
  ENVIRONMENT_SECRET_RECORD,
} from '../lib/environment-secret-view';
import { readSharedContainerRunEnvironment } from '../shared-containers/run-env-store';
import { readGitHubPatForExecution } from '../lib/github-pat-env';
import { resolveLinearToken } from '../lib/linear-auth';
import { storedSecretRef } from '../lib/stored-secrets';
import { getMcpServerFilePath } from '../lib/paths';
import { getChatSecretStore } from '../agent-secrets/chat-secret-store';
import {
  classifyServerDocument,
  readDocument,
  requireMutableState,
} from '../mcp/config-repository-format';
import {
  MCP_OAUTH_CLIENT_SECRET_SLOT,
  mcpServerStoredSecretSlots,
} from '../mcp/server-secret-view';

type StoredSource = Extract<
  ExecutionSecretSourceRef,
  { kind: 'stored-secret' }
>;
async function storedValues(
  source: StoredSource,
): Promise<ReadonlyMap<string, string>> {
  const values = new Map<string, string>();
  if (source.family === 'environment') {
    const { data } = await readEnvironmentConfig();
    for (const environment of data.environments) {
      for (const entry of environment.variables) {
        if (entry.secret === true)
          values.set(
            storedSecretRef(
              'environment',
              ENVIRONMENT_SECRET_RECORD,
              environmentSecretSlot(environment.id, entry.key),
            ),
            entry.value,
          );
      }
    }
  } else if (source.family === 'shared_container.run_env') {
    const entries = await readSharedContainerRunEnvironment(source.record);
    for (const entry of entries)
      values.set(
        storedSecretRef('shared_container.run_env', source.record, entry.key),
        entry.value,
      );
  } else if (source.family === 'mcp.server') {
    // Strict read (CAN-4125 D9): damaged state throws, which the grants
    // report as unavailable. The OAuth client secret is never mapped.
    const document = requireMutableState(
      'server',
      classifyServerDocument(
        await readDocument(() =>
          readFile(getMcpServerFilePath(source.record), 'utf8'),
        ),
        source.record,
      ),
    );
    if (document === undefined) return values;
    for (const slot of mcpServerStoredSecretSlots(document.file.server)) {
      if (slot.slot !== MCP_OAUTH_CLIENT_SECRET_SLOT)
        values.set(
          storedSecretRef('mcp.server', source.record, slot.slot),
          slot.value,
        );
    }
  } else if (source.family === 'agent.chat') {
    // Decrypts only the ref this binding names.
    return getChatSecretStore().readForExecution(source.record, [source.ref]);
  } else {
    const family: never = source.family;
    throw new Error(`Unknown stored secret family: ${String(family)}`);
  }
  return values;
}

export const desktopExecutionSecretReader: ExecutionSecretReader = {
  read: async (bindings): Promise<readonly ExecutionSecretRead[]> => {
    const stored = new Map<string, Promise<ReadonlyMap<string, string>>>();
    const tokens = new Map<string, ExecutionSecretRead>();
    const reads: ExecutionSecretRead[] = [];
    for (const { source } of bindings) {
      if (source.kind === 'account-proxy-route') {
        reads.push({ status: 'unsupported' });
        continue;
      }
      if (source.kind === 'integration-token') {
        let read = tokens.get(source.provider);
        if (!read) {
          const value =
            source.provider === 'linear'
              ? await resolveLinearToken()
              : readGitHubPatForExecution();
          read =
            value === null || (source.provider === 'linear' && value === '')
              ? { status: 'missing' }
              : { status: 'ok', value };
          tokens.set(source.provider, read);
        }
        reads.push(read);
        continue;
      }
      if (
        source.family === 'environment' &&
        source.record !== ENVIRONMENT_SECRET_RECORD
      ) {
        reads.push({ status: 'missing' });
        continue;
      }
      // A chat-secret read decrypts only the ref it names, so it caches per ref.
      const key =
        source.family === 'agent.chat'
          ? `${source.family}\0${source.record}\0${source.ref}`
          : `${source.family}\0${source.record}`;
      let values = stored.get(key);
      if (!values) {
        values = storedValues(source);
        stored.set(key, values);
      }
      const value = (await values).get(source.ref);
      reads.push(
        value === undefined ? { status: 'missing' } : { status: 'ok', value },
      );
    }
    return reads;
  },
};
