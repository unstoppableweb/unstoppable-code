import { spawn } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashPipelinePackageYaml } from '@canopy/desktop-shared/node';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import {
  getStoredPipelineText,
  saveStoredPipeline,
} from '@canopy/execution-engine/pipelines/store';
import { createResourceInstallReceiptsStore } from '../../lib/resource-install-receipts';
import { recoverInterruptedPipelineInstalls } from '../pipeline-install-intents';
import {
  listPipelinePackageInstalls,
  upsertPipelinePackageInstall,
} from '../pipeline-package-install-store';
import {
  KILL_FIXTURE,
  KILL_FIXTURE_TEXT,
  killFixtureReceipt,
  killFixtureRecord,
  type KillBoundary,
} from './fixtures/pipeline-install-kill-process';

/*
 * CAN-5678: the install intent store (CAN-5633) on every desktop OS, Windows
 * included through `test:platform-services`. A separate process installs a
 * workflow, or rolls one back at startup, and is killed right after each
 * filesystem call that changes what a restart can find. The next start must
 * leave the install whole or fully rolled back, never in between.
 *
 * A kill keeps every write the OS accepted; a power cut keeps only what was
 * flushed. The ordering audit checks the traces for what power loss relies
 * on: an install record is durable before any write it covers, and every
 * write it covers is durable before the record goes. With both, a power cut
 * at any point leaves a state one of the kills already produced. Windows
 * folder flushes are API-level only (`WINDOWS_DIRECTORY_FLUSH_LABEL`), and no
 * CI runner can cut power or remount its disk between steps.
 */

jest.setTimeout(900_000);

const REPOSITORY_ROOT = resolve(__dirname, '../../../../../..');
const FIXTURE = join(__dirname, 'fixtures', 'pipeline-install-kill-process.ts');
const PARALLEL_KILLS = 4;
const INTENT_RECORD = /^pipeline-install-intents\/[0-9a-f-]{36}\.json$/;
const TEMPORARY = /(^|\/)\.[^/]+\.\d+\.[0-9a-f-]{36}\.tmp$/;

type Scenario = 'created' | 'replaced' | 'rollback' | 'recover';

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runChild(
  dataDir: string,
  scenario: Scenario,
  killAt: number,
): Promise<ChildResult> {
  const child = spawn(
    process.execPath,
    ['--require', 'tsx/cjs', FIXTURE, scenario, String(killAt)],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, CANOPY_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', (code, signal) =>
      done({ code, signal, stdout, stderr }),
    );
  });
}

function isBoundaryList(value: unknown): value is KillBoundary[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof Reflect.get(entry, 'op') === 'string' &&
        typeof Reflect.get(entry, 'path') === 'string',
    )
  );
}

async function countBoundaries(
  dataDir: string,
  scenario: Scenario,
): Promise<KillBoundary[]> {
  const result = await runChild(dataDir, scenario, 0);
  expect(result).toEqual(
    expect.objectContaining({ code: 0, signal: null, stderr: '' }),
  );
  const parsed: unknown = JSON.parse(result.stdout);
  const boundaries: unknown =
    typeof parsed === 'object' && parsed !== null
      ? Reflect.get(parsed, 'boundaries')
      : undefined;
  if (!isBoundaryList(boundaries) || boundaries.length === 0)
    throw new Error(`No boundaries reported: ${result.stdout}`);
  return boundaries;
}

async function killAt(
  dataDir: string,
  scenario: Scenario,
  boundary: number,
): Promise<void> {
  const result = await runChild(dataDir, scenario, boundary);
  // Killed: never finished, never reported an error of its own.
  expect({
    boundary,
    ...result,
    done: result.stdout.includes('"done"'),
  }).toEqual(expect.objectContaining({ boundary, done: false, stderr: '' }));
  expect(result.code === 0 && result.signal === null).toBe(false);
}

