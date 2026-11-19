import { z } from 'zod';
import { assertMcpConfigAdmission } from './config-writer-admission';
import { basename, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { InspectMcpRemovalResult } from '@canopy/protocol/mcp-removal';
import * as fs from 'node:fs/promises';
import type {
  McpServerData,
  McpServerFile,
  McpServerIndexEntry,
  McpServersIndexFile,
} from '@canopy/execution-engine/types/mcp-servers';
import { normalizeMcpServerFile } from '@canopy/execution-engine/types/mcp-servers';
import {
  McpConfigStateError,
  classifyIndexDocument,
  classifyServerDocument,
  indexEnvelope,
  isAbsentError,
  isServerFileName,
  overlayIndexEntry,
  overlayServerDocument,
  readDocument,
  requireMutableState,
  serializeIndexOutput,
  serializeServerOutput,
  type IndexDocument,
  type DocumentRead,
} from './config-repository-format';
import {
  assertMcpRemovalUnchanged,
  filteredMcpRemovalIndex,
  McpRemovalRefusedError,
  prepareMcpRemoval,
  validateMcpRemovalId,
  type McpPreparedRemoval,
} from './config-removal-policy';
import {
  McpConfigRemovalEvidence,
  McpRemovalEvidenceError,
  sameMcpRemovalLeaf,
  type McpRemovalEvidenceHost,
  type McpRemovalLeaf,
  type McpRemovalLeafIdentity,
  type McpRemovalReceipt,
} from './config-removal-evidence';

export interface McpRemovalPlan extends McpPreparedRemoval {
  readonly source: McpRemovalLeafIdentity | null;
}

export type McpRemovalInspection = InspectMcpRemovalResult;

interface InspectedRemoval {
  serverId: string;
  source: McpRemovalLeafIdentity | null;
  indexState: string;
  expires: number;
}

function inspectedIndexState(document: DocumentRead): string {
  return 'text' in document
    ? createHash('sha256').update(document.text).digest('hex')
    : classifyIndexDocument(document).kind;
}

function removalIdentity(leaf: McpRemovalLeaf): McpRemovalLeafIdentity | null {
  if (leaf.kind === 'unexpected')
    throw new McpRemovalEvidenceError('unexpected_leaf');
  return leaf.kind === 'file' ? leaf.identity : null;
}

// Display-only fallback; all destructive paths classify raw documents strictly.
const legacyIndex = z.custom<McpServersIndexFile>(
  (value: unknown) =>
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === 1 &&
    'servers' in value &&
    Array.isArray(value.servers),
);

type Disk = Pick<typeof fs, 'writeFile' | 'mkdir' | 'unlink' | 'readdir'> & {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
};

/** Observes a removal step; it must not change the step's effects or order. */
type RemoveStepObserver = <T>(
  step: 'serverUnlink' | 'indexUpdate',
  run: () => Promise<T>,
) => Promise<T>;
const unobserved: RemoveStepObserver = (_step, run) => run();

/** One instance per production writer. Always acquire server lease before disk queue. */
export class McpConfigRepository {
  private readonly serverMutations = new Map<string, Promise<unknown>>();
  private diskMutation: Promise<unknown> = Promise.resolve();
  private readonly inspectedRemovals = new Map<string, InspectedRemoval>();

  constructor(
    private readonly paths: {
      index: () => string;
      server: (id: string) => string;
    },
    private readonly disk: Disk,
    private readonly removalHost?: McpRemovalEvidenceHost,
  ) {}

  withServerMutation<T>(id: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.serverMutations.get(id) ?? Promise.resolve();
    const next = previous.then(mutation, mutation);
    const settled = next.catch((): void => undefined);
    this.serverMutations.set(id, settled);
    void settled.then((): void => {
      if (this.serverMutations.get(id) === settled)
        this.serverMutations.delete(id);
    });
    return next;
  }

  private withDiskMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const next = this.diskMutation.then(mutation, mutation);
    this.diskMutation = next.catch((): void => undefined);
    return next;
  }

  async readIndex(): Promise<McpServersIndexFile> {
    try {
      return legacyIndex.parse(
        JSON.parse(await this.disk.readFile(this.paths.index(), 'utf8')),
      );
    } catch {
      return { version: 1, servers: [] };
    }
  }

  /** Read-only compatibility reader; mutations use `readServerForMutation`. */
  async readServer(id: string): Promise<McpServerFile> {
    const parsed: unknown = JSON.parse(
      await this.disk.readFile(this.paths.server(id), 'utf8'),
    );
    return normalizeMcpServerFile(parsed, id);
  }

  private readServerDocument(id: string): ReturnType<typeof readDocument> {
    return readDocument(() =>
      this.disk.readFile(this.paths.server(id), 'utf8'),
    );
  }

  private readIndexDocument(): ReturnType<typeof readDocument> {
    return readDocument(() => this.disk.readFile(this.paths.index(), 'utf8'));
  }

  /** Strict current server state; `undefined` only when the file is absent. */
  readServerForMutation(id: string): Promise<McpServerFile | undefined> {
    return this.withDiskMutation(
      async () =>
        requireMutableState(
          'server',
          classifyServerDocument(await this.readServerDocument(id), id),
        )?.file,
    );
  }

  /**
   * An absent index is empty only when no other server definition remains;
   * the target's own file is rewritten and indexed by this save.
   */
  private async readMutableIndex(
    id: string,
  ): Promise<IndexDocument | undefined> {
    const current = requireMutableState(
      'index',
      classifyIndexDocument(await this.readIndexDocument()),
    );
    if (current) return current;
    let names: string[];
    try {
      names = await this.disk.readdir(dirname(this.paths.index()));
    } catch (error) {
      if (isAbsentError(error)) return undefined;
      throw new McpConfigStateError(
        'index',
        'unreadable',
        error instanceof Error ? error.message : 'directory read failed',
      );
    }
    const target = basename(this.paths.server(id));
    if (names.some((name) => name !== target && isServerFileName(name)))
      throw new McpConfigStateError('index', 'orphaned', 'server files remain');
    return undefined;
  }

  private async writeText(path: string, text: string): Promise<void> {
    await this.disk.mkdir(dirname(path), { recursive: true });
    await this.disk.writeFile(path, text, 'utf8');
  }

  private requireRemovalHost(): McpRemovalEvidenceHost {
    if (!this.removalHost)
      throw new Error('Device MCP removal repair is unavailable.');
    return this.removalHost;
  }

  private assertAdmission(): void {
    if (this.removalHost) this.removalHost.assertAdmission();
    else assertMcpConfigAdmission();
  }

  private async definitionNames(): Promise<string[]> {
    try {
      return await this.disk.readdir(dirname(this.paths.index()));
    } catch (error) {
      if (isAbsentError(error)) return [];
      throw new McpRemovalRefusedError('index_unreadable');
    }
  }

  private async readRemovalPlan(id: string): Promise<McpRemovalPlan> {
    validateMcpRemovalId(id);
    const host = this.requireRemovalHost();
    host.assertAdmission();
    const source = removalIdentity(await host.source(id));
    const server = await this.readServerDocument(id);
    const index = await this.readIndexDocument();
    const plan = prepareMcpRemoval({
      serverId: id,
      server,
      index,
      definitionNames:
        classifyIndexDocument(index).kind === 'absent'
          ? await this.definitionNames()
          : [],
    });
    if (!sameMcpRemovalLeaf(source, removalIdentity(await host.source(id))))
      throw new McpRemovalRefusedError('state_changed');
    return { ...plan, source };
  }

  /** Hold the server lease across preflight, settled external effects and commit. */
  prepareRemoval(id: string): Promise<McpRemovalPlan> {
    return this.withDiskMutation(() => this.readRemovalPlan(id));
  }

  /** Re-reads the latest index before unlink, retaining intervening other-server writes. */
  removePrepared(
    plan: McpRemovalPlan,
    observe: RemoveStepObserver = unobserved,
  ): Promise<void> {
    return this.withDiskMutation(async () => {
      const latest = await this.readRemovalPlan(plan.serverId);
      assertMcpRemovalUnchanged(plan, latest);
      if (!sameMcpRemovalLeaf(plan.source, latest.source))
        throw new McpRemovalRefusedError('state_changed');
      this.requireRemovalHost().assertAdmission();
      await observe('serverUnlink', async () => {
        try {
          await this.disk.unlink(this.paths.server(plan.serverId));
        } catch (error) {
          if (!isAbsentError(error)) throw error;
        }
      });
      const indexText = latest.indexText;
      if (indexText !== null)
        await observe('indexUpdate', () => {
          this.requireRemovalHost().assertAdmission();
          return this.writeText(this.paths.index(), indexText);
        });
    });
  }

  /** Read-only hints from filenames and receipts, never the display/index fallback. */
  removalCandidates(): Promise<{ serverIds: string[]; incomplete: boolean }> {
    return this.withDiskMutation(async () => {
      const ids = new Set<string>();
      let incomplete = false;
      try {
        for (const name of await this.definitionNames()) {
          const match = /^server-([a-f0-9-]{1,256})\.json$/.exec(name);
          if (match?.[1]) ids.add(match[1]);
        }
      } catch {
        incomplete = true;
      }
      try {
        for (const receipt of await new McpConfigRemovalEvidence(
          this.requireRemovalHost(),
        ).listReceipts())
          ids.add(receipt.serverId);
      } catch {
        incomplete = true;
      }
      const serverIds = [...ids].sort();
      return {
        serverIds: serverIds.slice(0, 256),
        incomplete: incomplete || serverIds.length > 256,
      };
    });
  }

  inspectRemoval(id: string): Promise<McpRemovalInspection> {
    validateMcpRemovalId(id);
    return this.withDiskMutation(async () => {
      const host = this.requireRemovalHost();
      const leaf = await host.source(id);
      const target =
        leaf.kind === 'unexpected'
          ? 'unexpected'
          : classifyServerDocument(await this.readServerDocument(id), id).kind;
      const indexDocument = await this.readIndexDocument();
      const index = classifyIndexDocument(indexDocument).kind;
      const recoveries = await new McpConfigRemovalEvidence(host).find(id);
      const token = randomUUID();
      const now = Date.now();
      for (const [key, value] of this.inspectedRemovals)
        if (value.expires <= now) this.inspectedRemovals.delete(key);
      if (this.inspectedRemovals.size >= 64) {
        const first = this.inspectedRemovals.keys().next();
        if (!first.done) this.inspectedRemovals.delete(first.value);
      }
      if (leaf.kind !== 'unexpected')
        this.inspectedRemovals.set(token, {
          serverId: id,
          source: removalIdentity(leaf),
          indexState: inspectedIndexState(indexDocument),
          expires: now + 10 * 60 * 1000,
        });
      return {
        serverId: id,
        target,
        index,
        inspectedState: token,
        scope: leaf.kind === 'unexpected' ? 'unavailable' : 'preserve-evidence',
        recoveries: recoveries.map((receipt) => ({
          recoveryId: receipt.recoveryId,
          custody: receipt.custody,
          credentials: receipt.credentials,
          index: receipt.index,
        })),
      };
    });
  }

  prepareForcedRemoval(id: string, token: string): Promise<McpRemovalReceipt> {
    validateMcpRemovalId(id);
    return this.withDiskMutation(async () => {
      const host = this.requireRemovalHost();
      host.assertAdmission();
      const inspected = this.inspectedRemovals.get(token);
      if (
        !inspected ||
        inspected.serverId !== id ||
        inspected.expires <= Date.now()
      )
        throw new McpRemovalRefusedError('state_changed');
      const source = removalIdentity(await host.source(id));
      if (!sameMcpRemovalLeaf(inspected.source, source))
        throw new McpRemovalRefusedError('state_changed');
      // A changed index can change the approved scope from complete removal to
      // unresolved quarantine. Require a new inspection before preparing custody.
      if (
        inspected.indexState !==
        inspectedIndexState(await this.readIndexDocument())
      )
        throw new McpRemovalRefusedError('state_changed');
      const evidence = new McpConfigRemovalEvidence(host);
      if (
        (await evidence.find(id)).some(
          (receipt) => receipt.index !== 'complete',
        )
      )
        throw new McpRemovalRefusedError('previous_removal_pending');
      const server = classifyServerDocument(
        await this.readServerDocument(id),
        id,
      );
      const configIds =
        server.kind === 'valid'
          ? server.value.file.server.configs.map((config) => config.id)
          : null;
      const boundedConfigIds =
        configIds &&
        configIds.length <= 1024 &&
        configIds.every((configId) => /^[a-f0-9-]{1,256}$/.test(configId))
          ? configIds
          : null;
      // Preparation may install a receipt and then fail to confirm durability.
      // That attempt must be resumed by recovery id, not prepared twice.
      this.inspectedRemovals.delete(token);
      const receipt = await evidence.prepare({
        serverId: id,
        source,
        configIds: boundedConfigIds,
      });
      return receipt;
    });
  }

  validateRemovalCustody(
    id: string,
    recoveryId: string,
  ): Promise<McpRemovalReceipt> {
    return this.withDiskMutation(() =>
      new McpConfigRemovalEvidence(this.requireRemovalHost()).validateCustody(
        id,
        recoveryId,
      ),
    );
  }

  takeRemovalCustody(
    id: string,
    recoveryId: string,
  ): Promise<McpRemovalReceipt> {
    return this.withDiskMutation(() =>
      new McpConfigRemovalEvidence(this.requireRemovalHost()).takeCustody(
        id,
        recoveryId,
      ),
    );
  }

  readRemovalRecovery(
    id: string,
    recoveryId: string,
  ): Promise<McpRemovalReceipt> {
    return this.withDiskMutation(() =>
      new McpConfigRemovalEvidence(this.requireRemovalHost()).assertRemoved(
        id,
        recoveryId,
      ),
    );
  }

  readRemovalReceipt(
    id: string,
    recoveryId: string,
  ): Promise<McpRemovalReceipt> {
    return this.withDiskMutation(() =>
      new McpConfigRemovalEvidence(this.requireRemovalHost()).read(
        id,
        recoveryId,
      ),
    );
  }

  /** Fence a recreated target through uninstall-only reference reconciliation. */
  reconcileRemoved<T>(
    id: string,
    recoveryId: string,
    reconcile: () => Promise<T>,
  ): Promise<T> {
    return this.withServerMutation(id, async () => {
      const receipt = await this.readRemovalRecovery(id, recoveryId);
      if (
        !receipt.custody ||
        !receipt.credentials ||
        receipt.index !== 'complete'
      )
        throw new McpRemovalEvidenceError('stage_order');
      return reconcile();
    });
  }

  confirmRemovalCredentials(
    id: string,
    recoveryId: string,
  ): Promise<McpRemovalReceipt> {
    return this.withDiskMutation(() =>
      new McpConfigRemovalEvidence(
        this.requireRemovalHost(),
      ).confirmCredentials(id, recoveryId),
    );
  }

  reconcileRemovalIndex(
    id: string,
    recoveryId: string,
  ): Promise<McpRemovalReceipt> {
    return this.withDiskMutation(async () => {
      const host = this.requireRemovalHost();
      host.assertAdmission();
      const evidence = new McpConfigRemovalEvidence(host);
      const receipt = await evidence.assertRemoved(id, recoveryId);
      if (!receipt.credentials)
        throw new McpRemovalEvidenceError('stage_order');
      const index = classifyIndexDocument(await this.readIndexDocument());
      if (index.kind === 'valid') {
        const text = filteredMcpRemovalIndex(index.value, id);
        await evidence.assertRemoved(id, recoveryId);
        host.assertAdmission();
        if (index.value.index.servers.some((row) => row.id === id))
          await this.writeText(this.paths.index(), text);
        return evidence.confirmIndex(id, recoveryId, 'complete');
      }
      // Mike q-11(a): quarantine only, never reconstruct/reset a shared index.
      const complete =
        index.kind === 'absent' &&
        !(await this.definitionNames()).some(isServerFileName);
      return evidence.confirmIndex(
        id,
        recoveryId,
        complete ? 'complete' : 'unresolved',
      );
    });
  }

  save(
    id: string,
    prepare: (index: McpServersIndexFile) => {
      server: McpServerData;
      entry: McpServerIndexEntry;
    },
  ): Promise<McpServerFile> {
    return this.withDiskMutation(async () => {
      this.assertAdmission();
      const index = await this.readMutableIndex(id);
      const current = requireMutableState(
        'server',
        classifyServerDocument(await this.readServerDocument(id), id),
      );
      const { server, entry } = prepare(
        index?.index ?? { version: 1, servers: [] },
      );
      if (server.definition.id !== id || entry.id !== id)
        throw new Error('MCP server id changed during save.');
      const output = serializeServerOutput(
        overlayServerDocument(current?.raw, server),
        id,
      );
      const indexText = serializeIndexOutput(overlayIndexEntry(index, entry));
      this.assertAdmission();
      await this.writeText(this.paths.server(id), output.text);
      this.assertAdmission();
      await this.writeText(this.paths.index(), indexText);
      return output.file;
    });
  }

  /** Physical deletion is strict even for callers without credential effects. Hold the server lease. */
  async remove(
    id: string,
    observe: RemoveStepObserver = unobserved,
  ): Promise<void> {
    await this.removePrepared(await this.prepareRemoval(id), observe);
  }

  /** Strict: an unusable index refuses; an unusable definition is skipped. */
  backfill(
    needsFields: (entry: McpServerIndexEntry) => boolean,
    fieldsFor: (
      server: McpServerData,
    ) => Pick<McpServerIndexEntry, 'urlHost' | 'urlScheme'>,
  ): Promise<{ index: McpServersIndexFile; changed: boolean }> {
    return this.withDiskMutation(async () => {
      this.assertAdmission();
      const current = requireMutableState(
        'index',
        classifyIndexDocument(await this.readIndexDocument()),
      );
      if (!current)
        return { index: { version: 1, servers: [] }, changed: false };
      let changed = false;
      const servers = await Promise.all(
        current.index.servers.map(
          async (entry): Promise<McpServerIndexEntry> => {
            if (!needsFields(entry)) return entry;
            const definition = classifyServerDocument(
              await this.readServerDocument(entry.id),
              entry.id,
            );
            if (definition.kind !== 'valid') return entry;
            const fields = fieldsFor(definition.value.file.server);
            if (fields.urlHost === undefined) return entry;
            changed = true;
            return { ...entry, ...fields };
          },
        ),
      );
      if (changed) {
        this.assertAdmission();
        await this.writeText(
          this.paths.index(),
          serializeIndexOutput(indexEnvelope(current.raw, servers)),
        );
      }
      return { index: { ...current.index, servers }, changed };
    });
  }
}

/** Physical config/index adapter; mutations remain behind the repository's admission. */
export const mcpConfigDisk: Disk = {
  mkdir: fs.mkdir,
  writeFile: fs.writeFile,
  unlink: fs.unlink,
  readFile: (path, encoding) => fs.readFile(path, encoding),
  readdir: fs.readdir,
};
