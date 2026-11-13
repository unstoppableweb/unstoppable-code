import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { WORKER_PIPELINE_HOST_ACTIONS } from '@canopy/protocol/canopy-core';
import { PIPELINE_RUNNER_BUNDLE_LAYOUT } from './runner';

/*
 * The runner bundle's record (CAN-6200, cloud pipelines CP-10):
 * `scripts/build-pipeline-runner-bundle.mjs` writes it into the bundle, and
 * the runner reads it to report what it is at startup and to verify its own
 * files. The bundle's digest is the SHA-256 of the record's bytes, which name
 * the SHA-256 of every other file, so the digest identifies the bundle's
 * whole content.
 */

const SHA256 = /^[a-f0-9]{64}$/;

const ToolSchema = z.strictObject({
  version: z.string().min(1).max(64),
  /** The SHA-256 of the pinned upstream artifact the tool came from. */
  sha256: z.string().regex(SHA256),
});

export const PipelineRunnerBundleRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  brand: z.string().min(1).max(64),
  /** The release flavor the host was built with. */
  flavor: z.string().min(1).max(32),
  version: z.string().min(1).max(64),
  target: z.enum(['linux-x64', 'linux-arm64']),
  /** The source commit, or null for a build from a dirty or detached tree. */
  sourceSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  /** The daemon executable's file name, which is the brand's. */
  daemon: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  tools: z.strictObject({
    node: ToolSchema,
    claude: ToolSchema,
    codex: ToolSchema,
    gh: ToolSchema,
    rtk: ToolSchema,
  }),
  /** Every other file in the bundle, sorted by path. */
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1024),
        sha256: z.string().regex(SHA256),
        size: z.number().int().min(0),
        executable: z.boolean(),
      }),
    )
    .min(1),
});

export type PipelineRunnerBundleRecord = z.infer<
  typeof PipelineRunnerBundleRecordSchema
>;

export interface PipelineRunnerBundle {
  readonly record: PipelineRunnerBundleRecord;
  /** `sha256:<hex>` of the record's bytes. */
  readonly digest: string;
}

/** Reads and checks the record of the bundle at `bundleRoot`. */
export async function readPipelineRunnerBundle(
  bundleRoot: string,
): Promise<PipelineRunnerBundle> {
  const bytes = await readFile(
    path.join(bundleRoot, PIPELINE_RUNNER_BUNDLE_LAYOUT.record),
  );
  const record = PipelineRunnerBundleRecordSchema.parse(
    JSON.parse(bytes.toString('utf8')),
  );
  return {
    record,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

/**
 * What the runner reports when it starts (CP-10): its version, the bundle
 * digest a run was pinned to and the versions of the tools it bundles.
 */
export function pipelineRunnerStartedReport(bundle: PipelineRunnerBundle): {
  readonly event: 'pipeline-runner.started';
  readonly version: string;
  readonly digest: string;
  readonly brand: string;
  readonly flavor: string;
  readonly target: string;
  readonly sourceSha: string | null;
  readonly tools: Readonly<Record<string, string>>;
} {
  const { record } = bundle;
  return {
    event: 'pipeline-runner.started',
    version: record.version,
    digest: bundle.digest,
    brand: record.brand,
    flavor: record.flavor,
    target: record.target,
    sourceSha: record.sourceSha,
    tools: Object.fromEntries(
      Object.entries(record.tools).map(([name, tool]) => [name, tool.version]),
    ),
  };
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk: Buffer | string) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function bundleFiles(root: string, relative = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await bundleFiles(root, name)));
    else files.push(name);
  }
  return files;
}

/**
 * The problems with a staged bundle, empty when it is whole: a file that is
 * missing, changed, not a regular file, of the wrong mode or not in the
 * record, and a host step whose manifest is missing.
 */
export async function verifyPipelineRunnerBundle(
  bundleRoot: string,
  record: PipelineRunnerBundleRecord,
): Promise<readonly string[]> {
  const problems: string[] = [];
  const recorded = new Set(record.files.map((file) => file.path));
  for (const file of record.files) {
    const absolute = path.join(bundleRoot, ...file.path.split('/'));
    let stats: Stats;
    try {
      stats = await lstat(absolute);
    } catch {
      problems.push(`missing: ${file.path}`);
      continue;
    }
    if (!stats.isFile()) {
      problems.push(`not a regular file: ${file.path}`);
      continue;
    }
    if (((stats.mode & 0o111) !== 0) !== file.executable)
      problems.push(`wrong mode: ${file.path}`);
    if (
      stats.size !== file.size ||
      (await sha256File(absolute)) !== file.sha256
    )
      problems.push(`changed: ${file.path}`);
  }
  for (const file of await bundleFiles(bundleRoot))
    if (file !== PIPELINE_RUNNER_BUNDLE_LAYOUT.record && !recorded.has(file))
      problems.push(`not in the record: ${file}`);
  // Every host step crosses to the owner as a request, but the executor
  // still reads its manifest from the bundled actions to raise it.
  const actions = PIPELINE_RUNNER_BUNDLE_LAYOUT.bundledActions
    .split(path.sep)
    .join('/');
  for (const action of WORKER_PIPELINE_HOST_ACTIONS)
    if (!recorded.has(`${actions}/${action}/action.yml`))
      problems.push(`missing host-step manifest: ${action}`);
  return problems;
}
