/**
 * Install intent records (CAN-5633): Electron main's install journal. The
 * journal is core-runtime's `store/install-journal.ts` (CAN-7058); this
 * module builds it over main's paths, durable writes, stores and logging,
 * and keeps the exports main's callers use.
 *
 * Each port looks its function up when called, as the journal's calls did
 * before it moved.
 */
import { mkdir, rename, rm, rmdir } from 'node:fs/promises';
import {
  isInstallReceipt,
  type InstallReceipt,
} from '@canopy/execution-engine/lib/resource-context-policy';
import { pruneDamagedCopies } from '@canopy/execution-engine/node/lib/damaged-copies';
import {
  inspectStoredPipelineDocument,
  removeUnlistedStoredPipelineDocument,
  removeStoredPipeline,
  writeStoredPipeline,
} from '@canopy/execution-engine/pipelines/store';
import type {
  CapabilityPackageInstallRecordV1,
  PipelinePackageInstallRecordV1,
} from '@canopy/execution-engine/types/pipeline';
import {
  createPipelineInstallJournal,
  type PipelineInstallJournalEnvironment,
  type PipelineInstallJournalIntent,
} from '@canopy/core-runtime/node/pipeline/store';
import { recordSharedItemLocalUninstall } from '../canopy-cloud/shared-item-subscriptions';
import {
  createDirectoryDurably,
  syncDirectory,
  writeFileAtomically,
} from '../lib/atomic-file';
import { writeStoreFileDurably } from '../lib/durable-store-write';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  getDataDir,
  getPipelineAssetsDir,
  getPipelineAssetsManifestPath,
  getPipelineInstallIntentsDir,
  getPipelinePackageInstallStorePath,
} from '../lib/paths';
import { createResourceInstallReceiptsStore } from '../lib/resource-install-receipts';
import { deleteUserPipelineLocalMetadata } from './pipeline-local-metadata-store';
import {
  definitionRemoval,
  noteDefinitionRemoved,
} from './removed-definitions';
import {
  findCapabilityPackageInstallByOwner,
  removeCapabilityPackageInstall,
  upsertCapabilityPackageInstall,
} from './pipeline-package-install-store';
import * as localPipelineService from './pipeline-service';

export {
  PIPELINE_DEFINITION_REMOVED_MESSAGE,
  PIPELINE_DEFINITION_RESTORING_MESSAGE,
  PIPELINE_DEFINITION_UNCONFIRMED_MESSAGE,
  RUN_START_RECOVERY_WAIT_MS,
  type PipelineDefinitionRecovery,
  type PipelineDefinitionRecoveryRefusal,
  type PipelineInstallIntentSource,
} from '@canopy/core-runtime/node/pipeline/store';

/** A run start's wait for its definition's rollback (CAN-7308) is main's job. */
function startRecoveryWait(run: () => void, waitMs: number): NodeJS.Timeout {
  const timer = setTimeout(run, waitMs);
  return timer;
}

export type PipelineInstallIntent = PipelineInstallJournalIntent<
  InstallReceipt,
  PipelinePackageInstallRecordV1
>;

/** The journal's environment over Electron main's paths, stores and writes. */
export const pipelineInstallJournalEnvironment: PipelineInstallJournalEnvironment<
  InstallReceipt,
  CapabilityPackageInstallRecordV1
> = {
  getPipelineInstallIntentsDir: () => getPipelineInstallIntentsDir(),
  getDataDir: () => getDataDir(),
  getPipelineAssetsDir: (definitionId) => getPipelineAssetsDir(definitionId),
  getPipelineAssetsManifestPath: (definitionId) =>
    getPipelineAssetsManifestPath(definitionId),
  // Electron main is the single writer under its single-instance lock.
  assertWritable: () => undefined,
  createDirectoryDurably: (directoryPath, options) =>
    createDirectoryDurably(directoryPath, options),
  syncDirectory: (directoryPath) => syncDirectory(directoryPath),
  writeFileAtomically: (targetPath, data, options) =>
    writeFileAtomically(targetPath, data, options),
  writeStoreFileDurably: (targetPath, data, options) =>
    writeStoreFileDurably(targetPath, data, options),
  definitions: {
    inspectStoredPipelineDocument: (id) => inspectStoredPipelineDocument(id),
    removeUnlistedStoredPipelineDocument: (id, expectedSha256) =>
      removeUnlistedStoredPipelineDocument(id, expectedSha256),
    removeStoredPipeline: (id, options) => removeStoredPipeline(id, options),
    writeStoredPipeline: (input, options) =>
      writeStoredPipeline(input, options),
  },
  pipelineService: {
    getPipeline: (id) => localPipelineService.getPipeline(id),
    getPipelineText: (id) => localPipelineService.getPipelineText(id),
  },
  deleteUserPipelineLocalMetadata: (definitionId) => {
    deleteUserPipelineLocalMetadata(definitionId);
  },
  installRecords: {
    storePath: () => getPipelinePackageInstallStorePath(),
    find: (storePath, owner) =>
      findCapabilityPackageInstallByOwner(storePath, owner),
    upsert: (storePath, record) =>
      upsertCapabilityPackageInstall(storePath, record),
    remove: (storePath, owner) =>
      removeCapabilityPackageInstall(storePath, owner),
  },
  installReceipts: (accountId) => createResourceInstallReceiptsStore(accountId),
  isInstallReceipt: (value) => isInstallReceipt(value),
  recordSharedItemLocalUninstall: (item) => {
    recordSharedItemLocalUninstall(item);
  },
  noteDefinitionRemoved: (definitionId, removal) => {
    noteDefinitionRemoved(definitionId, removal);
  },
  definitionRemoval: (definitionId) => definitionRemoval(definitionId),
  warn: (message, context) => {
    logMainProcessWarn(message, context);
  },
  setTimeout: startRecoveryWait,
  clearTimeout: (timer) => {
    clearTimeout(timer);
  },
  removePath: (target, options) => rm(target, options),
  removeEmptyFolder: (folder) => rmdir(folder),
  renamePath: (source, destination) => rename(source, destination),
  makeFolder: (folder, options) => mkdir(folder, options),
  pruneDamagedCopies: (names) => pruneDamagedCopies(names),
};

const journal = createPipelineInstallJournal<
  InstallReceipt,
  CapabilityPackageInstallRecordV1,
  PipelinePackageInstallRecordV1
>(pipelineInstallJournalEnvironment);

export const recoverInterruptedPipelineInstalls =
  journal.recoverInterruptedPipelineInstalls;
export const isPipelineDefinitionClaimed = journal.isPipelineDefinitionClaimed;
export const whenPipelineInstallsRecovered =
  journal.whenPipelineInstallsRecovered;
export const whenPipelineDefinitionRecovered =
  journal.whenPipelineDefinitionRecovered;
export const pipelineDefinitionRecoveryRefusal =
  journal.pipelineDefinitionRecoveryRefusal;
export const beginPipelineInstallIntent = journal.beginPipelineInstallIntent;