/** Runs `task` for 1..count, at most {@link PARALLEL_KILLS} at once. */
async function forEachBoundary(
  count: number,
  task: (boundary: number) => Promise<void>,
): Promise<void> {
  let next = 1;
  const worker = async (): Promise<void> => {
    while (next <= count) {
      const boundary = next;
      next += 1;
      await task(boundary);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_KILLS }, worker));
}

let roots: string[] = [];
const previousDataDir = process.env.CANOPY_DATA_DIR;

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-install-kill-'));
  roots.push(root);
  return root;
}

/** Points every store in this process at `dataDir`. */
function useDataDir(dataDir: string): void {
  process.env.CANOPY_DATA_DIR = dataDir;
}

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  for (const root of roots)
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  roots = [];
});

interface InstallState {
  readonly text: string | null;
  readonly recordHash: string | null;
  readonly recordDigest: string | null;
  readonly receiptHash: string | null;
}

const ABSENT: InstallState = {
  text: null,
  recordHash: null,
  recordDigest: null,
  receiptHash: null,
};

function stateOf(text: string, digest: string): InstallState {
  const hash = hashPipelinePackageYaml(text);
  return { text, recordHash: hash, recordDigest: digest, receiptHash: hash };
}

const INSTALLED = stateOf(KILL_FIXTURE_TEXT.installed, KILL_FIXTURE.digest);
const BEFORE = stateOf(KILL_FIXTURE_TEXT.before, KILL_FIXTURE.previousDigest);

/** The workflow, its install record and receipt in the current data root. */
async function observe(dataDir: string): Promise<InstallState> {
  useDataDir(dataDir);
  const id = KILL_FIXTURE.definitionId;
  const stored = getStoredPipelineText(id);
  const record = (
    await listPipelinePackageInstalls(
      join(dataDir, 'pipeline-package-installs.json'),
    )
  ).find((row) => row.localPipelineId === id);
  const receipt = await createResourceInstallReceiptsStore(
    KILL_FIXTURE.accountId,
  ).find('pipelines', KILL_FIXTURE.remoteId);
  return {
    text: stored.success && stored.data !== undefined ? stored.data : null,
    recordHash: record?.pipelineContentHash ?? null,
    recordDigest: record?.packageDigest ?? null,
    receiptHash: receipt?.localResourceIds?.includes(id) ? receipt.hash : null,
  };
}

/**
 * The workflow writer lock a kill left without an owner: killed between
 * creating `writer.lock` and writing its owner into it. Nothing can tell that
 * file from a live writer's until it is 30 s old (`INCOMPLETE_OWNER_GRACE_MS`
 * in owner-lock-file.ts), so a start before then cannot take the lock.
 */
function ownerlessWriterLock(dataDir: string): string | null {
  const lock = join(dataDir, 'locks', 'pipeline-definitions', 'writer.lock');
  try {
    return readFileSync(lock, 'utf8') === '' ? lock : null;
  } catch {
    return null;
  }
}

/**
 * The next start's recovery. Where a kill left the writer lock without an
 * owner, a start within the grace that has to change a workflow keeps the
 * whole install and its record for a later start, and a start after the
 * grace finishes the rollback.
 */
async function recoverAsNextStart(dataDir: string): Promise<void> {
  useDataDir(dataDir);
  const lock = ownerlessWriterLock(dataDir);
  const before = await observe(dataDir);
  const records = intentRecords(dataDir);
  await recoverInterruptedPipelineInstalls();
  if (lock === null || intentRecords(dataDir).length === 0) return;
  expect(await observe(dataDir)).toEqual(before);
  expect(intentRecords(dataDir)).toEqual(records);
  const past = new Date(Date.now() - 31_000);
  utimesSync(lock, past, past);
  await recoverInterruptedPipelineInstalls();
}

function intentRecords(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, 'pipeline-install-intents')).filter(
      (name) => /^[0-9a-f-]{36}\.json$/.test(name),
    );
  } catch {
    return [];
  }
}

