import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PlatformSecureFileServices } from '@canopy/core-runtime';
import {
  createDirectoryDurably,
  writeFileAtomically,
} from '../lib/atomic-file';
import { isAbsentError } from './config-repository-format';
import {
  McpRemovalEvidenceError,
  MCP_REMOVAL_RECEIPT_MAX_BYTES,
  type McpRemovalEvidenceHost,
  type McpRemovalLeaf,
} from './config-removal-evidence';
import { validateMcpRemovalId } from './config-removal-policy';

/** Trusted host composition only; none of these paths are public request fields. */
export function createMcpRemovalEvidenceHost(options: {
  root: string | (() => string);
  dataRoot: string | (() => string);
  serverPath(serverId: string): string;
  secureFiles: PlatformSecureFileServices;
  assertAdmission(): void;
}): McpRemovalEvidenceHost {
  const root = (): string =>
    typeof options.root === 'string' ? options.root : options.root();
  const dataRoot = (): string =>
    typeof options.dataRoot === 'string'
      ? options.dataRoot
      : options.dataRoot();
  const operation = (id: string): string => {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new McpRemovalEvidenceError('receipt_unusable');
    return join(root(), id);
  };
  const source = (id: string): string => {
    validateMcpRemovalId(id);
    return options.serverPath(id);
  };
  const sourceParent = async (id: string): Promise<void> => {
    try {
      if (!(await lstat(dirname(source(id)))).isDirectory())
        throw new McpRemovalEvidenceError('unexpected_leaf');
    } catch (error) {
      if (isAbsentError(error)) return;
      if (error instanceof McpRemovalEvidenceError) throw error;
      throw new McpRemovalEvidenceError('leaf_unreadable');
    }
  };
  const leaf = async (path: string): Promise<McpRemovalLeaf> => {
    try {
      const stat = await lstat(path, { bigint: true });
      if (!stat.isFile() || stat.nlink !== BigInt(1))
        return { kind: 'unexpected' };
      return {
        kind: 'file',
        identity: {
          device: String(stat.dev),
          inode: String(stat.ino),
          birth: String(stat.birthtimeNs),
          modified: String(stat.mtimeNs),
          size: String(stat.size),
        },
      };
    } catch (error) {
      if (isAbsentError(error)) return { kind: 'absent' };
      throw new McpRemovalEvidenceError('leaf_unreadable');
    }
  };
  const privateDirectory = async (
    path: string,
    action: 'verify' | 'restrict',
  ): Promise<void> => {
    if (!(await lstat(path)).isDirectory())
      throw new McpRemovalEvidenceError('unexpected_leaf');
    const result = await options.secureFiles.permissions({
      path,
      kind: 'directory',
      mode: 'owner-only',
      action,
    });
    if (result.state !== 'private')
      throw new McpRemovalEvidenceError('unexpected_leaf');
  };
  const assertPrivateOperation = async (id: string): Promise<void> => {
    await privateDirectory(root(), 'verify');
    await privateDirectory(operation(id), 'verify');
  };
  const flush = async (path: string): Promise<void> => {
    if ((await options.secureFiles.syncDirectory(path)) !== 'flushed')
      throw new Error('Device MCP removal durability could not be confirmed.');
  };
  return {
    assertAdmission: () => options.assertAdmission(),
    createOperation: async (id) => {
      options.assertAdmission();
      const created = await mkdir(root(), { recursive: true, mode: 0o700 });
      await privateDirectory(
        root(),
        created === undefined ? 'verify' : 'restrict',
      );
      await createDirectoryDurably(root(), { dataRoot: dataRoot() });
      await mkdir(operation(id), { mode: 0o700 });
      await privateDirectory(operation(id), 'restrict');
      await createDirectoryDurably(operation(id), { dataRoot: dataRoot() });
    },
    assertPrivateOperation,
    source: async (id) => {
      await sourceParent(id);
      return leaf(source(id));
    },
    evidence: async (id) => {
      await assertPrivateOperation(id);
      return leaf(join(operation(id), 'evidence'));
    },
    readReceipt: async (id) => {
      await assertPrivateOperation(id);
      const path = join(operation(id), 'receipt.json');
      const before = await lstat(path, { bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== BigInt(1) ||
        before.size > BigInt(MCP_REMOVAL_RECEIPT_MAX_BYTES)
      )
        throw new McpRemovalEvidenceError('receipt_unusable');
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const actual = await handle.stat({ bigint: true });
        if (
          !actual.isFile() ||
          actual.dev !== before.dev ||
          actual.ino !== before.ino ||
          actual.size !== before.size
        )
          throw new McpRemovalEvidenceError('receipt_unusable');
        const data = Buffer.alloc(MCP_REMOVAL_RECEIPT_MAX_BYTES + 1);
        let offset = 0;
        while (offset < data.length) {
          const { bytesRead } = await handle.read(
            data,
            offset,
            data.length - offset,
            offset,
          );
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > MCP_REMOVAL_RECEIPT_MAX_BYTES)
          throw new McpRemovalEvidenceError('receipt_unusable');
        return data.subarray(0, offset).toString('utf8');
      } finally {
        await handle.close();
      }
    },
    writeReceipt: async (receipt, exclusive) => {
      options.assertAdmission();
      await assertPrivateOperation(receipt.recoveryId);
      const text = JSON.stringify(receipt);
      if (Buffer.byteLength(text, 'utf8') > MCP_REMOVAL_RECEIPT_MAX_BYTES)
        throw new McpRemovalEvidenceError('receipt_unusable');
      await writeFileAtomically(
        join(operation(receipt.recoveryId), 'receipt.json'),
        text,
        {
          mode: 0o600,
          durable: true,
          overwrite: !exclusive,
          admittedWriter: {
            namespace: 'mcp_removal_evidence',
            writer: 'electron_main',
            module: 'main/mcp/config-removal-disk',
          },
        },
      );
    },
    moveToEvidence: async (serverId, id) => {
      options.assertAdmission();
      await assertPrivateOperation(id);
      await sourceParent(serverId);
      const path = join(operation(id), 'evidence');
      if ((await leaf(path)).kind !== 'absent')
        throw new McpRemovalEvidenceError('evidence_conflict');
      if ((await leaf(source(serverId))).kind !== 'file')
        throw new McpRemovalEvidenceError('unexpected_leaf');
      // Only the holder of the repository lease writes this exclusive private
      // slot. Native no-replace uses link+unlink, which is not custody rename.
      // Another OS process racing inside private storage is not excluded.
      await rename(source(serverId), path);
    },
    flushCustody: async (serverId, id, sourceExisted) => {
      await assertPrivateOperation(id);
      if (sourceExisted) await flush(dirname(source(serverId)));
      await flush(operation(id));
    },
    listOperations: async (limit) => {
      try {
        await privateDirectory(root(), 'verify');
      } catch (error) {
        if (isAbsentError(error)) return [];
        throw error;
      }
      const entries = await readdir(root(), { withFileTypes: true });
      if (entries.length > limit)
        throw new McpRemovalEvidenceError('receipt_limit');
      if (entries.some((entry) => !entry.isDirectory()))
        throw new McpRemovalEvidenceError('unexpected_leaf');
      return entries.map((entry) => entry.name);
    },
  };
}
