import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  pipelineDataBusyError,
  pipelineDataRefusedError,
  pipelineDataSnapshotGoneError,
  pipelineStartFailedError,
} from '@canopy/core-runtime/node/pipeline';
import type { PipelineRunnerDataPort } from '@canopy/core-runtime/node/pipeline/host';
import {
  WORKER_PIPELINE_DATA_ARCHIVE_MAX_BYTES,
  WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES,
  type WorkerPipelineDataArchive,
  type WorkerPipelineDataExportParams,
  type WorkerPipelineDataExportResult,
  type WorkerPipelineDataImportParams,
  type WorkerPipelineDataImportResult,
} from '@canopy/protocol/canopy-core';
import {
  packArchive,
  parseArchive,
  sha256,
  unpackArchive,
  type ArchiveFormat,
} from './archive';

/*
 * A pipeline's data on the cloud runner (CAN-6317, cloud pipelines CP-35).
 * The runner's data root is lost with its sandbox, so the web core keeps
 * each pipeline's data per run owner and pipeline, imports it before a
 * start on each new incarnation and exports it after a checkpoint and when
 * the run ends (`worker.pipeline.data.*`). On the runner it lives in
 * `<dataRoot>/pipeline-data/<key>/`, as desktop keeps it under
 * `<data>/pipeline-data/<key>/`:
 *
 * - `state/`: the run's `canopy.pipeline_data_dir`.
 * - `assets/<id>/`: the installed copy of each declared asset. A cloud run
 *   reads every asset from here, whatever path the definition declares, so
 *   an absolute or `~` path on the author's computer is remapped into it.
 * - `workspace/`: the folder a global run works in. `memory` and
 *   `comms-setup` keep their databases in its `.canopy/`, and `memory-read`
 *   and `memory-write` resolve relative files against it, so they last from
 *   one run to the next as they do in a desktop run's folder.
 *
 * A checkout is not part of it: what a run writes inside its checkout goes
 * with the checkout.
 */

/** Where pipeline data lives under the runner's data root. */
export const PIPELINE_RUNNER_DATA_DIR = 'pipeline-data';

/** The folders of one pipeline's data on the runner. */
export interface PipelineRunnerDataFolders {
  readonly root: string;
  /** `canopy.pipeline_data_dir`. */
  readonly state: string;
  /** The installed asset root: `assets/<id>/` per asset. */
  readonly assets: string;
  /** A global run's workspace. */
  readonly workspace: string;
}

/** The folder name of one owner's pipeline: never a path a start names. */
export function pipelineRunnerDataKey(
  owner: string,
  pipelineId: string,
): string {
  return createHash('sha256')
    .update(`${owner}\u0000${pipelineId}`)
    .digest('hex');
}

export function pipelineRunnerDataFolders(
  dataRoot: string,
  owner: string,
  pipelineId: string,
): PipelineRunnerDataFolders {
  const root = path.join(
    dataRoot,
    PIPELINE_RUNNER_DATA_DIR,
    pipelineRunnerDataKey(owner, pipelineId),
  );
  return {
    root,
    state: path.join(root, 'state'),
    assets: path.join(root, 'assets'),
    workspace: path.join(root, 'workspace'),
  };
}

/*
 * The archive (`archive.ts`): `CANOPY-PIPELINE-DATA/1\n`, then one entry per
 * folder and regular file. The format is the runner's own; the web core
 * stores it unread.
 */
const DATA_ARCHIVE: ArchiveFormat = {
  magic: Buffer.from('CANOPY-PIPELINE-DATA/1\n'),
  maxBytes: WORKER_PIPELINE_DATA_ARCHIVE_MAX_BYTES,
  refuse: {
    tooLarge: () =>
      pipelineDataRefusedError("This workflow's data is over its 32 MB limit."),
    tooManyEntries: () =>
      pipelineDataRefusedError("This workflow's data has too many files."),
    unkeepablePath: (entryPath) =>
      pipelineDataRefusedError(
        `This workflow's data has a file whose path can't be kept: ${entryPath}`,
      ),
    invalid: () =>
      pipelineDataRefusedError("This workflow's data archive is invalid."),
  },
};

interface Staging {
  readonly archive: WorkerPipelineDataArchive;
  readonly chunks: Buffer[];
  received: number;
}

interface Snapshot {
  readonly sha256: string;
  readonly bytes: Buffer;
}

function decodeChunk(chunk: string): Buffer {
  const bytes = Buffer.from(chunk, 'base64');
  if (bytes.byteLength > WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES)
    throw pipelineDataRefusedError('A chunk of workflow data is too large.');
  return bytes;
}

function sameArchive(
  a: WorkerPipelineDataArchive,
  b: WorkerPipelineDataArchive,
): boolean {
  return a.sha256 === b.sha256 && a.byteSize === b.byteSize;
}

/**
 * Each pipeline's data on one runner: what its imports restored, its runs
 * wrote and its exports read. The host module refuses either call while a
 * run of the pipeline is pending or running.
 */
export class PipelineRunnerDataStore implements PipelineRunnerDataPort {
  readonly #dataRoot: string;
  /** Imports still receiving chunks or unpacking, by data key. */
  readonly #staging = new Map<string, Staging>();
  /** Keys a start used on this incarnation: they take no import after it. */
  readonly #started = new Set<string>();
  /** Keys whose import is checking and unpacking its last chunk. */
  readonly #finishing = new Set<string>();
  /** The archive each key's last import completed with. */
  readonly #imported = new Map<string, WorkerPipelineDataArchive>();
  /** The last snapshot each key's export packed, until the next. */
  readonly #snapshots = new Map<string, Snapshot>();

  constructor(dataRoot: string) {
    this.#dataRoot = dataRoot;
  }

