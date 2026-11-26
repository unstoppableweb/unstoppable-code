import * as path from 'node:path';
import {
  createPipelineDefinitionStore,
  ownerFlipRecordFile,
  type PipelineDefinitionStore,
} from '@canopy/core-runtime/node/pipeline/store';
import { flushDirectorySync } from '@canopy/core-platform/directory-flush';
import {
  getBundledPipelinesDir,
  getUserPipelineIndexPath,
  getUserPipelinesDir,
} from '@canopy/execution-engine/pipelines/config-paths';
import { ensureDir } from '@canopy/execution-engine/pipelines/fs-utils';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import {
  ensurePrivateLockDirectorySync,
  withOwnerLockFileSync,
} from '@canopy/execution-engine/node/lib/owner-lock-file';
import {
  syncDirectory,
  writeFileAtomicallySync,
} from '../node/lib/atomic-file';
import { pruneDamagedCopiesSync } from '@canopy/execution-engine/node/lib/damaged-copies';
import { unlinkSync } from 'node:fs';

export type {
  StoredPipelinePath,
  StoredPipelineInfo,
  StoredPipelineWriteRefusal,
  StoredPipelineWriteResult,
  StoredPipelineWriteOptions,
  StoredPipelineIndexStatus,
  StoredPipelineWriterContext,
  StoredPipelineDocumentRead,
  StoredPipelineDocumentState,
} from '@canopy/core-runtime/node/pipeline/store';

/**
 * Creates the user pipeline folder; false when it can't be created. Other
 * files kept in that folder create it here, so the folder stays the
 * definitions writer's (CAN-7058).
 */
export function ensureStoredPipelineDirectory(): boolean {
  return ensureDir(getUserPipelinesDir());
}

/** Confirms published document and index directory entries together. */
export function confirmStoredPipelineDirectoryDurability(): Promise<void> {
  return syncDirectory(getUserPipelinesDir());
}

/**
 * Electron main's and the CLI's definitions store (CAN-5092): the portable
 * store in core-runtime over this process's data root, bundled resources,
 * owner lock and admitted atomic writer. Same API as before the move.
 */
export const pipelineDefinitionStore: PipelineDefinitionStore =
  createPipelineDefinitionStore({
    userPipelinesDir: () => getUserPipelinesDir(),
    userPipelineIndexPath: () => getUserPipelineIndexPath(),
    bundledPipelinesDir: () => getBundledPipelinesDir(),
    withWriterLock: (operation, options) => {
      const directory = path.join(
        getCanopyDataDir(),
        'locks',
        'pipeline-definitions',
      );
      ensurePrivateLockDirectorySync(directory);
      return withOwnerLockFileSync(
        path.join(directory, 'writer.lock'),
        operation,
        options,
      );
    },
    installUserFile: (fileName, data, claim) => {
      writeFileAtomicallySync(
        path.join(getUserPipelinesDir(), fileName),
        data,
        {
          encoding: 'utf8',
          durable: true,
          admittedWriter: claim,
        },
      );
    },
    removeUserFile: (fileName) => {
      unlinkSync(path.join(getUserPipelinesDir(), fileName));
    },
    flushUserDirectory: () => {
      flushDirectorySync(getUserPipelinesDir());
    },
    ensureUserDirectory: ensureStoredPipelineDirectory,
    pruneDamagedIndexCopies: () => {
      pruneDamagedCopiesSync(getUserPipelineIndexPath());
    },
    defaultWriter: () =>
      typeof process.versions.electron === 'string'
        ? 'electron_main'
        : 'desktop_cli',
    writerModule: 'packages/execution-engine/src/pipelines/store.ts',
    ownerFlipRecordPath: () =>
      ownerFlipRecordFile(getCanopyDataDir(), 'pipeline_definitions'),
  });

export const {
  readStoredPipelineIndexStatus,
  withStoredPipelineWriter,
  withStoredPipelineDefinitionLock,
  withStoredPipelineIndexSnapshot,
  findStoredUserPipelineIdByFilename,
  listStoredPipelines,
  getStoredPipeline,
  getStoredPipelineBySource,
  getStoredPipelineIndexEntry,
  readStoredPipelineDocument,
  inspectStoredPipelineDocument,
  removeUnlistedStoredPipelineDocument,
  readStoredPipelinePresence,
  getStoredPipelineText,
  getStoredPipelinePath,
  getStoredPipelinePathWithSource,
  writeStoredPipeline,
  saveStoredPipeline,
  writeStoredPipelineRemoteMetadata,
  clearStoredPipelineRemoteMetadataByRemoteId,
  readStoredPipelineRevision,
  removeStoredPipeline,
  deleteStoredPipeline,
  updateStoredPipeline,
  reconcileStoredPipelineIndex,
  duplicateStoredPipeline,
} = pipelineDefinitionStore;