/** The installed workflow an update replaces, with its record and receipt. */
async function seedBefore(dataDir: string): Promise<void> {
  useDataDir(dataDir);
  const text = KILL_FIXTURE_TEXT.before;
  const saved = saveStoredPipeline(
    {
      id: KILL_FIXTURE.definitionId,
      name: 'Before',
      description: '',
      icon: '',
      content: parsePipelineText(text),
      rawContent: text,
    },
    { id: KILL_FIXTURE.definitionId },
  );
  if (!saved.success) throw new Error(saved.error);
  await upsertPipelinePackageInstall(
    join(dataDir, 'pipeline-package-installs.json'),
    killFixtureRecord(text, KILL_FIXTURE.previousDigest),
  );
  await createResourceInstallReceiptsStore(KILL_FIXTURE.accountId).record(
    killFixtureReceipt(text),
  );
}

async function seed(dataDir: string, scenario: Scenario): Promise<void> {
  if (scenario === 'replaced') await seedBefore(dataDir);
}

/** The boundaries of one uninterrupted install, in a fresh data root. */
async function countInstall(
  scenario: 'created' | 'replaced',
): Promise<KillBoundary[]> {
  const root = newRoot();
  await seed(root, scenario);
  return countBoundaries(root, scenario);
}

function beforeOf(scenario: Scenario): InstallState {
  return scenario === 'replaced' ? BEFORE : ABSENT;
}

/** The 1-based boundary that removes the install record. */
function recordRemoval(boundaries: readonly KillBoundary[]): number {
  const index = boundaries.findIndex(
    (boundary) => boundary.op === 'remove' && INTENT_RECORD.test(boundary.path),
  );
  if (index < 0) throw new Error('The install never removed its record');
  return index + 1;
}

const parentOf = (entry: string): string =>
  entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '';

const isBookkeeping = (entry: string): boolean =>
  entry === 'locks' || entry.startsWith('locks/') || TEMPORARY.test(entry);

/**
 * What a power cut could lose at each point of a trace, as unflushed folder
 * entries and unflushed file contents. Returns every boundary at which a
 * write happened before the install record covering it was durable, or the
 * record went before a write it covers was durable.
 */
function auditFlushOrder(
  boundaries: readonly KillBoundary[],
  options: { recordAtStart: boolean },
): string[] {
  const entries = new Set<string>();
  const contents = new Set<string>();
  const violations: string[] = [];
  let record: string | null = options.recordAtStart
    ? 'pipeline-install-intents/<earlier>.json'
    : null;
  const recordDurable = (): boolean =>
    record !== null &&
    !contents.has(record) &&
    !entries.has(record) &&
    ![...entries].some(
      (entry) => entry !== '' && `${record}`.startsWith(`${entry}/`),
    );
  boundaries.forEach((boundary, index) => {
    const at = `${index + 1} ${boundary.op} ${boundary.path}`;
    const target =
      boundary.op === 'rename' || boundary.op === 'link'
        ? boundary.to
        : boundary.path;
    const covered =
      boundary.op !== 'flush' &&
      !isBookkeeping(target) &&
      !target.startsWith('pipeline-install-intents') &&
      !(boundary.op === 'create' && !boundary.directory);
    if (covered && !recordDurable())
      violations.push(`${at}: written before its install record was durable`);
    if (boundary.op === 'remove' && INTENT_RECORD.test(boundary.path)) {
      const lost = [
        ...[...entries].filter(
          (entry) => !isBookkeeping(entry) && entry !== boundary.path,
        ),
        ...[...contents].filter((file) => !isBookkeeping(file)),
      ];
      if (lost.length > 0)
        violations.push(
          `${at}: record removed while ${lost.join(', ')} could still be lost`,
        );
      record = null;
    }
    switch (boundary.op) {
      case 'create':
        entries.add(boundary.path);
        if (!boundary.directory) contents.add(boundary.path);
        break;
      case 'rename':
        entries.add(boundary.path);
        entries.add(boundary.to);
        if (contents.delete(boundary.path)) contents.add(boundary.to);
        else contents.delete(boundary.to);
        if (INTENT_RECORD.test(boundary.to)) record = boundary.to;
        break;
      case 'link':
        entries.add(boundary.to);
        if (contents.has(boundary.path)) contents.add(boundary.to);
        break;
      case 'remove':
        entries.add(boundary.path);
        for (const file of [...contents])
          if (file === boundary.path || file.startsWith(`${boundary.path}/`))
            contents.delete(file);
        break;
      case 'flush':
        if (boundary.directory) {
          for (const entry of [...entries])
            if (parentOf(entry) === boundary.path) entries.delete(entry);
        } else contents.delete(boundary.path);
        break;
    }
  });
  return violations;
}

