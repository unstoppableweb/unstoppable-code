import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import {
  pipelineExecutionNotFoundError,
  pipelineTranscriptNotFoundError,
  pipelineTranscriptRefusedError,
  pipelineTranscriptSnapshotGoneError,
} from '@canopy/core-runtime/node/pipeline';
import type { PipelineRunnerTranscriptPort } from '@canopy/core-runtime/node/pipeline/host';
import {
  WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES,
  WORKER_PIPELINE_TRANSCRIPT_MAX_BYTES,
  type WorkerPipelineExecutionTranscriptExportParams,
  type WorkerPipelineExecutionTranscriptExportResult,
} from '@canopy/protocol/canopy-core';
import type { StepResult } from '@canopy/execution-engine/types/pipeline';
import { loadExecutionState } from '../executor/execution-state';
import { PIPELINE_RUNNER_EXECUTIONS_DIR } from './execution-handoff';

/*
 * An agent step's transcript, read back by the runner's owner (CAN-6421,
 * cloud pipelines CP-24). A Claude Code or Codex step records its
 * transcript as its `transcript_file` output, a JSONL file the step runner
 * keeps in the run's execution directory. The step's events carry the same
 * lines as output, but output is budgeted, and the sandbox that holds the
 * file goes, so the web core reads each finished agent step's file in
 * chunks and keeps it as a run artifact.
 *
 * Only a regular file inside the run's own execution directory, once every
 * link resolves, is read: the state is the host's, but a path it names never
 * reaches outside the run.
 */

/** How many transcript digests a runner keeps between the chunks of an export. */
const DIGESTS_KEPT = 64;

interface Digest {
  readonly key: string;
  readonly sha256: string;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error))
    return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function outputOf(step: StepResult, name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(step.outputs, name)
    ? nonEmpty(step.outputs[name])
    : undefined;
}

/**
 * Where a step's transcript is, as the step runner records it: a finished
 * step's `transcript_file` output; a step paused for provider recovery, its
 * recovery checkpoint's; a failed one, its `agent_failure_transcript_file`;
 * and an agent step that recorded neither, such as a cancelled Codex turn,
 * its own step log, which is its transcript. Another step's log is its
 * output, not a transcript.
 */
function transcriptPathOf(step: StepResult): string | undefined {
  const agent =
    step.agent_provider !== undefined ||
    step.agent_harness !== undefined ||
    step.log_format_hint === 'agent';
  return (
    outputOf(step, 'transcript_file') ??
    nonEmpty(step.agent_recovery?.transcript_file) ??
    outputOf(step, 'agent_failure_transcript_file') ??
    (agent ? nonEmpty(step.log_file) : undefined)
  );
}

/** The agent steps' transcripts one runner's runs recorded. */
export class PipelineRunnerTranscriptStore implements PipelineRunnerTranscriptPort {
  readonly #executionsDir: string;
  /** The digest of each transcript an export read lately, by its path. */
  readonly #digests = new Map<string, Digest>();

  constructor(dataRoot: string) {
    this.#executionsDir = path.join(dataRoot, PIPELINE_RUNNER_EXECUTIONS_DIR);
  }

  async exportTranscript(
    params: WorkerPipelineExecutionTranscriptExportParams,
  ): Promise<WorkerPipelineExecutionTranscriptExportResult> {
    const file = await this.#transcriptOf(params);
    const stats = await lstat(file).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT')
        throw pipelineTranscriptNotFoundError();
      throw error;
    });
    if (!stats.isFile())
      throw pipelineTranscriptRefusedError(
        "This step's transcript is not a file.",
      );
    if (stats.size > WORKER_PIPELINE_TRANSCRIPT_MAX_BYTES)
      throw pipelineTranscriptRefusedError(
        "This step's transcript is over its 64 MB limit.",
      );
    const sha256 = await this.#digestOf(
      file,
      `${String(stats.size)}:${String(stats.mtimeMs)}:${String(stats.ino)}`,
    );
    const offset = params.snapshot?.offset ?? 0;
    if (params.snapshot !== undefined && params.snapshot.sha256 !== sha256)
      throw pipelineTranscriptSnapshotGoneError();
    if (offset > stats.size)
      throw pipelineTranscriptRefusedError(
        "The offset is past the end of this step's transcript.",
      );
    const length = Math.min(
      WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES,
      stats.size - offset,
    );
    const chunk = Buffer.alloc(length);
    const handle = await open(file, 'r');
    try {
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(
          chunk,
          read,
          length - read,
          offset + read,
        );
        if (bytesRead === 0) throw pipelineTranscriptSnapshotGoneError();
        read += bytesRead;
      }
    } finally {
      await handle.close();
    }
    return {
      transcript: { sha256, byteSize: stats.size },
      offset,
      chunk: chunk.toString('base64'),
      complete: offset + length >= stats.size,
    };
  }

  /** The transcript file the step's latest attempt recorded, inside its run. */
  async #transcriptOf(
    params: WorkerPipelineExecutionTranscriptExportParams,
  ): Promise<string> {
    const state = await loadExecutionState(
      params.executionId,
      this.#executionsDir,
    );
    if (state === null) throw pipelineExecutionNotFoundError();
    const job = Object.prototype.hasOwnProperty.call(state.jobs, params.jobId)
      ? state.jobs[params.jobId]
      : undefined;
    const step =
      job !== undefined &&
      Object.prototype.hasOwnProperty.call(job.steps, params.stepId)
        ? job.steps[params.stepId]
        : undefined;
    const recorded = step === undefined ? undefined : transcriptPathOf(step);
    if (recorded === undefined) throw pipelineTranscriptNotFoundError();
    const runDir = path.join(this.#executionsDir, params.executionId);
    const file = path.resolve(recorded);
    let real: { readonly runDir: string; readonly file: string };
    try {
      real = { runDir: await realpath(runDir), file: await realpath(file) };
    } catch (error) {
      if (errorCode(error) === 'ENOENT')
        throw pipelineTranscriptNotFoundError();
      throw error;
    }
    // Inside the run once every link resolves, as the host may record it
    // through another name of the data root.
    if (!isInside(real.runDir, real.file))
      throw pipelineTranscriptRefusedError(
        "This step's transcript is not a file of its run.",
      );
    return real.file;
  }

  /** The file's SHA-256, kept while its size, time and inode stay the same. */
  async #digestOf(file: string, key: string): Promise<string> {
    const kept = this.#digests.get(file);
    if (kept?.key === key) return kept.sha256;
    const sha256 = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
    this.#digests.delete(file);
    this.#digests.set(file, { key, sha256 });
    while (this.#digests.size > DIGESTS_KEPT) {
      const oldest = this.#digests.keys().next().value;
      if (oldest === undefined) break;
      this.#digests.delete(oldest);
    }
    return sha256;
  }
}
