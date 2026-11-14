import { constants } from 'node:fs';
import { copyFile, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { relocateCheckoutPath } from '@canopy/execution-engine/node/pipelines/executor/execution-checkout-location';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';
import {
  InternalRootMigrationRefused,
  matchesInternalRootNodeIdentity,
  type InternalRootIdentity,
  type InternalRootMigrationWorker,
} from '@canopy/core-runtime/node/internal-root-migration';
import { isWithin } from '@canopy/core-runtime/node/relocation';
import type { InternalRootFilesystemHost } from './filesystem-host';
import {
  durableJson,
  flush,
  privateDirectory,
  statIfPresent,
} from './filesystem';
import { internalRootMigrationProgress } from './progress';

/** Raw JSON only: execution parsing would discard old-root recovery transcripts. */
function rebaseRecord(
  state: Record<string, unknown>,
  source: string,
  destination: string,
): void {
  const rewrites = [{ fromRoot: source, toRoot: destination }];
  function path(value: unknown): unknown {
    return typeof value === 'string' && !/[\r\n\0]/.test(value)
      ? relocateCheckoutPath(value, rewrites)
      : value;
  }
  function fields(value: unknown, keys: readonly string[]): void {
    if (!isRecord(value)) return;
    for (const key of keys) if (key in value) value[key] = path(value[key]);
  }
  function values(value: unknown): void {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === 'string') value[i] = path(value[i]);
        else values(value[i]);
      }
    } else if (isRecord(value)) {
      for (const key of Object.keys(value)) {
        if (typeof value[key] === 'string') value[key] = path(value[key]);
        else values(value[key]);
      }
    }
  }
  function result(value: unknown): void {
    if (!isRecord(value)) return;
    fields(value, ['log_file']);
    fields(value.report_outputs, ['report_file', 'report_json_file']);
    fields(value.agent_recovery, ['transcript_file']);
    if (Array.isArray(value.agent_recovery_history))
      for (const recovery of value.agent_recovery_history)
        fields(recovery, ['log_file']);
    values(value.outputs);
    if (isRecord(value.steps))
      for (const step of Object.values(value.steps)) result(step);
    for (const key of ['retry_history', 'iteration_history', 'children'])
      if (Array.isArray(value[key]))
        for (const entry of value[key]) result(entry);
  }
  fields(state, [
    'cwd',
    'repo_path',
    'execution_checkout_root',
    'pipeline_file_dir',
    'global_workspace_dir',
  ]);
  fields(state.target, ['path']);
  fields(state.env, ['CANOPY_OUTPUT_DIR']);
  fields(state.shared_pipeline_source, ['cachedPipelinePath']);
  fields(state.curated_pipeline_source, ['cachedPipelinePath']);
  fields(state.pipeline_package_snapshot, ['cachedPackagePath']);
  if (isRecord(state.pipeline_assets)) {
    fields(state.pipeline_assets, ['pipeline_data_dir', 'assets_dir']);
    if (isRecord(state.pipeline_assets.asset_paths))
      fields(
        state.pipeline_assets.asset_paths,
        Object.keys(state.pipeline_assets.asset_paths),
      );
  }
  if (isRecord(state.event_data)) {
    fields(state.event_data.task_ready, ['task_path', 'plan_path']);
    fields(state.event_data.plan_ready, ['plan_path']);
  }
  values(state.inputs);
  result(state);
  if (isRecord(state.jobs))
    for (const job of Object.values(state.jobs)) result(job);
}

/** Called only under the offline migration's cold proof and coordination lock. */
export async function relocateInternalRootPipelineRecords(
  identity: InternalRootIdentity,
  workingRoot: string,
  host: InternalRootFilesystemHost,
  options: {
    readonly verifyOnly?: boolean;
    readonly retainPreimages?: boolean;
  } = {},
): Promise<{ inspected: number; updated: number }> {
  if (
    resolve(workingRoot) !== workingRoot ||
    isWithin(identity.source, workingRoot) ||
    (await realpath(workingRoot)) !== workingRoot
  )
    throw new Error(
      'Pipeline record repair requires a canonical destination, never the source',
    );
  const directory = join(workingRoot, 'pipeline-executions');
  const stat = await statIfPresent(directory);
  if (!stat) return { inspected: 0, updated: 0 };
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  )
    throw new Error(`Unsafe pipeline execution directory: ${directory}`);
  const images: Array<{
    file: string;
    raw: string;
    state: Record<string, unknown>;
  }> = [];
  let inspected = 0;
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith('.json')) continue;
    const file = join(directory, name);
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
      throw new Error(`Unsafe pipeline execution record: ${file}`);
    const raw = await readFile(file, 'utf8');
    let state: unknown;
    try {
      state = JSON.parse(raw);
    } catch {
      throw new Error(`Unreadable pipeline execution record: ${file}`);
    }
    if (
      !isRecord(state) ||
      typeof state.id !== 'string' ||
      `${state.id}.json` !== name
    )
      throw new Error(`Invalid pipeline execution record: ${file}`);
    inspected++;
    rebaseRecord(state, identity.source, identity.destination);
    if (!isDeepStrictEqual(state, JSON.parse(raw)))
      images.push({ file, raw, state });
    internalRootMigrationProgress(`Pipeline records: ${inspected} inspected`);
  }
  if (options.verifyOnly && images.length)
    throw new Error(
      `Pipeline execution records still require relocation: ${images[0]?.file}`,
    );
  for (const { file, raw, state } of images) {
    if ((await readFile(file, 'utf8')) !== raw)
      throw new Error(
        `Pipeline execution record changed during offline repair: ${file}`,
      );
    if (options.retainPreimages) {
      const backup = `${file}.before-root-rebase`;
      const previous = await statIfPresent(backup);
      if (previous) {
        if (
          !previous.isFile() ||
          previous.isSymbolicLink() ||
          previous.nlink !== 1 ||
          (await readFile(backup, 'utf8')) !== raw
        )
          throw new Error(
            `Conflicting pipeline preimage; preserve it for recovery: ${backup}`,
          );
      } else {
        await copyFile(file, backup, constants.COPYFILE_EXCL);
        await flush(backup);
        await flush(directory);
      }
    }
    await durableJson(file, state, host);
  }
  return { inspected, updated: images.length };
}

/** Recovery for completed migrations; never rebuilds or reads the retained source. */
export async function repairCompletedInternalRootPipelineRecords(options: {
  readonly identity: InternalRootIdentity;
  readonly worker: InternalRootMigrationWorker;
  readonly host: InternalRootFilesystemHost;
}): Promise<{ inspected: number; updated: number }> {
  const { identity, worker, host } = options;
  const coldIdentity = { ...identity, source: identity.destination };
  await worker.proveCold(coldIdentity);
  const release = await worker.coordinate(identity);
  try {
    const journal = await worker.readJournal(identity);
    const root = await lstat(identity.destination, { bigint: true });
    if (
      journal?.phase !== 'complete' ||
      journal.secureRelocation !== 'complete' ||
      !matchesInternalRootNodeIdentity(
        `${root.dev}:${root.ino}`,
        journal.publicationIdentity,
        worker.os,
      )
    )
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'Pipeline repair requires the completed migration and its original published destination. Preserve both roots and the journal.',
      );
    await privateDirectory(identity.destination, host);
    await worker.proveCold(coldIdentity);
    const result = await relocateInternalRootPipelineRecords(
      identity,
      identity.destination,
      host,
      { retainPreimages: true },
    );
    await relocateInternalRootPipelineRecords(
      identity,
      identity.destination,
      host,
      { verifyOnly: true },
    );
    return result;
  } finally {
    await release();
  }
}