describe('pipeline install kill qualification (CAN-5678)', () => {
  const installs: readonly ('created' | 'replaced')[] = ['created', 'replaced'];

  it.each(installs)(
    'a %s install killed at any boundary is whole or rolled back after the next start',
    async (scenario) => {
      const counted = newRoot();
      await seed(counted, scenario);
      const boundaries = await countBoundaries(counted, scenario);
      expect(await observe(counted)).toEqual(INSTALLED);
      const removal = recordRemoval(boundaries);
      const killed: string[] = [];
      for (let boundary = 1; boundary <= boundaries.length; boundary += 1) {
        const root = newRoot();
        await seed(root, scenario);
        killed.push(root);
      }
      await forEachBoundary(boundaries.length, (boundary) =>
        killAt(killed[boundary - 1], scenario, boundary),
      );
      for (let boundary = 1; boundary <= boundaries.length; boundary += 1) {
        const root = killed[boundary - 1];
        await recoverAsNextStart(root);
        expect({ boundary, state: await observe(root) }).toEqual({
          boundary,
          state: boundary >= removal ? INSTALLED : beforeOf(scenario),
        });
        expect({ boundary, intents: intentRecords(root) }).toEqual({
          boundary,
          intents: [],
        });
      }
    },
  );

  it.each(installs)(
    'a startup rollback of a %s install killed at any boundary is finished by the next start',
    async (scenario) => {
      // Every write made, the record still there: the start rolls it all back.
      const partial = newRoot();
      await seed(partial, scenario);
      const install = await countInstall(scenario);
      await killAt(partial, scenario, recordRemoval(install) - 1);
      expect(intentRecords(partial)).toHaveLength(1);
      const counted = newRoot();
      cpSync(partial, counted, { recursive: true });
      const boundaries = await countBoundaries(counted, 'recover');
      expect(await observe(counted)).toEqual(beforeOf(scenario));
      const killed: string[] = [];
      for (let boundary = 1; boundary <= boundaries.length; boundary += 1) {
        const root = newRoot();
        cpSync(partial, root, { recursive: true });
        killed.push(root);
      }
      await forEachBoundary(boundaries.length, (boundary) =>
        killAt(killed[boundary - 1], 'recover', boundary),
      );
      for (let boundary = 1; boundary <= boundaries.length; boundary += 1) {
        const root = killed[boundary - 1];
        await recoverAsNextStart(root);
        expect({ boundary, state: await observe(root) }).toEqual({
          boundary,
          state: beforeOf(scenario),
        });
        expect({ boundary, intents: intentRecords(root) }).toEqual({
          boundary,
          intents: [],
        });
      }
    },
  );

  const audited: readonly ('created' | 'replaced' | 'rollback')[] = [
    'created',
    'replaced',
    'rollback',
  ];
  it.each(audited)(
    'a %s install flushes each write before the step that relies on it',
    async (scenario) => {
      const root = newRoot();
      await seed(root, scenario);
      const boundaries = await countBoundaries(root, scenario);
      expect(auditFlushOrder(boundaries, { recordAtStart: false })).toEqual([]);
    },
  );

  it.each(installs)(
    'a startup rollback of a %s install flushes each undo before its record goes',
    async (scenario) => {
      const root = newRoot();
      await seed(root, scenario);
      const install = await countInstall(scenario);
      await killAt(root, scenario, recordRemoval(install) - 1);
      const boundaries = await countBoundaries(root, 'recover');
      expect(auditFlushOrder(boundaries, { recordAtStart: true })).toEqual([]);
    },
  );
});