  /**
   * The pipeline's folders for a start, created when missing. Throws while
   * an import of its data is unfinished, until it is unpacked and swapped
   * in: the run would miss its data. Once a start used them, the pipeline
   * takes no import on this incarnation, so a restore never replaces the
   * folders under a run.
   */
  async prepare(
    owner: string,
    pipelineId: string,
  ): Promise<PipelineRunnerDataFolders> {
    const key = pipelineRunnerDataKey(owner, pipelineId);
    if (this.#staging.has(key))
      throw pipelineStartFailedError(
        new Error("This workflow's data is still being restored."),
      );
    this.#started.add(key);
    const folders = pipelineRunnerDataFolders(
      this.#dataRoot,
      owner,
      pipelineId,
    );
    await Promise.all(
      [folders.state, folders.assets, folders.workspace].map((folder) =>
        mkdir(folder, { recursive: true }),
      ),
    );
    return folders;
  }

  async importData(
    params: WorkerPipelineDataImportParams,
  ): Promise<WorkerPipelineDataImportResult> {
    const key = pipelineRunnerDataKey(params.owner, params.pipelineId);
    // Restored once, before this incarnation's first start of the pipeline,
    // and one import at a time: nothing replaces an import's staging while
    // it unpacks, so an older import never swaps in over a newer one.
    if (this.#started.has(key) || this.#finishing.has(key))
      throw pipelineDataBusyError();
    const { archive, offset } = params;
    const chunk = decodeChunk(params.chunk);
    const imported = this.#imported.get(key);
    // The last chunk sent again after it completed the import.
    if (
      imported &&
      sameArchive(imported, archive) &&
      !this.#staging.has(key) &&
      offset + chunk.byteLength === archive.byteSize
    )
      return { received: archive.byteSize, complete: true };
    let staging = this.#staging.get(key);
    if (offset === 0 && (!staging || !sameArchive(staging.archive, archive))) {
      staging = { archive, chunks: [], received: 0 };
      this.#staging.set(key, staging);
    }
    if (!staging || !sameArchive(staging.archive, archive))
      throw pipelineDataRefusedError(
        "This workflow's data must be restored from its first chunk.",
      );
    // A chunk sent again after its reply was lost.
    if (
      offset + chunk.byteLength <= staging.received &&
      offset < staging.received
    )
      return { received: staging.received, complete: false };
    if (offset !== staging.received)
      throw pipelineDataRefusedError(
        "This workflow's data arrived out of order.",
      );
    if (staging.received + chunk.byteLength > archive.byteSize) {
      this.#staging.delete(key);
      throw pipelineDataRefusedError(
        "This workflow's data is longer than its archive.",
      );
    }
    staging.chunks.push(chunk);
    staging.received += chunk.byteLength;
    if (staging.received < archive.byteSize)
      return { received: staging.received, complete: false };
    // Staging stays until the swap ends, so no start sees half the data.
    this.#finishing.add(key);
    try {
      const bytes = Buffer.concat(staging.chunks, staging.received);
      if (sha256(bytes) !== archive.sha256)
        throw pipelineDataRefusedError(
          "This workflow's data does not match its digest.",
        );
      await this.#replace(params.owner, params.pipelineId, bytes);
    } finally {
      this.#staging.delete(key);
      this.#finishing.delete(key);
    }
    this.#imported.set(key, archive);
    this.#snapshots.delete(key);
    return { received: archive.byteSize, complete: true };
  }

  async exportData(
    params: WorkerPipelineDataExportParams,
  ): Promise<WorkerPipelineDataExportResult> {
    const key = pipelineRunnerDataKey(params.owner, params.pipelineId);
    let snapshot: Snapshot | undefined;
    let offset = 0;
    if (params.snapshot) {
      snapshot = this.#snapshots.get(key);
      if (!snapshot || snapshot.sha256 !== params.snapshot.sha256)
        throw pipelineDataSnapshotGoneError();
      offset = params.snapshot.offset;
      if (offset > snapshot.bytes.byteLength)
        throw pipelineDataRefusedError(
          "This workflow's data snapshot is shorter than that.",
        );
    } else {
      const folders = pipelineRunnerDataFolders(
        this.#dataRoot,
        params.owner,
        params.pipelineId,
      );
      await mkdir(folders.root, { recursive: true });
      const bytes = await packArchive(folders.root, DATA_ARCHIVE);
      snapshot = { sha256: sha256(bytes), bytes };
      this.#snapshots.set(key, snapshot);
    }
    const end = Math.min(
      offset + WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES,
      snapshot.bytes.byteLength,
    );
    return {
      archive: { sha256: snapshot.sha256, byteSize: snapshot.bytes.byteLength },
      offset,
      chunk: snapshot.bytes.subarray(offset, end).toString('base64'),
      complete: end === snapshot.bytes.byteLength,
    };
  }

  /** Unpacks beside the pipeline's folder, then swaps it in. */
  async #replace(
    owner: string,
    pipelineId: string,
    bytes: Buffer,
  ): Promise<void> {
    const { root } = pipelineRunnerDataFolders(
      this.#dataRoot,
      owner,
      pipelineId,
    );
    const incoming = `${root}.importing-${randomUUID()}`;
    try {
      await unpackArchive(parseArchive(bytes, DATA_ARCHIVE), incoming);
      await rm(root, { recursive: true, force: true });
      await rename(incoming, root);
    } catch (error) {
      await rm(incoming, { recursive: true, force: true });
      // An archive whose entries clash, such as a file where a folder
      // follows, fails here; the pipeline's data is unchanged.
      throw error instanceof CanopyOperationError
        ? error
        : pipelineDataRefusedError(
            "This workflow's data could not be restored.",
            error,
          );
    }
  }
}
