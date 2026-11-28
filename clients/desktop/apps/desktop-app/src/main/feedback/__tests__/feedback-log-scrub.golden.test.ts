/**
 * CAN-7620: credential-shaped text in the logs a feedback bundle copies never
 * reaches the bundle. main.log is checked one logger entry at a time (a header
 * line and its continuation lines), the diagnostics and audit JSONL one record
 * at a time, and the observability snapshot as a whole document. A tripped unit
 * is replaced by a neutral marker; everything else is copied byte for byte.
 * Every value below is a fake built at runtime, and every file is a fixture in
 * a temp root: no real log or app data directory is read.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';
import { BRAND } from '@canopy/brand/current';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { findSecretMaterialRule } from '@canopy/protocol/capability-files';
import { findSharedTextCredentialRule } from '@canopy/protocol/shared-containers';
import type { MainLogFlushResult } from '../../lib/async-main-log-sink';

const mockPaths = { logs: '' };
jest.mock('electron', () => ({
  app: {
    getPath: (name: string): string =>
      name === 'logs' ? mockPaths.logs : tmpdir(),
    getVersion: (): string => '0.0.0-test',
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: (): never[] => [] },
}));
// Linux keeps includeAppLogs away from macOS DiagnosticReports under ~/Library.
jest.mock('@canopy/core-platform', () => ({
  ...jest.requireActual<object>('@canopy/core-platform'),
  hostPlatformOperatingSystem: (): string => 'linux',
}));
jest.mock('../../lib/main-process-logging', () => ({
  ...jest.requireActual<object>('../../lib/main-process-logging'),
  flushMainProcessLogging: (): Promise<MainLogFlushResult> =>
    Promise.resolve({
      throughSequence: 0,
      writtenRecords: 0,
      failedRecords: 0,
      droppedRecords: 0,
      failedGapNotices: 0,
    }),
}));

import {
  FeedbackBundleBuilder,
  MAX_FEEDBACK_MANIFEST_BYTES,
} from '../feedback-archive';
import { feedbackLogsForTests } from '../feedback-bundle';
import {
  createFeedbackScrub,
  feedbackScrubForTests,
  type FeedbackScrubMode,
  withheldIfCredential,
} from '../feedback-scrub';
import {
  getAgentObservabilityAppEventsDayFilePath,
  getAgentObservabilityAuditDayFilePath,
  getAgentObservabilitySessionEventsDayFilePath,
  getAgentObservabilitySnapshotPath,
  getDataDir,
  getHookInvocationsDir,
  getWorkspaceScriptRunDir,
  w5RecordReadPaths,
} from '../../lib/paths';

const MANIFEST: Parameters<FeedbackBundleBuilder['addManifest']>[0] = {
  version: 1,
  preparedAt: '2026-11-23T00:00:00.000Z',
  description: 'log scrub golden',
  area: 'overview',
  workspaceSelections: [],
  chatProjectIds: [],
  includeChatDetails: false,
  includePipelineExecutions: false,
  app: {
    version: '0.0.0-test',
    runtimeMode: 'dev',
    platform: 'linux',
    arch: 'arm64',
    electron: undefined,
    node: process.versions.node,
  },
  machine: {
    hostname: 'golden',
    osType: 'Linux',
    osRelease: '0',
    osVersion: '0',
    totalMemoryBytes: 0,
    cpuCount: 1,
  },
  modelHarnessAssignments: {
    persistenceSchemaVersion: 1,
    revision: 0,
    assignments: {},
  },
};

const MAIN_LOG_ZIP_PATH = `system-logs/${BRAND.internalName}-ui/main.log`;
const DAY = '2026-11-23';

/** A fake credential and a run of its text no marker or clean line contains. */
interface Fake {
  text: string;
  body: string;
}

function fake(text: string, body: string): Fake {
  return { text, body };
}

// Assembled from parts so this file never holds a credential-shaped literal.
const FAKES: Record<string, Fake> = {
  githubPat: fake(`github${'_pat_'}${'A1b2'.repeat(6)}`, 'A1b2A1b2A1b2'),
  githubToken: fake(`gh${'p_'}${'C3d4'.repeat(9)}`, 'C3d4C3d4C3d4'),
  slackToken: fake(`xox${'b-'}2468-${'E5f6'.repeat(3)}`, 'E5f6E5f6E5f6'),
  npmToken: fake(`npm${'_'}${'G7h8'.repeat(9)}`, 'G7h8G7h8G7h8'),
  awsKey: fake(`AK${'IA'}J9K8L7M6N5P4Q3R2`, 'J9K8L7M6N5P4Q3R2'),
  apiKey: fake(`s${'k-'}${'S1t2'.repeat(5)}`, 'S1t2S1t2S1t2'),
  authHeader: fake(`Authori${'zation'}: Basic ${'U3V4'.repeat(3)}`, 'U3V4U3V4'),
  bearer: fake(`Bear${'er'} ${'W5x6'.repeat(5)}`, 'W5x6W5x6W5x6'),
  passwordAssignment: fake(`pass${'word'}=${'Y7z8'.repeat(3)}`, 'Y7z8Y7z8Y7z8'),
  tokenField: fake(`"tok${'en'}": "${'a9B0'.repeat(4)}"`, 'a9B0a9B0a9B0'),
  envAssignment: fake(`API${'_KEY'}=${'c1D2'.repeat(3)}`, 'c1D2c1D2c1D2'),
  urlPassword: fake(
    `postgres://admin:${'e3F4'.repeat(3)}@db.example.test/app`,
    'e3F4e3F4e3F4',
  ),
  jwt: fake(
    `ey${'J'}${'g5H6'.repeat(2)}.ey${'J'}${'i7J8'.repeat(2)}.${'k9L0'.repeat(2)}`,
    'g5H6g5H6',
  ),
};
const PEM_BEGIN = `-----BEGIN ${'PRIVATE'} KEY-----`;
const PEM_BODY = ['MIIEvQ' + 'm1N2'.repeat(10), 'q3R4'.repeat(12)];
const PEM_END = `-----END ${'PRIVATE'} KEY-----`;

const ENTRY_WITHHELD =
  'Log entry withheld because it looks like it holds a credential';
const ENTRY_TOO_LONG =
  'Log entry withheld because it is too long to check for credentials';
const FIELD_WITHHELD = 'Withheld because it looks like it holds a credential';

function looksLikeCredential(text: string): boolean {
  return (
    findSharedTextCredentialRule(text) !== null ||
    findSecretMaterialRule(text) !== null
  );
}

/** An entry prefix as electron-log writes it: the level padded to align text. */
function header(time: string, level: string): string {
  return `[2026-11-23 ${time}] [${`${level}]`.padEnd(6)} `;
}

/** The parts of electron-log's own formatter that write a main.log prefix. */
interface ElectronLogFormat {
  format(input: {
    message: { data: unknown[]; date: Date; level: string };
    logger: object;
    transport: { format: string };
  }): unknown[];
  concatFirstStringElements(input: { data: unknown[] }): unknown[];
}

// main.log's file format (lib/main-process-logging.ts).
const MAIN_LOG_FORMAT = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

function entry(time: string, level: string, text: string): string {
  return `${header(time, level)}${text}\n`;
}

const CLEAN_ENTRIES = [
  entry(
    '00:30:00.001',
    'info',
    "Main process file logging initialized { logPath: '/home/example/.config/app/logs/main.log' }",
  ),
  entry(
    '00:30:00.002',
    'warn',
    "[shared-containers] failed to rehydrate or recover publication state Error: ENOENT: no such file or directory, open '/home/example/data/index.json'\n" +
      '    at async open (node:internal/fs/promises:639:25)\n' +
      '    at async readFile (node:internal/fs/promises:1242:14)',
  ),
  entry(
    '00:30:00.003',
    'info',
    '[workspace] opened 3f2b9c1e-0d4a-4c1e-9a7b-2b8f0e6d1a42 at 7d3c9a1b0e2f4d6c8a0b1c3d5e7f9a1b2c3d4e5f',
  ),
];

let root: string;
let dataDir: string;
const previousDataDir = process.env.CANOPY_DATA_DIR;
const previousHomeDir = process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'feedback-log-scrub-'));
  dataDir = join(root, 'data');
  mockPaths.logs = join(root, 'logs');
  process.env.CANOPY_DATA_DIR = dataDir;
  process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST = join(root, 'home');
  resetResolvedCanopyDataDirForTests();
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
  if (previousHomeDir === undefined)
    delete process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST;
  else process.env.FEEDBACK_BUNDLE_HOME_DIR_FOR_TEST = previousHomeDir;
  resetResolvedCanopyDataDirForTests();
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, bytes: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function zipFile(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) =>
    openZip(path, { lazyEntries: true }, (error, zip) =>
      error || !zip
        ? reject(error ?? new Error('Bundle could not be opened'))
        : resolve(zip),
    ),
  );
}

async function readZip(path: string): Promise<Map<string, Buffer>> {
  const zip = await zipFile(path);
  return new Promise((resolve, reject) => {
    const files = new Map<string, Buffer>();
    zip.on('error', reject);
    zip.on('entry', (item: Entry) => {
      zip.openReadStream(item, (error, stream) => {
        if (error || !stream) {
          reject(error ?? new Error('Bundle entry could not be read'));
          return;
        }
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => {
          files.set(item.fileName, Buffer.concat(chunks));
          zip.readEntry();
        });
      });
    });
    zip.once('end', () => resolve(files));
    zip.readEntry();
  });
}

/** Collects into a real builder, writes the zip and reads every entry back. */
async function bundle(
  collect: (builder: FeedbackBundleBuilder) => Promise<void>,
): Promise<Map<string, Buffer>> {
  const builder = new FeedbackBundleBuilder();
  await collect(builder);
  builder.addManifest(MANIFEST);
  const zipPath = join(root, 'bundle.zip');
  await builder.writeTo(await open(zipPath, 'w'));
  return readZip(zipPath);
}

async function bundledMainLog(contents: string | Buffer): Promise<Buffer> {
  await put(join(mockPaths.logs, 'main.log'), contents);
  const files = await bundle(feedbackLogsForTests.includeAppLogs);
  const log = files.get(MAIN_LOG_ZIP_PATH);
  if (log === undefined) throw new Error('main.log is not in the bundle');
  return log;
}

async function bundledDiagnostics(): Promise<Map<string, Buffer>> {
  return bundle(feedbackLogsForTests.includeCoreDiagnostics);
}

function zipPathOf(path: string): string {
  return relative(getDataDir(), path).split(sep).join('/');
}

function holdsAnyBody(bytes: Buffer, fakes: readonly Fake[]): boolean {
  const text = bytes.toString('utf8');
  return fakes.some((item) => text.includes(item.body));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('the seeded fakes (precondition)', () => {
  it('every fake trips the shared credential check and no clean entry does', () => {
    for (const item of Object.values(FAKES))
      expect(looksLikeCredential(item.text)).toBe(true);
    expect(looksLikeCredential(PEM_BEGIN)).toBe(true);
    for (const line of PEM_BODY) expect(looksLikeCredential(line)).toBe(false);
    for (const clean of CLEAN_ENTRIES)
      expect(looksLikeCredential(clean)).toBe(false);
  });
});

describe('main.log in a feedback bundle (CAN-7620)', () => {
  it('builds entry prefixes exactly as the installed electron-log formatter writes them', () => {
    const formatter = jest.requireActual<ElectronLogFormat>(
      'electron-log/src/core/transforms/format.js',
    );
    for (const level of [
      'error',
      'warn',
      'info',
      'verbose',
      'debug',
      'silly',
    ]) {
      const data = formatter.format({
        message: {
          data: ['[shared-containers] text'],
          date: new Date(2026, 10, 23, 0, 31, 2, 123),
          level,
        },
        logger: {},
        transport: { format: MAIN_LOG_FORMAT },
      });
      expect(formatter.concatFirstStringElements({ data })).toEqual([
        `${header('00:31:02.123', level)}[shared-containers] text`,
      ]);
    }
  });

  it('keeps the scope of info and warn entries, whose level electron-log pads', async () => {
    const log = await bundledMainLog(
      entry(
        '00:31:03.000',
        'info',
        `[shared-containers] refreshed ${FAKES.bearer.text}`,
      ) +
        entry(
          '00:31:04.000',
          'warn',
          `[shared-containers] failed ${FAKES.githubToken.text}`,
        ) +
        CLEAN_ENTRIES[0],
    );
    expect(holdsAnyBody(log, [FAKES.bearer, FAKES.githubToken])).toBe(false);
    expect(log.toString('utf8')).toBe(
      `${header('00:31:03.000', 'info')}[shared-containers] ${ENTRY_WITHHELD}\n` +
        `${header('00:31:04.000', 'warn')}[shared-containers] ${ENTRY_WITHHELD}\n` +
        CLEAN_ENTRIES[0],
    );
  });

  it('replaces a token-shaped entry with a marker that keeps its timestamp, level and scope', async () => {
    const log = await bundledMainLog(
      CLEAN_ENTRIES[0] +
        entry(
          '00:31:02.123',
          'warn',
          `[shared-containers] failed to recover fork capability installs ${FAKES.githubToken.text}`,
        ) +
        CLEAN_ENTRIES[1],
    );
    expect(holdsAnyBody(log, [FAKES.githubToken])).toBe(false);
    expect(log.toString('utf8')).toBe(
      CLEAN_ENTRIES[0] +
        `${header('00:31:02.123', 'warn')}[shared-containers] ${ENTRY_WITHHELD}\n` +
        CLEAN_ENTRIES[1],
    );
  });

  it('withholds an entry for each credential family and keeps every clean entry', async () => {
    const fakes = Object.values(FAKES);
    const seeded = fakes
      .map((item, index) =>
        entry(
          `00:32:${String(index).padStart(2, '0')}.000`,
          'error',
          `[net] request failed: ${item.text}`,
        ),
      )
      .join('');
    const log = await bundledMainLog(CLEAN_ENTRIES.join('') + seeded);
    expect(holdsAnyBody(log, fakes)).toBe(false);
    expect(log.toString('utf8')).toBe(
      CLEAN_ENTRIES.join('') +
        fakes
          .map(
            (_item, index) =>
              `${header(`00:32:${String(index).padStart(2, '0')}.000`, 'error')}[net] ${ENTRY_WITHHELD}\n`,
          )
          .join(''),
    );
  });

  it('withholds a whole multi-line entry, so no line of a private key body survives', async () => {
    const log = await bundledMainLog(
      entry(
        '00:33:00.000',
        'error',
        [
          '[plugins] could not parse a key',
          PEM_BEGIN,
          ...PEM_BODY,
          PEM_END,
        ].join('\n'),
      ) + CLEAN_ENTRIES[2],
    );
    const text = log.toString('utf8');
    for (const line of PEM_BODY) expect(text.includes(line)).toBe(false);
    expect(text).toBe(
      `${header('00:33:00.000', 'error')}[plugins] ${ENTRY_WITHHELD}\n` +
        CLEAN_ENTRIES[2],
    );
  });

  it('catches a token that straddles a read chunk boundary', async () => {
    const secret = `${header('00:34:00.000', 'warn')}[sync] ${FAKES.awsKey.text}\n`;
    const tokenOffset = secret.indexOf(FAKES.awsKey.text);
    // The token starts 6 bytes before the 64 KiB read boundary.
    const fillerLength = 65_536 - 6 - tokenOffset;
    const fillerPrefix = header('00:33:59.000', 'info');
    const filler = `${fillerPrefix}${'x'.repeat(fillerLength - fillerPrefix.length - 1)}\n`;
    expect(filler.length + tokenOffset).toBe(65_530);
    const log = await bundledMainLog(filler + secret + CLEAN_ENTRIES[2]);
    expect(holdsAnyBody(log, [FAKES.awsKey])).toBe(false);
    expect(log.toString('utf8')).toBe(
      filler +
        `${header('00:34:00.000', 'warn')}[sync] ${ENTRY_WITHHELD}\n` +
        CLEAN_ENTRIES[2],
    );
  });

  it('checks a last entry the logger had not finished, without adding a newline', async () => {
    const log = await bundledMainLog(
      CLEAN_ENTRIES[0] +
        `${header('00:35:00.000', 'info')}[auth] refreshed ${FAKES.bearer.text}`,
    );
    expect(holdsAnyBody(log, [FAKES.bearer])).toBe(false);
    expect(log.toString('utf8')).toBe(
      CLEAN_ENTRIES[0] +
        `${header('00:35:00.000', 'info')}[auth] ${ENTRY_WITHHELD}`,
    );
  });

  it('checks the lines before the first entry header as one entry', async () => {
    const log = await bundledMainLog(
      `left over from rotation ${FAKES.passwordAssignment.text}\nsecond stray line\n` +
        CLEAN_ENTRIES[0],
    );
    expect(holdsAnyBody(log, [FAKES.passwordAssignment])).toBe(false);
    expect(log.toString('utf8')).toBe(`${ENTRY_WITHHELD}\n` + CLEAN_ENTRIES[0]);
  });

  it('withholds an entry longer than the 256 KiB check limit, keeping its prefix', async () => {
    const long = entry(
      '00:36:00.000',
      'debug',
      `[code-graph] dump\n${'y'.repeat(300 * 1024)}`,
    );
    const log = await bundledMainLog(
      CLEAN_ENTRIES[0] + long + CLEAN_ENTRIES[1],
    );
    expect(log.toString('utf8')).toBe(
      CLEAN_ENTRIES[0] +
        `${header('00:36:00.000', 'debug')}[code-graph] ${ENTRY_TOO_LONG}\n` +
        CLEAN_ENTRIES[1],
    );
  });

  it('copies a clean log byte for byte, including invalid UTF-8 and CRLF', async () => {
    const clean = Buffer.concat([
      Buffer.from(CLEAN_ENTRIES.join(''), 'utf8'),
      Buffer.from(header('00:37:00.000', 'info'), 'utf8'),
      Buffer.from([0x62, 0xff, 0xfe, 0x61, 0x0a]),
      Buffer.from(`${header('00:37:00.001', 'info')}windows line\r\n`, 'utf8'),
    ]);
    const log = await bundledMainLog(clean);
    expect(sha256(log)).toBe(sha256(clean));
  });
});

function jsonl(...records: unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

describe('observability JSONL in a feedback bundle (CAN-7620)', () => {
  const cleanSession = {
    version: 1,
    timestamp: '2026-11-23T00:30:00.000Z',
    kind: 'code_graph_build',
    sessionKey: 'session-1',
    projectId: '',
    worktreeId: '',
    chatId: '',
    providerType: 'unknown',
  };

  it('session-events: withholds a main_error_detail record, keeping only a checked timestamp and kind', async () => {
    const path = getAgentObservabilitySessionEventsDayFilePath(DAY);
    await put(
      path,
      jsonl(
        cleanSession,
        {
          ...cleanSession,
          timestamp: '2026-11-23T00:31:00.000Z',
          kind: 'main_error_detail',
          sessionKey: 'main-process',
          error: `Error: upstream answered {"pass${'word'}": "${FAKES.passwordAssignment.body}"}`,
        },
        {
          ...cleanSession,
          timestamp: '2026-11-23T00:31:01.000Z',
          kind: FAKES.githubToken.text,
        },
      ),
    );
    const file = (await bundledDiagnostics()).get(zipPathOf(path));
    if (file === undefined)
      throw new Error('session-events is not in the bundle');
    expect(
      holdsAnyBody(file, [FAKES.passwordAssignment, FAKES.githubToken]),
    ).toBe(false);
    expect(file.toString('utf8')).toBe(
      jsonl(
        cleanSession,
        {
          withheld: 'looks like it holds a credential',
          timestamp: '2026-11-23T00:31:00.000Z',
          kind: 'main_error_detail',
        },
        {
          withheld: 'looks like it holds a credential',
          timestamp: '2026-11-23T00:31:01.000Z',
        },
      ),
    );
  });

  it('app-events: withholds a record whose stack frame holds a token', async () => {
    const path = getAgentObservabilityAppEventsDayFilePath(DAY);
    const clean = {
      version: 1,
      timestamp: '2026-11-23T00:32:00.000Z',
      kind: 'main_uncaught_exception',
      error: { name: 'Error', frames: ['at handler (/app/main.js:1:2)'] },
    };
    await put(
      path,
      jsonl(clean, {
        ...clean,
        timestamp: '2026-11-23T00:32:01.000Z',
        error: {
          name: 'Error',
          frames: [`at fetch (${FAKES.slackToken.text})`],
        },
      }),
    );
    const file = (await bundledDiagnostics()).get(zipPathOf(path));
    if (file === undefined) throw new Error('app-events is not in the bundle');
    expect(holdsAnyBody(file, [FAKES.slackToken])).toBe(false);
    expect(file.toString('utf8')).toBe(
      jsonl(clean, {
        withheld: 'looks like it holds a credential',
        timestamp: '2026-11-23T00:32:01.000Z',
        kind: 'main_uncaught_exception',
      }),
    );
  });

  it('audit: withholds a record whose provider error holds a key', async () => {
    const path = getAgentObservabilityAuditDayFilePath(DAY);
    const clean = {
      id: 'audit-1',
      eventType: 'chat',
      status: 'completed',
      startedAt: '2026-11-23T00:33:00.000Z',
      label: 'Fix the build',
      hasTranscript: false,
    };
    await put(
      path,
      jsonl(clean, {
        ...clean,
        id: 'audit-2',
        status: 'failed',
        error: `401 from the provider for ${FAKES.apiKey.text}`,
      }),
    );
    const file = (await bundledDiagnostics()).get(zipPathOf(path));
    if (file === undefined)
      throw new Error('the audit log is not in the bundle');
    expect(holdsAnyBody(file, [FAKES.apiKey])).toBe(false);
    expect(file.toString('utf8')).toBe(
      jsonl(clean, { withheld: 'looks like it holds a credential' }),
    );
  });

  it('withholds a record longer than the 256 KiB check limit', async () => {
    const path = getAgentObservabilitySessionEventsDayFilePath(DAY);
    await put(
      path,
      jsonl(cleanSession, { ...cleanSession, note: 'z'.repeat(300 * 1024) }),
    );
    const file = (await bundledDiagnostics()).get(zipPathOf(path));
    if (file === undefined)
      throw new Error('session-events is not in the bundle');
    expect(file.toString('utf8')).toBe(
      jsonl(cleanSession, { withheld: 'too long to check for credentials' }),
    );
  });

  it('copies clean JSONL byte for byte', async () => {
    const path = getAgentObservabilityAuditDayFilePath(DAY);
    const clean = Buffer.from(
      jsonl({ id: 'audit-3', label: 'Ünïcode label' }) +
        '\n' +
        '{"id":"audit-4"}',
      'utf8',
    );
    await put(path, clean);
    const file = (await bundledDiagnostics()).get(zipPathOf(path));
    if (file === undefined)
      throw new Error('the audit log is not in the bundle');
    expect(sha256(file)).toBe(sha256(clean));
  });
});

describe('the observability snapshot in a feedback bundle (CAN-7620)', () => {
  const snapshot = (error: string): string =>
    `${JSON.stringify(
      {
        version: 1,
        recentEntries: [{ id: 'audit-1', status: 'failed', error }],
        usage: { updatedAt: '2026-11-23T00:00:00.000Z' },
      },
      null,
      2,
    )}\n`;

  it('withholds the whole document when any part of it holds a credential', async () => {
    await put(
      getAgentObservabilitySnapshotPath(),
      snapshot(`bad key ${FAKES.envAssignment.text}`),
    );
    const file = (await bundledDiagnostics()).get(
      zipPathOf(getAgentObservabilitySnapshotPath()),
    );
    if (file === undefined)
      throw new Error('the snapshot is not in the bundle');
    expect(holdsAnyBody(file, [FAKES.envAssignment])).toBe(false);
    expect(file.toString('utf8')).toBe(
      '{"withheld":"looks like it holds a credential"}\n',
    );
  });

  it('copies a clean snapshot byte for byte', async () => {
    const clean = snapshot('the provider timed out');
    await put(getAgentObservabilitySnapshotPath(), clean);
    const file = (await bundledDiagnostics()).get(
      zipPathOf(getAgentObservabilitySnapshotPath()),
    );
    if (file === undefined)
      throw new Error('the snapshot is not in the bundle');
    expect(file.toString('utf8')).toBe(clean);
  });
});

describe('pipeline execution errors in a feedback bundle (CAN-7620)', () => {
  async function sanitized(state: unknown): Promise<unknown> {
    const source = join(root, 'pipeline-state.json');
    await put(source, JSON.stringify(state));
    const files = await bundle((builder) =>
      feedbackLogsForTests.addSanitizedPipelineExecutionState(
        builder,
        source,
        'pipeline-executions/exec-1.json',
      ),
    );
    const file = files.get('pipeline-executions/exec-1.json');
    if (file === undefined)
      throw new Error('the execution state is not in the bundle');
    return JSON.parse(file.toString('utf8'));
  }

  it('withholds an execution error that holds a credential and keeps a clean one', async () => {
    expect(
      await sanitized({
        version: 1,
        id: 'exec-1',
        error: `step failed: ${FAKES.jwt.text}`,
      }),
    ).toEqual({ version: 1, id: 'exec-1', error: FIELD_WITHHELD });
    expect(
      await sanitized({
        version: 1,
        id: 'exec-1',
        error: 'step failed: exit 1',
      }),
    ).toEqual({ version: 1, id: 'exec-1', error: 'step failed: exit 1' });
  });

  it('withholds a step error that holds a credential and keeps a clean one', async () => {
    const state = (error: string): unknown => ({
      version: 1,
      id: 'exec-1',
      jobs: { build: { status: 'failed', steps: { install: { error } } } },
    });
    const expected = (error: string): unknown => ({
      version: 1,
      id: 'exec-1',
      jobs: { build: { status: 'failed', steps: { install: { error } } } },
    });
    expect(
      await sanitized(state(`npm install: ${FAKES.npmToken.text} `)),
    ).toEqual(expected(FIELD_WITHHELD));
    expect(await sanitized(state('npm install: exit 1'))).toEqual(
      expected('npm install: exit 1'),
    );
  });
});

// CAN-7623: the process output a bundle copies (script runs, hook runs and
// pipeline executions) and the legacy discovery rows in worktrees.json are
// checked as they are written into the zip. Text logs are checked one line at
// a time, a private key block from its header to its end line, JSON files
// field by field, JSONL one record at a time, and a binary file as a whole.
const WORKSPACE = 'ws-feedback';
const WORKTREE = 'wt-feedback';
const SELECTION = [{ workspaceId: WORKSPACE, worktreeIds: [WORKTREE] }];
const FILE_WITHHELD =
  'This file was withheld from the feedback bundle because it looks like it holds a credential.\n';
// A process output file with any hit is replaced whole by one stub naming it.
const fileWithheld = (name: string): string =>
  `[${name} withheld: may hold a credential]\n`;
const jsonFileWithheld = (name: string): string =>
  `${JSON.stringify({ file: name, withheld: 'may hold a credential' })}\n`;
const KEY_BODY = ['MIIEvQ' + 'r5S6'.repeat(10), 't7U8'.repeat(12)];
const PRIVATE = 'PRIVATE';
// Every key format the shared private_key rule names, with its end line.
const KEY_BLOCKS: readonly (readonly [string, readonly string[]])[] = [
  [
    'PEM',
    [
      `-----BEGIN RSA ${PRIVATE} KEY-----`,
      ...KEY_BODY,
      `-----END RSA ${PRIVATE} KEY-----`,
    ],
  ],
  [
    'PGP',
    [
      `-----BEGIN PGP ${PRIVATE} KEY BLOCK-----`,
      '',
      ...KEY_BODY,
      `-----END PGP ${PRIVATE} KEY BLOCK-----`,
    ],
  ],
  [
    'SSH2',
    [
      `---- BEGIN SSH2 ENCRYPTED ${PRIVATE} KEY ----`,
      ...KEY_BODY,
      `---- END SSH2 ENCRYPTED ${PRIVATE} KEY ----`,
    ],
  ],
  [
    'PuTTY',
    [
      `PuTTY-User-${'Key'}-File-3: ssh-ed25519`,
      'Encryption: none',
      'Public-Lines: 2',
      ...KEY_BODY,
      'Private-MAC: 0f1e2d3c4b5a69788796a5b4c3d2e1f0',
    ],
  ],
];
const CLEAN_OUTPUT = [
  '\u001b[32m✔\u001b[39m installed 214 packages in 3.2s',
  'Downloading [=====>    ] 52%\rDownloading [==========] 100%',
  "src/app.ts(3,5): error TS1005: ';' expected.",
  '  --password <value>  the password to use',
];

function scriptRunPath(name: string): string {
  return join(getWorkspaceScriptRunDir(WORKSPACE, WORKTREE), name);
}
function hookRunPath(name: string): string {
  return join(getHookInvocationsDir(WORKSPACE, WORKTREE), 'run-1', name);
}
function executionPath(name: string): string {
  return join(getDataDir(), 'pipeline-executions', 'exec-1', name);
}

async function bundledWorkspace(
  includeChatDetails = false,
): Promise<Map<string, Buffer>> {
  return bundle((builder) =>
    feedbackLogsForTests.includeWorkspaceDiagnostics(
      builder,
      SELECTION,
      includeChatDetails,
    ),
  );
}

function bundledFile(path: string, files: Map<string, Buffer>): string {
  const file = files.get(zipPathOf(path));
  if (file === undefined)
    throw new Error(`${zipPathOf(path)} is not in the bundle`);
  return file.toString('utf8');
}

function bundledManifest(files: Map<string, Buffer>): {
  withheldContent?: unknown;
} {
  const file = files.get('feedback.json');
  if (file === undefined) throw new Error('feedback.json is not in the bundle');
  const parsed: unknown = JSON.parse(file.toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error('manifest');
  return parsed;
}

describe('the process output fakes (precondition, CAN-7623)', () => {
  it('every key header trips the shared check, and no key body or clean output line does', () => {
    for (const [, block] of KEY_BLOCKS) {
      expect(findSecretMaterialRule(block[0] ?? '')).toBe('private_key');
      for (const line of block.slice(1))
        expect(looksLikeCredential(line)).toBe(false);
    }
    for (const line of CLEAN_OUTPUT)
      expect(looksLikeCredential(line)).toBe(false);
  });
});

describe('script run output in a feedback bundle (CAN-7623)', () => {
  it('withholds the whole log when one line holds a token', async () => {
    const log = [
      ...CLEAN_OUTPUT.slice(0, 2),
      `npm notice ${FAKES.npmToken.text}`,
      ...CLEAN_OUTPUT.slice(2),
    ];
    await put(scriptRunPath('dev-1.log'), `${log.join('\n')}\n`);
    const out = bundledFile(
      scriptRunPath('dev-1.log'),
      await bundledWorkspace(),
    );
    expect(out).toBe(fileWithheld('dev-1.log'));
  });

  it('withholds a log for each credential family, on a CRLF line among clean ones', async () => {
    const fakes = Object.values(FAKES);
    for (const [index, item] of fakes.entries())
      await put(
        scriptRunPath(`dev-${index}.log`),
        `ok\r\n> ${item.text}\r\nok\r\n`,
      );
    const files = await bundledWorkspace();
    for (const index of fakes.keys())
      expect(bundledFile(scriptRunPath(`dev-${index}.log`), files)).toBe(
        fileWithheld(`dev-${index}.log`),
      );
    expect(holdsAnyBody(Buffer.concat([...files.values()]), fakes)).toBe(false);
  });

  it.each(KEY_BLOCKS)(
    'withholds a log that holds a whole %s key block',
    async (_format, block) => {
      await put(
        scriptRunPath('dev-1.log'),
        `before\n${block.join('\n')}\nafter\n`,
      );
      const out = bundledFile(
        scriptRunPath('dev-1.log'),
        await bundledWorkspace(),
      );
      expect(out).toBe(fileWithheld('dev-1.log'));
    },
  );

  it.each([
    ['PEM', KEY_BLOCKS[0]?.[1] ?? []],
    ['PuTTY', KEY_BLOCKS[3]?.[1] ?? []],
  ])(
    'withholds a log that holds a truncated %s key block',
    async (_format, block) => {
      const truncated = block.slice(0, -1);
      await put(
        scriptRunPath('dev-1.log'),
        `before\n${truncated.join('\n')}\nlater output\n`,
      );
      const out = bundledFile(
        scriptRunPath('dev-1.log'),
        await bundledWorkspace(),
      );
      expect(out).toBe(fileWithheld('dev-1.log'));
    },
  );

  // The accepted over-redaction cost of failing closed: a key header named in
  // prose withholds the log.
  it('withholds a log that names a key header in prose', async () => {
    await put(
      scriptRunPath('dev-1.log'),
      `start\nerror: expected -----BEGIN ${PRIVATE} KEY----- at the top\nnext step\n`,
    );
    const out = bundledFile(
      scriptRunPath('dev-1.log'),
      await bundledWorkspace(),
    );
    expect(out).toBe(fileWithheld('dev-1.log'));
  });

  it('catches a token that a color code splits or follows, and one in a progress line', async () => {
    const token = FAKES.githubToken.text;
    const lines = [
      `${token.slice(0, 2)}\u001b[1m${token.slice(2)}`,
      `\u001b[32mok\u001b[0m${token}`,
      `Uploading 10%\rUploading 60%\r${token}`,
    ];
    for (const line of lines.slice(0, 2))
      expect(looksLikeCredential(line)).toBe(false);
    for (const [index, line] of lines.entries())
      await put(scriptRunPath(`dev-${index}.log`), `${line}\nclean\n`);
    const files = await bundledWorkspace();
    for (const index of lines.keys())
      expect(bundledFile(scriptRunPath(`dev-${index}.log`), files)).toBe(
        fileWithheld(`dev-${index}.log`),
      );
  });

  it('withholds a log with a line longer than the 256 KiB check limit', async () => {
    await put(
      scriptRunPath('dev-1.log'),
      `${'x'.repeat(256 * 1024 + 1)}\nnext\n`,
    );
    const out = bundledFile(
      scriptRunPath('dev-1.log'),
      await bundledWorkspace(),
    );
    expect(out).toBe(fileWithheld('dev-1.log'));
  });

  it('withholds a run record whose field holds a credential', async () => {
    const meta = {
      label: 'dev',
      command: `${FAKES.envAssignment.text} npm run dev`,
      lifecycle: { exitCode: 0 },
    };
    await put(
      scriptRunPath('dev-1.json'),
      `${JSON.stringify(meta, null, 2)}\n`,
    );
    const out = bundledFile(
      scriptRunPath('dev-1.json'),
      await bundledWorkspace(),
    );
    expect(out).toBe(jsonFileWithheld('dev-1.json'));
  });

  it('treats a set-aside unreadable copy as the file it was', async () => {
    await put(
      scriptRunPath('dev-1.log.unreadable-1700000000000'),
      `${FAKES.bearer.text}\nok\n`,
    );
    await put(
      scriptRunPath('dev-1.json.unreadable-1700000000000'),
      JSON.stringify({ label: 'dev', command: FAKES.passwordAssignment.text }),
    );
    const files = await bundledWorkspace();
    expect(
      bundledFile(scriptRunPath('dev-1.log.unreadable-1700000000000'), files),
    ).toBe(fileWithheld('dev-1.log.unreadable-1700000000000'));
    expect(
      bundledFile(scriptRunPath('dev-1.json.unreadable-1700000000000'), files),
    ).toBe(jsonFileWithheld('dev-1.json.unreadable-1700000000000'));
  });

  it('copies clean output byte for byte, including color codes, CRLF and invalid UTF-8', async () => {
    const log = Buffer.concat([
      Buffer.from(`${CLEAN_OUTPUT.join('\r\n')}\r\n`, 'utf8'),
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    ]);
    const meta = Buffer.from(
      `${JSON.stringify({ label: 'dev', command: 'npm run dev' }, null, 2)}\n`,
    );
    await put(scriptRunPath('dev-1.log'), log);
    await put(scriptRunPath('dev-1.json'), meta);
    const files = await bundledWorkspace();
    expect(files.get(zipPathOf(scriptRunPath('dev-1.log')))?.equals(log)).toBe(
      true,
    );
    expect(
      files.get(zipPathOf(scriptRunPath('dev-1.json')))?.equals(meta),
    ).toBe(true);
    expect(bundledManifest(files).withheldContent).toBeUndefined();
  });
});

describe('hook run output in a feedback bundle (CAN-7623)', () => {
  it('withholds the output, the record and a snapshot that each hold a credential', async () => {
    await put(
      hookRunPath('output.log'),
      `running\n${FAKES.slackToken.text}\ndone\n`,
    );
    await put(
      hookRunPath('meta.json'),
      JSON.stringify({ hook: 'pr-created', args: FAKES.authHeader.text }),
    );
    await put(
      hookRunPath('snapshots/current.json'),
      JSON.stringify({
        number: 7,
        title: 'Fix',
        body: `Use ${FAKES.awsKey.text}`,
      }),
    );
    const files = await bundledWorkspace();
    expect(bundledFile(hookRunPath('output.log'), files)).toBe(
      fileWithheld('output.log'),
    );
    expect(bundledFile(hookRunPath('meta.json'), files)).toBe(
      jsonFileWithheld('meta.json'),
    );
    expect(bundledFile(hookRunPath('snapshots/current.json'), files)).toBe(
      jsonFileWithheld('current.json'),
    );
  });
});

describe('pipeline execution output in a feedback bundle (CAN-7623)', () => {
  const streamJsonLine = JSON.stringify({
    type: 'tool_result',
    content: JSON.stringify({ [`pass${'word'}`]: 'Q1w2E3r4T5y6' }),
  });

  async function seedExecution(): Promise<void> {
    await put(
      executionPath('logs/build--test.log'),
      `step 1\n${FAKES.apiKey.text}\n${KEY_BLOCKS[0]?.[1].join('\n')}\nstep 2\n`,
    );
    await put(
      executionPath('transcript.jsonl'),
      jsonl(
        { type: 'text', text: 'hi' },
        { type: 'text', text: FAKES.jwt.text },
      ),
    );
    await put(
      executionPath('router.log'),
      `${streamJsonLine}\n{"type":"done"}\n`,
    );
    await put(
      executionPath('report.md'),
      `# Report\n\nUsed ${FAKES.githubPat.text}\n`,
    );
    await put(
      executionPath('report.json'),
      JSON.stringify({ summary: 'ok', link: FAKES.urlPassword.text }),
    );
    await put(
      executionPath('pipeline-package/pipeline.yaml'),
      `name: deploy\nenv:\n  TOKEN: ${FAKES.githubToken.text}\n`,
    );
    await put(
      executionPath('host/blob.bin'),
      Buffer.concat([
        Buffer.from([0, 1, 2, 0]),
        Buffer.from(FAKES.npmToken.text),
        Buffer.from([0]),
      ]),
    );
  }

  function expectExecutionChecked(files: Map<string, Buffer>): void {
    const text = (name: string): string =>
      files.get(zipPathOf(executionPath(name)))?.toString('utf8') ??
      '<missing>';
    expect(text('logs/build--test.log')).toBe(fileWithheld('build--test.log'));
    expect(text('transcript.jsonl')).toBe(jsonFileWithheld('transcript.jsonl'));
    expect(streamJsonLine.includes(`"pass${'word'}"`)).toBe(false);
    expect(text('router.log')).toBe(fileWithheld('router.log'));
    expect(text('report.md')).toBe(fileWithheld('report.md'));
    expect(text('report.json')).toBe(jsonFileWithheld('report.json'));
    expect(text('pipeline-package/pipeline.yaml')).toBe(
      fileWithheld('pipeline.yaml'),
    );
    expect(text('host/blob.bin')).toBe(fileWithheld('blob.bin'));
    const all = Buffer.concat([...files.values()]);
    expect(holdsAnyBody(all, Object.values(FAKES))).toBe(false);
    expect(KEY_BODY.some((line) => all.toString('utf8').includes(line))).toBe(
      false,
    );
  }

  it('checks every file of an execution directory in the pipelines area', async () => {
    await seedExecution();
    expectExecutionChecked(
      await bundle((builder) =>
        feedbackLogsForTests.includePipelineDiagnostics(builder),
      ),
    );
  });

  it('checks every file of a selected execution in the worktrees area', async () => {
    await seedExecution();
    await put(
      join(getDataDir(), 'pipeline-executions', 'exec-1.json'),
      JSON.stringify({
        id: 'exec-1',
        pipeline_id: 'deploy',
        status: 'completed',
        started_at: '2026-11-23T00:00:00.000Z',
        project_id: WORKSPACE,
        worktree_id: WORKTREE,
      }),
    );
    expectExecutionChecked(
      await bundle((builder) =>
        feedbackLogsForTests.includeWorktreePipelineDiagnostics(
          builder,
          SELECTION,
          true,
        ),
      ),
    );
  });

  it('copies a clean execution byte for byte, binary files included', async () => {
    const log = Buffer.from('step 1\r\n\u001b[33mwarn\u001b[0m\r\n');
    const blob = Buffer.from([0, 1, 2, 3, 0xff, 0]);
    await put(executionPath('logs/build--test.log'), log);
    await put(executionPath('host/blob.bin'), blob);
    const files = await bundle((builder) =>
      feedbackLogsForTests.includePipelineDiagnostics(builder),
    );
    expect(
      files.get(zipPathOf(executionPath('logs/build--test.log')))?.equals(log),
    ).toBe(true);
    expect(
      files.get(zipPathOf(executionPath('host/blob.bin')))?.equals(blob),
    ).toBe(true);
  });
});

describe('legacy worktrees.json discovery in a feedback bundle (CAN-7623)', () => {
  const legacy = {
    version: 1,
    worktrees: [
      {
        id: WORKTREE,
        branch: 'feature/x',
        discovery: {
          mcpServers: [
            {
              name: 'github',
              error: `auth failed for ${FAKES.githubToken.text}`,
            },
            { name: 'files', error: 'connect ECONNREFUSED' },
          ],
          slashCommands: [
            { name: 'deploy', description: 'Deploy it', argumentHint: '<env>' },
          ],
        },
      },
    ],
  };
  const checked = {
    ...legacy,
    worktrees: [
      {
        ...legacy.worktrees[0],
        discovery: {
          ...legacy.worktrees[0]?.discovery,
          mcpServers: [
            { name: 'github', error: FIELD_WITHHELD },
            { name: 'files', error: 'connect ECONNREFUSED' },
          ],
        },
      },
    ],
  };

  it.each([
    ['without chat details', false],
    ['with chat details', true],
  ])(
    'withholds a credential-shaped discovery error %s',
    async (_label, includeChatDetails) => {
      await put(
        w5RecordReadPaths.worktrees(WORKSPACE),
        `${JSON.stringify(legacy, null, 2)}\n`,
      );
      const files = await bundledWorkspace(includeChatDetails);
      expect(
        JSON.parse(bundledFile(w5RecordReadPaths.worktrees(WORKSPACE), files)),
      ).toEqual(checked);
    },
  );

  it('copies a current worktrees.json with chat details byte for byte', async () => {
    const current = Buffer.from(
      `${JSON.stringify({ version: 1, worktrees: [{ id: WORKTREE, branch: 'feature/x' }] }, null, 2)}\n`,
    );
    await put(w5RecordReadPaths.worktrees(WORKSPACE), current);
    const files = await bundledWorkspace(true);
    expect(
      files
        .get(zipPathOf(w5RecordReadPaths.worktrees(WORKSPACE)))
        ?.equals(current),
    ).toBe(true);
  });
});

describe('the feedback manifest lists what was withheld (CAN-7623)', () => {
  it('names each withheld file with its mode, unit count and reasons, never its text', async () => {
    await put(scriptRunPath('dev-1.log'), `${FAKES.npmToken.text}\nok\n`);
    await put(
      scriptRunPath('key.log'),
      `ok\n${KEY_BLOCKS[1]?.[1].join('\n')}\n`,
    );
    await put(scriptRunPath('long.log'), `${'x'.repeat(256 * 1024 + 1)}\n`);
    await put(
      scriptRunPath('dev-1.json'),
      JSON.stringify({ command: FAKES.envAssignment.text }),
    );
    await put(scriptRunPath('clean.log'), 'ok\n');
    const files = await bundledWorkspace();
    const manifest = bundledManifest(files);
    const entry = (name: string, reason: string): unknown => ({
      path: zipPathOf(scriptRunPath(name)),
      mode: 'whole-file',
      units: 1,
      reasons: [reason],
    });
    expect(manifest.withheldContent).toEqual([
      entry('dev-1.json', 'credential'),
      entry('dev-1.log', 'credential'),
      entry('key.log', 'private-key-block'),
      entry('long.log', 'too-long'),
    ]);
    expect(
      holdsAnyBody(
        files.get('feedback.json') ?? Buffer.alloc(0),
        Object.values(FAKES),
      ),
    ).toBe(false);
  });

  it('shortens a withheld list past the manifest bound and counts what it left out', async () => {
    // About 4,000 entries fill the 1 MiB manifest; 6,000 overflow it.
    const total = 6000;
    const builder = new FeedbackBundleBuilder(true, true);
    for (let index = 0; index < total; index += 1)
      builder.recordWithheld(
        `script-runs/wt/${'r'.repeat(200)}-${String(index).padStart(4, '0')}.log`,
        {
          mode: 'whole-file',
          units: 1,
          reasons: [index % 3 === 0 ? 'too-long' : 'credential'],
        },
      );
    builder.addManifest(MANIFEST);
    const zipPath = join(root, 'bundle.zip');
    await builder.writeTo(await open(zipPath, 'w'), true);
    const file = (await readZip(zipPath)).get('feedback.json');
    if (file === undefined)
      throw new Error('feedback.json is not in the bundle');
    expect(file.length).toBeLessThanOrEqual(MAX_FEEDBACK_MANIFEST_BYTES);
    const manifest: unknown = JSON.parse(file.toString('utf8'));
    if (typeof manifest !== 'object' || manifest === null)
      throw new Error('manifest');
    const listed: unknown = Reflect.get(manifest, 'withheldContent');
    const summary: unknown = Reflect.get(manifest, 'inventorySummary');
    const kept = Array.isArray(listed) ? listed.length : 0;
    expect(kept).toBeGreaterThan(0);
    expect(summary).toMatchObject({
      includedFilesOmitted: 0,
      skippedFilesOmitted: 0,
      withheldContentOmitted: total - kept,
      withheldContentReasons: { credential: 4000, 'too-long': 2000 },
    });
  });
});

// Green on develop since CAN-7625 named these headers private_key: CAN-7620's
// entry and record modes withhold the whole entry or record with the key.
describe('PGP, SSH2 and PuTTY keys in main.log and the diagnostics JSONL (CAN-7623)', () => {
  it.each(KEY_BLOCKS.slice(1))(
    'withholds a %s key in a main.log entry and in a session-events record',
    async (_format, block) => {
      const log = await bundledMainLog(
        `${entry('00:00:01.000', 'info', 'ok')}${entry('00:00:02.000', 'info', block.join('\n'))}`,
      );
      expect(KEY_BODY.some((line) => log.toString('utf8').includes(line))).toBe(
        false,
      );
      await put(
        getAgentObservabilitySessionEventsDayFilePath(DAY),
        jsonl({
          timestamp: '2026-11-23T00:00:00.000Z',
          kind: 'note',
          text: block.join('\n'),
        }),
      );
      const files = await bundledDiagnostics();
      const records = files.get(
        zipPathOf(getAgentObservabilitySessionEventsDayFilePath(DAY)),
      );
      expect(
        KEY_BODY.some((line) => records?.toString('utf8').includes(line)),
      ).toBe(false);
    },
  );
});

// CAN-7623: every check reads a text in each of its
// readings (as written, and with terminal escapes removed or read as spaces,
// raw or written out as text), and parses each reading that is JSON.
async function scrubbed(
  mode: FeedbackScrubMode,
  path: string,
  bytes: Buffer,
  chunkBytes = 64 * 1024,
): Promise<string> {
  const parts: Buffer[] = [];
  for (let start = 0; start < bytes.length; start += chunkBytes)
    parts.push(bytes.subarray(start, start + chunkBytes));
  const out: Buffer[] = [];
  const stream = Readable.from(parts).pipe(createFeedbackScrub(mode, { path }));
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError('expected bytes');
    out.push(chunk);
  }
  return Buffer.concat(out).toString('utf8');
}

describe('a credential that a terminal escape hides, in every check (CAN-7623)', () => {
  const ESC = '\u001b';
  const token = FAKES.githubToken.text;
  // A color code glued before the token, raw and written out as text.
  const rawColored = `ok${ESC}[0m${token}`;
  const encodedColored = `ok\\u001b[0m${token}`;

  it('no single reading of either form trips the check as written', () => {
    expect(looksLikeCredential(rawColored)).toBe(false);
    expect(looksLikeCredential(encodedColored)).toBe(false);
  });

  const record = (text: string): string =>
    `${JSON.stringify({ timestamp: '2026-11-23T00:00:00.000Z', kind: 'note', text })}\n`;
  const CASES: readonly (readonly [
    string,
    FeedbackScrubMode,
    string,
    (text: string) => string,
  ])[] = [
    [
      'main.log entries',
      'log-entries',
      'system-logs/main.log',
      (text) => `[2026-11-23 00:00:00.000] [info]  ${text}\n`,
    ],
    ['JSONL records', 'jsonl-records', 'diagnostics/events.jsonl', record],
    [
      'a JSON document',
      'json-document',
      'diagnostics/snapshot.json',
      (text) => JSON.stringify({ note: text }),
    ],
    [
      'a process output text line',
      'process-output',
      'script-runs/wt/run.log',
      (text) => `${text}\n`,
    ],
    [
      'a process output JSON line',
      'process-output',
      'script-runs/wt/run.log',
      (text) => `${JSON.stringify({ msg: text })}\n`,
    ],
    [
      'a process output JSON file',
      'process-output',
      'script-runs/wt/run.json',
      (text) => JSON.stringify({ command: text }),
    ],
    [
      'a process output JSONL record',
      'process-output',
      'pipeline-executions/e/transcript.jsonl',
      record,
    ],
    [
      'a process output binary file',
      'process-output',
      'pipeline-executions/e/host/blob.bin',
      (text) => `\u0000${text}\u0000`,
    ],
    [
      'worktrees.json discovery',
      'worktrees-discovery',
      'workspaces/w/worktrees.json',
      (text) =>
        JSON.stringify({
          version: 1,
          worktrees: [
            {
              id: 'wt',
              discovery: { mcpServers: [{ name: 'x', error: text }] },
            },
          ],
        }),
    ],
  ];
  it.each(
    CASES.flatMap(([label, mode, path, wrap]) => [
      [label, 'a raw color code', mode, path, wrap(rawColored)] as const,
      [
        label,
        'a color code written as text',
        mode,
        path,
        wrap(encodedColored),
      ] as const,
      [
        label,
        'a raw color code around the whole line',
        mode,
        path,
        `${ESC}[32m${wrap(rawColored)}${ESC}[0m`,
      ] as const,
    ]),
  )(
    '%s: withholds a token behind %s',
    async (_label, _form, mode, path, text) => {
      const out = await scrubbed(mode, path, Buffer.from(text, 'utf8'));
      expect(out.includes(FAKES.githubToken.body)).toBe(false);
    },
  );

  it('withholds a copied field behind either form', () => {
    expect(withheldIfCredential(rawColored)).toBe(FIELD_WITHHELD);
    expect(withheldIfCredential(encodedColored)).toBe(FIELD_WITHHELD);
  });

  it('withholds a JSON line that color codes wrap, with its credential escaped inside a string', async () => {
    const line = `${ESC}[32m${JSON.stringify({
      type: 'tool_result',
      content: JSON.stringify({ [`pass${'word'}`]: 'Q1w2E3r4T5y6' }),
    })}${ESC}[0m`;
    expect(looksLikeCredential(line)).toBe(false);
    await put(executionPath('router.log'), `${line}\nok\n`);
    const files = await bundle((builder) =>
      feedbackLogsForTests.includePipelineDiagnostics(builder),
    );
    expect(
      files.get(zipPathOf(executionPath('router.log')))?.toString('utf8'),
    ).toBe(fileWithheld('router.log'));
  });
});

describe('a private key with terminal escapes or past the 256 KiB line limit (CAN-7623)', () => {
  const ESC = '\u001b';
  const block = KEY_BLOCKS[0]?.[1] ?? [];
  const header = block[0] ?? '';
  const end = block[block.length - 1] ?? '';

  it('withholds a log whose key header a color code splits', async () => {
    const colored = `${header.slice(0, 11)}${ESC}[31m${header.slice(11)}${ESC}[0m`;
    expect(findSecretMaterialRule(colored)).toBeNull();
    const out = await scrubbed(
      'process-output',
      'script-runs/wt/run.log',
      Buffer.from(`${[colored, ...block.slice(1)].join('\n')}\nafter\n`),
    );
    expect(out).toBe(fileWithheld('run.log'));
  });

  it('withholds a log whose key ends with a colored end line', async () => {
    const coloredEnd = `${ESC}[31m${end}${ESC}[0m`;
    const out = await scrubbed(
      'process-output',
      'script-runs/wt/run.log',
      Buffer.from(
        `${[...block.slice(0, -1), coloredEnd].join('\n')}\nafter\nlast\n`,
      ),
    );
    expect(out).toBe(fileWithheld('run.log'));
  });

  it.each([
    ['after the limit', 256 * 1024 + 10],
    ['across the limit', 256 * 1024 - 10],
  ])('withholds a log whose key header starts %s', async (_label, padding) => {
    await put(
      scriptRunPath('dev-1.log'),
      `${'x'.repeat(padding)}${block.join('\n')}\nafter\n`,
    );
    const out = bundledFile(
      scriptRunPath('dev-1.log'),
      await bundledWorkspace(),
    );
    expect(out).toBe(fileWithheld('dev-1.log'));
  });

  it('withholds a log with the header at every offset across the 256 KiB cut, in small writes', async () => {
    for (let offset = 0; offset <= header.length; offset += 1) {
      const log = `${'x'.repeat(256 * 1024 - offset)}${block.join('\n')}\nafter\n`;
      for (const chunkBytes of [7, 4096]) {
        const out = await scrubbed(
          'process-output',
          'script-runs/wt/run.log',
          Buffer.from(log),
          chunkBytes,
        );
        expect([offset, chunkBytes, out]).toEqual([
          offset,
          chunkBytes,
          fileWithheld('run.log'),
        ]);
      }
    }
  });

  it('withholds a log whose overlong line holds a whole key', async () => {
    await put(
      scriptRunPath('dev-1.log'),
      `${'x'.repeat(256 * 1024 + 10)}${block.join(' ')}\nnext\nlast\n`,
    );
    const out = bundledFile(
      scriptRunPath('dev-1.log'),
      await bundledWorkspace(),
    );
    expect(out).toBe(fileWithheld('dev-1.log'));
  });
});

const DOCUMENT_WITHHELD = `${JSON.stringify({ withheld: 'looks like it holds a credential' })}\n`;

describe('a private key split across JSON values or JSONL records (CAN-7623)', () => {
  const block = KEY_BLOCKS[0]?.[1] ?? [];
  const record = (text: string): string =>
    `${JSON.stringify({ timestamp: '2026-11-23T00:00:00.000Z', kind: 'note', text })}\n`;
  // Inside a key block a record's marker copies no field: base64 key text
  // trips no check, so it could sit in the timestamp or kind.
  const recordWithheld = DOCUMENT_WITHHELD;
  const keyLines = `${block.map(record).join('')}`;

  it('withholds a process output JSON file whose array holds a key one line per value', async () => {
    const out = await scrubbed(
      'process-output',
      'pipeline-executions/e/report.json',
      Buffer.from(JSON.stringify({ output: block })),
    );
    expect(out).toBe(jsonFileWithheld('report.json'));
  });

  it('withholds a JSON document whose array holds a key one line per value', async () => {
    const out = await scrubbed(
      'json-document',
      'diagnostics/snapshot.json',
      Buffer.from(JSON.stringify({ output: block })),
    );
    expect(out).toBe(DOCUMENT_WITHHELD);
  });

  it('withholds a process output JSONL file with a key written one line per record', async () => {
    const out = await scrubbed(
      'process-output',
      'pipeline-executions/e/transcript.jsonl',
      Buffer.from(`${record('before')}${keyLines}${record('after')}`),
    );
    expect(out).toBe(jsonFileWithheld('transcript.jsonl'));
  });

  // Fail closed: no end record closes a key in the diagnostics JSONL, so
  // every record from the header on is withheld, the clean ones after it too.
  it('withholds a key written one line per record, and every record after it, in the diagnostics JSONL', async () => {
    const out = await scrubbed(
      'jsonl-records',
      'diagnostics/events.jsonl',
      Buffer.from(`${record('before')}${keyLines}${record('after')}`),
    );
    expect(out).toBe(
      `${record('before')}${recordWithheld.repeat(block.length + 1)}`,
    );
  });

  // F2: key text in the fields a marker would otherwise copy.
  it.each([
    [
      'kind',
      (line: string): object => ({
        timestamp: '2026-11-23T00:00:00.000Z',
        kind: line,
      }),
    ],
    [
      'timestamp',
      (line: string): object => ({ timestamp: line, kind: 'note' }),
    ],
  ] as const)(
    'copies no %s from a record inside a key block in the diagnostics JSONL',
    async (_label, shape) => {
      const log = `${record(block[0] ?? '')}${block
        .slice(1)
        .map((line) => `${JSON.stringify(shape(line))}\n`)
        .join('')}`;
      for (const chunkBytes of [7, 64 * 1024]) {
        const out = await scrubbed(
          'jsonl-records',
          'diagnostics/events.jsonl',
          Buffer.from(log),
          chunkBytes,
        );
        expect(out).toBe(recordWithheld.repeat(block.length));
      }
    },
  );

  it('withholds every record after a key header with no end record, in small writes', async () => {
    const log = `${block.slice(0, -1).map(record).join('')}${record('later')}`;
    for (const chunkBytes of [7, 64 * 1024]) {
      const out = await scrubbed(
        'jsonl-records',
        'diagnostics/events.jsonl',
        Buffer.from(log),
        chunkBytes,
      );
      expect(out).toBe(recordWithheld.repeat(block.length));
    }
  });

  it('opens the block at a header in a record past the 256 KiB limit', async () => {
    for (const padding of [256 * 1024 + 10, 256 * 1024 - 10]) {
      const long = `${JSON.stringify({ text: `${'x'.repeat(padding)}${block[0] ?? ''}` })}\n`;
      const out = await scrubbed(
        'jsonl-records',
        'diagnostics/events.jsonl',
        Buffer.from(
          `${record('before')}${long}${block.slice(1).map(record).join('')}`,
        ),
        4096,
      );
      expect(KEY_BODY.some((line) => out.includes(line))).toBe(false);
      expect(out.startsWith(record('before'))).toBe(true);
      expect(out.split('\n')).toHaveLength(block.length + 2);
    }
  });

  it('withholds a key header found only in a JSON string in a record', async () => {
    const out = await scrubbed(
      'jsonl-records',
      'diagnostics/events.jsonl',
      Buffer.from(
        `${record(JSON.stringify({ lines: [block[0]] }))}${block.slice(1).map(record).join('')}`,
      ),
    );
    expect(out).toBe(recordWithheld.repeat(block.length));
  });
});

describe('a credential in JSON serialized as a string (CAN-7623)', () => {
  const password = `pass${'word'}`;
  const twice = JSON.stringify(JSON.stringify({ [password]: 'Z9x8C7v6B5n4' }));
  const thrice = JSON.stringify(twice);
  it.each([
    [
      'a diagnostics JSONL record',
      'jsonl-records',
      'diagnostics/events.jsonl',
      `${twice}\n`,
    ],
    ['a JSON document', 'json-document', 'diagnostics/snapshot.json', twice],
    [
      'a process output text line',
      'process-output',
      'script-runs/wt/run.log',
      `${twice}\n`,
    ],
    [
      'a process output JSON file',
      'process-output',
      'script-runs/wt/run.json',
      JSON.stringify({ note: JSON.stringify({ [password]: 'Z9x8C7v6B5n4' }) }),
    ],
    [
      'three levels deep',
      'jsonl-records',
      'diagnostics/events.jsonl',
      `${thrice}\n`,
    ],
  ] as const)(
    'withholds a password serialized as a string, in %s',
    async (_label, mode, path, text) => {
      const out = await scrubbed(mode, path, Buffer.from(text));
      expect(out.includes('Z9x8C7v6B5n4')).toBe(false);
    },
  );
});

describe('a JSON file whose credential a field walk cannot place (CAN-7623)', () => {
  const password = `pass${'word'}`;
  it.each([
    [
      'an earlier value of a duplicate key',
      `{"command":"${FAKES.githubToken.text}","command":"npm run dev"}`,
    ],
    [
      'a password held in an array',
      JSON.stringify({ [password]: ['Z9x8C7v6B5n4'] }),
    ],
    [
      'a secret held in an object',
      JSON.stringify({ secret: { value: 'Z9x8C7v6B5n4' } }),
    ],
    [
      'a credential the walk misses beside one it replaces',
      JSON.stringify({ a: FAKES.npmToken.text, [password]: ['Z9x8C7v6B5n4'] }),
    ],
  ])('withholds the whole file for %s', async (_label, text) => {
    const out = await scrubbed(
      'process-output',
      'script-runs/wt/run.json',
      Buffer.from(text),
    );
    expect(out).toBe(jsonFileWithheld('run.json'));
  });

  it('withholds a worktrees.json discovery whose credential the walk cannot place', async () => {
    const text = JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'wt',
          branch: 'main',
          discovery: {
            mcpServers: [{ name: 'x', env: { [password]: ['Z9x8C7v6B5n4'] } }],
          },
        },
      ],
    });
    const out = await scrubbed(
      'worktrees-discovery',
      'workspaces/w/worktrees.json',
      Buffer.from(text),
    );
    expect(JSON.parse(out)).toEqual({
      version: 1,
      worktrees: [{ id: 'wt', branch: 'main', discovery: FIELD_WITHHELD }],
    });
  });
});

describe('every mode writes through the output gate (CAN-7623)', () => {
  type Factory = typeof feedbackScrubForTests.createScrubber;
  // The real scrubber for the mode, then one more unit through the same emit.
  // The wrapper doesn't claim to check its own units, so the gate checks each.
  const withExtraUnit =
    (unit: string): Factory =>
    (mode, path, emit, tally) => {
      const real = feedbackScrubForTests.createScrubber(
        mode,
        path,
        emit,
        tally,
      );
      return {
        get reportedMode() {
          return real.reportedMode;
        },
        ...(real.stub === undefined ? {} : { stub: real.stub.bind(real) }),
        write: (chunk) => real.write(chunk),
        end: () => {
          real.end();
          emit(Buffer.from(unit));
        },
      };
    };
  async function gated(
    mode: FeedbackScrubMode,
    path: string,
    bytes: Buffer,
    unit: string,
  ): Promise<string> {
    const out: Buffer[] = [];
    const stream = Readable.from([bytes]).pipe(
      feedbackScrubForTests.createGatedScrub(
        mode,
        { path },
        withExtraUnit(unit),
      ),
    );
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError('expected bytes');
      out.push(chunk);
    }
    return Buffer.concat(out).toString('utf8');
  }
  const record = `${JSON.stringify({ kind: 'note', text: 'ok' })}\n`;
  const ROWS: readonly (readonly [
    string,
    FeedbackScrubMode,
    string,
    Buffer,
    string,
  ])[] = [
    [
      'main.log entries',
      'log-entries',
      'logs/main.log',
      Buffer.from('[2026-11-23 00:00:00.000] [info]  ok\n'),
      FILE_WITHHELD,
    ],
    [
      'diagnostics JSONL',
      'jsonl-records',
      'diagnostics/events.jsonl',
      Buffer.from(record),
      DOCUMENT_WITHHELD,
    ],
    [
      'the snapshot document',
      'json-document',
      'diagnostics/snapshot.json',
      Buffer.from('{"ok":true}'),
      DOCUMENT_WITHHELD,
    ],
    [
      'worktrees.json',
      'worktrees-discovery',
      'workspaces/w/worktrees.json',
      Buffer.from('{"version":1,"worktrees":[]}'),
      DOCUMENT_WITHHELD,
    ],
    [
      'process output text',
      'process-output',
      'script-runs/wt/run.log',
      Buffer.from('ok\n'),
      fileWithheld('run.log'),
    ],
    [
      'process output JSON',
      'process-output',
      'script-runs/wt/run.json',
      Buffer.from('{"ok":true}'),
      jsonFileWithheld('run.json'),
    ],
    [
      'process output JSONL',
      'process-output',
      'script-runs/wt/run.jsonl',
      Buffer.from(record),
      jsonFileWithheld('run.jsonl'),
    ],
    [
      'process output binary',
      'process-output',
      'host/blob.bin',
      Buffer.from([0x00, 0x6f, 0x6b]),
      fileWithheld('blob.bin'),
    ],
  ];

  it.each(ROWS)(
    'withholds the whole file when any unit trips the gate, in %s',
    async (_label, mode, path, bytes, stub) => {
      const token = await gated(
        mode,
        path,
        bytes,
        `${FAKES.githubToken.text}\n`,
      );
      expect(token).toBe(stub);
      const header = await gated(
        mode,
        path,
        bytes,
        `${KEY_BLOCKS[0]?.[1][0] ?? ''}\n`,
      );
      expect(header).toBe(stub);
    },
  );

  // No unit holds the header on its own; the whole output does.
  it.each(ROWS)(
    'withholds the whole file when a key header spans two units, in %s',
    async (_label, mode, path, bytes, stub) => {
      const header = KEY_BLOCKS[0]?.[1][0] ?? '';
      const split: Factory = (factoryMode, factoryPath, emit, tally) => {
        const real = feedbackScrubForTests.createScrubber(
          factoryMode,
          factoryPath,
          emit,
          tally,
        );
        return {
          get reportedMode() {
            return real.reportedMode;
          },
          ...(real.stub === undefined ? {} : { stub: real.stub.bind(real) }),
          write: (chunk) => real.write(chunk),
          end: () => {
            real.end();
            emit(Buffer.from(header.slice(0, 18)));
            emit(Buffer.from(`${header.slice(18)}\n`));
          },
        };
      };
      const out: Buffer[] = [];
      const stream = Readable.from([bytes]).pipe(
        feedbackScrubForTests.createGatedScrub(mode, { path }, split),
      );
      for await (const chunk of stream) {
        if (!Buffer.isBuffer(chunk)) throw new TypeError('expected bytes');
        out.push(chunk);
      }
      expect(Buffer.concat(out).toString('utf8')).toBe(stub);
    },
  );

  // Process output checks every unit itself before it emits any, so the gate
  // checks each only for a scrubber that doesn't, and still scans the whole
  // output for a key header.
  it('leaves process output units to its scrubber and still scans for a key header', async () => {
    const run = async (unit: string): Promise<string> => {
      const factory: Factory = (factoryMode, factoryPath, emit, tally) => {
        const real = feedbackScrubForTests.createScrubber(
          factoryMode,
          factoryPath,
          emit,
          tally,
        );
        expect(real.checksEachUnit).toBe(true);
        return {
          reportedMode: real.reportedMode,
          checksEachUnit: true,
          ...(real.stub === undefined ? {} : { stub: real.stub.bind(real) }),
          write: (chunk) => real.write(chunk),
          end: () => {
            real.end();
            emit(Buffer.from(unit));
          },
        };
      };
      const out: Buffer[] = [];
      const stream = Readable.from([Buffer.from('ok\n')]).pipe(
        feedbackScrubForTests.createGatedScrub(
          'process-output',
          { path: 'script-runs/wt/run.log' },
          factory,
        ),
      );
      for await (const chunk of stream) {
        if (!Buffer.isBuffer(chunk)) throw new TypeError('expected bytes');
        out.push(chunk);
      }
      return Buffer.concat(out).toString('utf8');
    };
    expect(await run(`${KEY_BLOCKS[0]?.[1][0] ?? ''}\n`)).toBe(
      fileWithheld('run.log'),
    );
    expect(await run('clean\n')).toBe('ok\nclean\n');
  });

  it.each(ROWS)(
    'copies every unit when none trips the gate, in %s',
    async (_label, mode, path, bytes) => {
      const out = await gated(mode, path, bytes, 'clean\n');
      expect(out).toBe(`${bytes.toString('utf8')}clean\n`);
    },
  );
});

// A known limit, pinned so a change to it is seen: line mode checks one line
// at a time, so a value on the line after its key is copied, as on develop,
// where process output wasn't checked at all. CAN-7621 owns this class. A
// main.log entry spans both lines, so CAN-7620's entry check catches it.
describe('a value on the line after its key (CAN-7621)', () => {
  const password = `pass${'word'}`;
  const value = 'Z9x8C7v6B5n4';
  // Each shape, and whether a line of it trips on its own in process output.
  const SHAPES = [
    [
      'a YAML key with its value indented below',
      `config:\n  ${password}:\n    ${value}\nnext\n`,
      false,
    ],
    [
      'a prompt with the value on the next line',
      `Enter the ${password}:\n${value}\nnext\n`,
      false,
    ],
    [
      'a YAML block scalar, whose key line trips on its own',
      `${password}: |\n  ${value}\nnext\n`,
      true,
    ],
  ] as const;

  it.each(SHAPES)(
    'is not caught in process output text unless a line trips alone, for %s',
    async (_label, text, lineTrips) => {
      for (const path of [
        'script-runs/wt/run.log',
        'pipeline-executions/e/pipeline.yaml',
      ]) {
        const out = await scrubbed('process-output', path, Buffer.from(text));
        const name = path.split('/').pop() ?? '';
        expect(out).toBe(lineTrips ? fileWithheld(name) : text);
      }
    },
  );

  it.each(SHAPES)(
    'is caught in a main.log entry, for %s',
    async (_label, text) => {
      const head = '[2026-11-23 00:00:00.000] [info]  ';
      const out = await scrubbed(
        'log-entries',
        'logs/main.log',
        Buffer.from(`${head}${text}`),
      );
      expect(out.includes(value)).toBe(false);
    },
  );
});

// A credential or key header that only a decoded reading shows: JSON escapes
// decoded wherever they sit, after a prefix, inside a string, or as a whole
// line that parses. A header seen only decoded has no trusted end line.
describe('a credential that only decoded JSON escapes show (CAN-7623)', () => {
  const block = KEY_BLOCKS[0]?.[1] ?? [];
  const escapedDashes = `${String.fromCharCode(92)}u002d`.repeat(5);
  const escapedHeader = `{"text":"${escapedDashes}BEGIN RSA ${PRIVATE} KEY${escapedDashes}"}`;
  const password = `pass${'word'}`;
  const twice = JSON.stringify(JSON.stringify({ [password]: 'Z9x8C7v6B5n4' }));
  const head = '[2026-11-23 00:00:00.000] [info]  ';
  const bodyLines = block
    .slice(1)
    .map((line) => JSON.stringify({ text: line }));

  it('the escaped header and the twice-serialized value trip nothing as written', () => {
    expect(looksLikeCredential(escapedHeader)).toBe(false);
    expect(looksLikeCredential(`result: ${twice}`)).toBe(false);
  });

  // N1: a whole JSON line, and the same JSON after a prefix.
  it.each([
    ['a JSON line', escapedHeader],
    ['JSON after a prefix', `stdout: ${escapedHeader}`],
  ])(
    'withholds a log whose key header only %s shows decoded',
    async (_label, header) => {
      const lines = [header, ...bodyLines, 'after'];
      const out = await scrubbed(
        'process-output',
        'script-runs/wt/run.log',
        Buffer.from(`${lines.join('\n')}\n`),
      );
      expect(out).toBe(fileWithheld('run.log'));
    },
  );

  // N2 and N3 in main.log: the entry line, with its prefix, or a continuation.
  it.each([
    [
      'an escaped key header on the entry line, the body below',
      `${escapedHeader}\n${block.slice(1).join('\n')}`,
    ],
    [
      'an escaped key header on a continuation line',
      `key:\n${escapedHeader}\n${block.slice(1).join('\n')}`,
    ],
    ['a twice-serialized password on the entry line', `result ${twice}`],
    ['a twice-serialized password on a continuation line', `result:\n${twice}`],
  ])('withholds a main.log entry with %s', async (_label, entry) => {
    const out = await scrubbed(
      'log-entries',
      'logs/main.log',
      Buffer.from(`${head}${entry}\n${head}next\n`),
    );
    expect(out).toBe(`${head}${ENTRY_WITHHELD}\n${head}next\n`);
  });

  // N3 in a JSONL record: JSON after a prefix inside a string value.
  it('withholds a diagnostics record whose string holds a twice-serialized password after a prefix', async () => {
    const out = await scrubbed(
      'jsonl-records',
      'diagnostics/events.jsonl',
      Buffer.from(
        `${JSON.stringify({ kind: 'note', text: `stdout: ${twice}` })}\n`,
      ),
    );
    expect(out).toBe(
      `${JSON.stringify({ withheld: 'looks like it holds a credential', kind: 'note' })}\n`,
    );
  });

  // Every mode, with both shapes: the structural rows for the one readings source.
  const MODES: readonly (readonly [
    string,
    FeedbackScrubMode,
    string,
    (lines: readonly string[]) => string,
  ])[] = [
    [
      'main.log entries',
      'log-entries',
      'logs/main.log',
      (lines) => `${head}${lines.join('\n')}\n`,
    ],
    [
      'diagnostics JSONL',
      'jsonl-records',
      'diagnostics/events.jsonl',
      (lines) =>
        lines.map((line) => `${JSON.stringify({ text: line })}\n`).join(''),
    ],
    [
      'the snapshot document',
      'json-document',
      'diagnostics/snapshot.json',
      (lines) => JSON.stringify({ lines }),
    ],
    [
      'worktrees.json',
      'worktrees-discovery',
      'workspaces/w/worktrees.json',
      (lines) =>
        JSON.stringify({
          version: 1,
          worktrees: [{ id: 'wt', discovery: { lines } }],
        }),
    ],
    [
      'process output text',
      'process-output',
      'script-runs/wt/run.log',
      (lines) => `${lines.join('\n')}\n`,
    ],
    [
      'process output JSON',
      'process-output',
      'script-runs/wt/run.json',
      (lines) => JSON.stringify({ lines }),
    ],
    [
      'process output JSONL',
      'process-output',
      'script-runs/wt/run.jsonl',
      (lines) =>
        lines.map((line) => `${JSON.stringify({ text: line })}\n`).join(''),
    ],
    [
      'process output binary',
      'process-output',
      'host/blob.bin',
      (lines) => `\u0000${lines.join('\n')}\n`,
    ],
  ];

  it.each(MODES)(
    'withholds an escaped key header and its body, in %s',
    async (_label, mode, path, write) => {
      const out = await scrubbed(
        mode,
        path,
        Buffer.from(write([`stdout: ${escapedHeader}`, ...block.slice(1)])),
      );
      expect(KEY_BODY.some((line) => out.includes(line))).toBe(false);
    },
  );

  it.each(MODES)(
    'withholds a twice-serialized password after a prefix, in %s',
    async (_label, mode, path, write) => {
      const out = await scrubbed(
        mode,
        path,
        Buffer.from(write(['ok', `stdout: ${twice}`])),
      );
      expect(out.includes('Z9x8C7v6B5n4')).toBe(false);
    },
  );
});

// Two keys written back to back, the first with no trailing line break, as
// `cat a.pem b.pem` prints them: one line holds an end line and the next
// header. Whole-file withholding leaves no key follow for this to slip past.
describe('two private keys joined on one line (CAN-7623)', () => {
  const [header = '', ...rest] = KEY_BLOCKS[0]?.[1] ?? [];
  const end = rest[rest.length - 1] ?? '';
  const body = rest.slice(0, -1);
  const second = ['MIIEvQ' + 'z9Y8'.repeat(10), 'x7W6'.repeat(12)];
  const joined = [header, ...body, `${end}${header}`, ...second, end, 'after'];

  it('withholds the log, in small and large writes', async () => {
    for (const chunkBytes of [7, 64 * 1024]) {
      const out = await scrubbed(
        'process-output',
        'script-runs/wt/run.log',
        Buffer.from(`${joined.join('\n')}\n`),
        chunkBytes,
      );
      expect(out).toBe(fileWithheld('run.log'));
    }
  });

  it('withholds the main.log entry that holds them', async () => {
    const head = '[2026-11-23 00:00:00.000] [info]  ';
    const out = await scrubbed(
      'log-entries',
      'logs/main.log',
      Buffer.from(`${head}${joined.join('\n')}\n${head}next\n`),
    );
    expect(out).toBe(`${head}${ENTRY_WITHHELD}\n${head}next\n`);
  });
});

describe('clean process output passes byte for byte (CAN-7623)', () => {
  const CLEAN: Record<string, readonly string[]> = {
    npm: [
      '\u001b[32m✔\u001b[0m added 412 packages in 8.1s',
      'npm warn deprecated inflight@1.0.6: This module is not supported',
      'Progress: resolved 120, reused 118, downloaded 0, added 2\rProgress: resolved 120, done',
    ],
    tsc: [
      "src/app.ts(3,5): error TS1005: ';' expected.",
      "src/auth/session.ts:12:4 - error TS2339: Property 'token' does not exist on type 'Session'.",
      'Found 2 errors in 1 file.',
    ],
    git: [
      'remote: Enumerating objects: 42, done.\rremote: Counting objects: 100% (42/42), done.',
      "Switched to a new branch 'feature/token-refresh'",
      'commit 0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c',
    ],
    docker: [
      '#5 [2/4] RUN pnpm install --frozen-lockfile',
      '#5 DONE 41.2s',
      ' => [internal] load metadata for docker.io/library/node:24',
    ],
  };

  it.each(Object.entries(CLEAN))(
    'copies a clean %s log as written',
    async (name, lines) => {
      const log = Buffer.from(`${lines.join('\n')}\n`);
      const out = await scrubbed(
        'process-output',
        `script-runs/wt/${name}.log`,
        log,
      );
      expect(out).toBe(log.toString('utf8'));
    },
  );
});

// The stated cost of whole-file withholding (measured in the PR's Known
// limits): one line with a credential-named field and no value withholds the
// whole log. CAN-7624 owns these value shapes; placeholders such as
// `token: <your token>` are kept since CAN-7630 (see below).
describe('a log with one credential-named field and no value is withheld whole (CAN-7623)', () => {
  it.each([
    ['jest', '    Received: {"token": undefined}'],
    ['curl', '> Authorization: [redacted]'],
    ['hook', `pass${'word'}: ********`],
  ])('withholds a %s log for one such line', async (name, line) => {
    const out = await scrubbed(
      'process-output',
      `script-runs/wt/${name}.log`,
      Buffer.from(`step started\n${line}\nstep done\n`),
    );
    expect(out).toBe(fileWithheld(`${name}.log`));
  });
});

// A JSON or JSONL process output file above 2 MiB (2,097,152 bytes) is
// withheld whole without being parsed: reading every value of a larger one
// would hold the main process for seconds. Fail closed; at or below the cap
// the file is checked as before.
describe('a JSON or JSONL process output file above the 2 MiB cap (CAN-7623)', () => {
  const CAP = 2 * 1024 * 1024;
  // A clean file of exactly `bytes` bytes, padded inside its last value.
  function cleanJsonl(bytes: number): Buffer {
    const record = (pad: string): string =>
      `${JSON.stringify({ type: 'text', text: `ok${pad}` })}\n`;
    const line = record('');
    const count = Math.floor(bytes / line.length) - 1;
    const rest = bytes - count * line.length - record('').length;
    return Buffer.from(`${line.repeat(count)}${record('x'.repeat(rest))}`);
  }
  function cleanJson(bytes: number): Buffer {
    const head = '{"steps":[\n';
    const item = '{"name":"build","status":"ok"},\n';
    const tail = (pad: string): string => `{"note":"${pad}"}\n]}\n`;
    const count = Math.floor(
      (bytes - head.length - tail('').length) / item.length,
    );
    const rest = bytes - head.length - count * item.length - tail('').length;
    return Buffer.from(`${head}${item.repeat(count)}${tail('x'.repeat(rest))}`);
  }

  it.each([
    ['JSONL', 'transcript.jsonl', cleanJsonl],
    ['JSON', 'report.json', cleanJson],
  ] as const)(
    'copies a clean %s file of 2 MiB minus one byte as written',
    async (_label, name, make) => {
      const bytes = make(CAP - 1);
      expect(bytes.length).toBe(CAP - 1);
      const out = await scrubbed(
        'process-output',
        `pipeline-executions/e/${name}`,
        bytes,
      );
      expect(out).toBe(bytes.toString('utf8'));
    },
  );

  it.each([
    ['JSONL', 'transcript.jsonl', cleanJsonl],
    ['JSON', 'report.json', cleanJson],
  ] as const)(
    'withholds a clean %s file of 2 MiB plus one byte as too large to check',
    async (_label, name, make) => {
      const bytes = make(CAP + 1);
      expect(bytes.length).toBe(CAP + 1);
      const out = await scrubbed(
        'process-output',
        `pipeline-executions/e/${name}`,
        bytes,
      );
      expect(out).toBe(
        `${JSON.stringify({ file: name, withheld: 'too large to check for credentials' })}\n`,
      );
    },
  );

  it('still checks a JSONL file of 2 MiB minus one byte that holds a secret', async () => {
    const secret = `${JSON.stringify({ type: 'text', text: FAKES.githubToken.text })}\n`;
    const bytes = Buffer.concat([
      cleanJsonl(CAP - 1 - secret.length),
      Buffer.from(secret),
    ]);
    expect(bytes.length).toBe(CAP - 1);
    const out = await scrubbed(
      'process-output',
      'pipeline-executions/e/transcript.jsonl',
      bytes,
    );
    expect(out).toBe(jsonFileWithheld('transcript.jsonl'));
  });

  it('keeps checking a text log above the cap line by line', async () => {
    const log = Buffer.from(`${'ok\n'.repeat(Math.ceil((CAP + 1) / 3))}`);
    const out = await scrubbed('process-output', 'script-runs/wt/big.log', log);
    expect(out).toBe(log.toString('utf8'));
    const dirty = Buffer.concat([log, Buffer.from(`${FAKES.npmToken.text}\n`)]);
    const withheld = await scrubbed(
      'process-output',
      'script-runs/wt/big.log',
      dirty,
    );
    expect(withheld).toBe(fileWithheld('big.log'));
  });
});

// Everything a scrub holds to the end of a file is held in buffers of about
// 64 KiB, not one per line, record or entry, so a newline-heavy file costs
// about its own size in every mode. The gate writes what it holds as it holds
// it, so the chunks written are the parts held; they are counted as the
// stream writes them, since reading with for-await joins what is buffered.
describe('a file is held in bounded chunks in every mode (CAN-7623)', () => {
  async function writtenChunks(
    mode: FeedbackScrubMode,
    path: string,
    bytes: Buffer,
  ): Promise<Buffer[]> {
    const chunks: Buffer[] = [];
    const parts: Buffer[] = [];
    for (let start = 0; start < bytes.length; start += 7)
      parts.push(bytes.subarray(start, start + 7));
    await new Promise<void>((resolve, reject) => {
      Readable.from(parts)
        .pipe(createFeedbackScrub(mode, { path }))
        .on('data', (chunk: Buffer) => chunks.push(chunk))
        .on('end', resolve)
        .on('error', reject);
    });
    return chunks;
  }
  const KiB = 1024;
  const head = '[2026-11-23 00:00:00.000] [info]  ';
  const ROWS: readonly (readonly [
    string,
    FeedbackScrubMode,
    string,
    Buffer,
  ])[] = [
    [
      'main.log, one short entry per line',
      'log-entries',
      'logs/main.log',
      Buffer.from(`${head}ok\n`.repeat(4 * KiB)),
    ],
    [
      'the diagnostics JSONL, tiny records',
      'jsonl-records',
      'diagnostics/events.jsonl',
      Buffer.from('{}\n'.repeat(64 * KiB)),
    ],
    [
      'the snapshot document',
      'json-document',
      'diagnostics/snapshot.json',
      Buffer.from(
        JSON.stringify(
          { steps: Array.from({ length: 8 * KiB }, (_, i) => i) },
          null,
          1,
        ),
      ),
    ],
    [
      'worktrees.json',
      'worktrees-discovery',
      'workspaces/w/worktrees.json',
      Buffer.from(
        JSON.stringify(
          {
            version: 1,
            worktrees: Array.from({ length: 2 * KiB }, (_, i) => ({
              id: `wt${i}`,
            })),
          },
          null,
          1,
        ),
      ),
    ],
    [
      'process output text, newlines only',
      'process-output',
      'script-runs/wt/blank.log',
      Buffer.from('\n'.repeat(192 * KiB)),
    ],
    [
      'process output text, 2-byte lines',
      'process-output',
      'script-runs/wt/short.log',
      Buffer.from('a\n'.repeat(96 * KiB)),
    ],
    [
      'process output JSONL, tiny records',
      'process-output',
      'script-runs/wt/run.jsonl',
      Buffer.from('{}\n'.repeat(64 * KiB)),
    ],
    [
      'process output JSON, short lines',
      'process-output',
      'script-runs/wt/run.json',
      Buffer.from(
        JSON.stringify(
          Array.from({ length: 32 * KiB }, (_, i) => i),
          null,
          1,
        ),
      ),
    ],
    [
      'process output binary',
      'process-output',
      'host/blob.bin',
      Buffer.concat([Buffer.from([0]), Buffer.from('ab'.repeat(96 * KiB))]),
    ],
  ];

  it.each(ROWS)(
    'copies %s byte for byte, held in at most one part per 64 KiB',
    async (_label, mode, path, bytes) => {
      const chunks = await writtenChunks(mode, path, bytes);
      expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
      expect(chunks.length).toBeLessThanOrEqual(
        Math.ceil(bytes.length / (64 * KiB)) + 1,
      );
    },
  );
});

// A terminal OSC escape can run across a line break, and its escape reading
// then joins the two lines. A line that leaves an OSC or DCS escape open
// withholds a process output file, and the gate scans every unit whole, so a
// key header broken that way is caught wherever it sits in a held part.
describe('a key header broken by a terminal escape across a line break (CAN-7623)', () => {
  const ESC = '\u001b';
  const BEL = '\u0007';
  const block = KEY_BLOCKS[0]?.[1] ?? [];
  const brokenHeader = `-----BEGIN ${ESC}]0;title\n${BEL}RSA ${PRIVATE} KEY-----`;
  const keyAfter = (prefix: string): string =>
    `${prefix}${brokenHeader}\n${block.slice(1).join('\n')}\nafter\n`;
  const cleanLines = (bytes: number): string => {
    const line = 'step ok\n';
    return line.repeat(Math.floor(bytes / line.length));
  };

  it('trips no line of the broken header on its own', () => {
    for (const line of brokenHeader.split('\n'))
      expect(looksLikeCredential(line)).toBe(false);
  });

  it.each([7, 4096, 64 * 1024])(
    'withholds a log with the broken header after 300 clean lines, in %i-byte writes',
    async (chunkBytes) => {
      const out = await scrubbed(
        'process-output',
        'script-runs/wt/run.log',
        Buffer.from(keyAfter(cleanLines(300 * 8))),
        chunkBytes,
      );
      expect(out).toBe(fileWithheld('run.log'));
    },
  );

  it.each([
    ['deep inside a 64 KiB held part', 40 * 1024],
    ['across two held parts', 64 * 1024 - 12],
  ])('withholds a log with the broken header %s', async (_label, offset) => {
    const prefix = `${cleanLines(offset)}${'x'.repeat(offset % 8)}\n`;
    const out = await scrubbed(
      'process-output',
      'script-runs/wt/run.log',
      Buffer.from(keyAfter(prefix)),
    );
    expect(out).toBe(fileWithheld('run.log'));
  });

  it.each([
    ['an OSC', `${ESC}]0;still open`],
    ['a DCS', `${ESC}Pq still open`],
  ])(
    'withholds a log with a line that leaves %s escape open',
    async (_label, line) => {
      const out = await scrubbed(
        'process-output',
        'script-runs/wt/run.log',
        Buffer.from(`ok\n${line}\nok\n`),
      );
      expect(out).toBe(fileWithheld('run.log'));
    },
  );

  it('withholds the main.log entry that holds the broken header', async () => {
    const head = '[2026-11-23 00:00:00.000] [info]  ';
    const out = await scrubbed(
      'log-entries',
      'logs/main.log',
      Buffer.from(
        `${head}${brokenHeader}\n${block.slice(1).join('\n')}\n${head}next\n`,
      ),
    );
    expect(out).toBe(`${head}${ENTRY_WITHHELD}\n${head}next\n`);
  });

  it('copies a log whose terminal escapes each end on their own line', async () => {
    const log = `${cleanLines(300 * 8)}${ESC}]0;title${BEL}build ok\n${ESC}]8;;https://example.test${ESC}\\link${ESC}]8;;${ESC}\\\n`;
    const out = await scrubbed(
      'process-output',
      'script-runs/wt/run.log',
      Buffer.from(log),
    );
    expect(out).toBe(log);
  });

  // The gate reads every unit whole, not just where it meets the last, even
  // from a mode that checked its own units.
  it('withholds a unit with a key header deep inside it, from a mode that checks its own units', async () => {
    const header = KEY_BLOCKS[0]?.[1][0] ?? '';
    const unit = `${'step ok\n'.repeat(9 * 1024)}${header}\n`;
    const factory: Parameters<
      typeof feedbackScrubForTests.createGatedScrub
    >[2] = (mode, path, emit, tally) => {
      const real = feedbackScrubForTests.createScrubber(
        mode,
        path,
        emit,
        tally,
      );
      return {
        reportedMode: real.reportedMode,
        checksEachUnit: true,
        ...(real.stub === undefined ? {} : { stub: real.stub.bind(real) }),
        write: (chunk) => real.write(chunk),
        end: () => {
          real.end();
          emit(Buffer.from(unit));
        },
      };
    };
    const out: Buffer[] = [];
    const stream = Readable.from([Buffer.from('ok\n')]).pipe(
      feedbackScrubForTests.createGatedScrub(
        'process-output',
        { path: 'script-runs/wt/run.log' },
        factory,
      ),
    );
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError('expected bytes');
      out.push(chunk);
    }
    expect(Buffer.concat(out).toString('utf8')).toBe(fileWithheld('run.log'));
  });
});

// A key header nested past the depth limit counts as holding a credential, so
// it opens a key block too, and the diagnostics JSONL withholds to the end.
describe('a key header nested past the depth limit (CAN-7623)', () => {
  const block = KEY_BLOCKS[0]?.[1] ?? [];
  const escapedDashes = `${String.fromCharCode(92)}u002d`.repeat(5);
  let deep = `{"text":"${escapedDashes}BEGIN RSA ${PRIVATE} KEY${escapedDashes}"}`;
  for (let level = 0; level < 6; level += 1) deep = JSON.stringify(deep);
  const records = block
    .slice(1)
    .map((line) => `${JSON.stringify({ kind: 'note', text: line })}\n`)
    .join('');

  it.each([7, 64 * 1024])(
    'withholds every diagnostics record after it, in %i-byte writes',
    async (chunkBytes) => {
      const out = await scrubbed(
        'jsonl-records',
        'diagnostics/events.jsonl',
        Buffer.from(`${deep}\n${records}`),
        chunkBytes,
      );
      expect(KEY_BODY.some((line) => out.includes(line))).toBe(false);
      expect(out).toBe(DOCUMENT_WITHHELD.repeat(block.length));
    },
  );

  it('withholds a process output JSONL file that holds it', async () => {
    const out = await scrubbed(
      'process-output',
      'pipeline-executions/e/transcript.jsonl',
      Buffer.from(`${deep}\n${records}`),
    );
    expect(out).toBe(jsonFileWithheld('transcript.jsonl'));
  });
});

// Every terminal string (OSC, DCS, SOS, PM and APC) runs to BEL or ST, as ESC
// and a character, as its 8-bit control, or as the raw byte of that control,
// which reads as U+FFFD. A key header such a string splits is caught, ended
// on its line or on the next; a string left open is withheld; and terminal
// strings that end are copied byte for byte.
describe('a key header split by any terminal string (CAN-7623)', () => {
  const ESC = '\u001b';
  const BEL = '\u0007';
  const control = (code: number): string => String.fromCharCode(code);
  const ST8 = control(0x9c);
  const block = KEY_BLOCKS[0]?.[1] ?? [];
  const clean = Array.from({ length: 300 }, (_, i) => `step ${i} ok`).join(
    '\n',
  );
  const head = '[2026-11-23 00:00:00.000] [info]  ';
  // [kind, opener, terminator, encoding]
  const strings: [string, string, string, BufferEncoding][] = [
    ['DCS', `${ESC}P`, `${ESC}\\`, 'utf8'],
    ['SOS', `${ESC}X`, `${ESC}\\`, 'utf8'],
    ['PM', `${ESC}^`, `${ESC}\\`, 'utf8'],
    ['APC', `${ESC}_`, BEL, 'utf8'],
    ['8-bit OSC', control(0x9d), BEL, 'utf8'],
    ['8-bit DCS', control(0x90), ST8, 'utf8'],
    ['8-bit SOS', control(0x98), ST8, 'utf8'],
    ['8-bit PM', control(0x9e), ST8, 'utf8'],
    ['8-bit APC', control(0x9f), ST8, 'utf8'],
    ['raw 8-bit OSC', control(0x9d), ST8, 'latin1'],
    ['raw 8-bit DCS', control(0x90), ST8, 'latin1'],
    ['raw 8-bit APC', control(0x9f), BEL, 'latin1'],
  ];
  const splits = strings.flatMap(
    ([kind, open, end, encoding]) =>
      [
        [
          `${kind}, ended on its line`,
          `-----BEGIN ${open}payload${end}RSA ${PRIVATE} KEY-----`,
          encoding,
        ],
        [
          `${kind}, ended on the next line`,
          `-----BEGIN ${open}payload\n${end}RSA ${PRIVATE} KEY-----`,
          encoding,
        ],
      ] as const,
  );
  // A raw byte is not told apart from a broken one, so only the 7-bit and
  // 8-bit forms can be known to be left open.
  const open = strings
    .filter(([, , , encoding]) => encoding === 'utf8')
    .flatMap(
      ([kind, opener]) =>
        [
          [
            `${kind}, left open`,
            `-----BEGIN ${opener}payloadRSA ${PRIVATE} KEY-----`,
          ],
          [
            `${kind}, cut off by a color code`,
            `-----BEGIN ${opener}payloadRSA ${PRIVATE} KEY-----${ESC}[0m`,
          ],
        ] as const,
    );

  it('trips no line of any split header on its own', () => {
    for (const [, header] of [...splits, ...open])
      for (const line of header.split('\n'))
        expect(looksLikeCredential(line)).toBe(false);
  });

  it.each([
    ...splits,
    ...open.map(([label, header]) => [label, header, 'utf8'] as const),
  ])(
    'withholds a log whose key header a %s splits',
    async (_label, header, encoding) => {
      for (const chunkBytes of [7, 64 * 1024]) {
        const out = await scrubbed(
          'process-output',
          'script-runs/wt/run.log',
          Buffer.from(
            `${clean}\n${header}\n${block.slice(1).join('\n')}\nafter\n`,
            encoding,
          ),
          chunkBytes,
        );
        expect(out).toBe(fileWithheld('run.log'));
      }
    },
  );

  it.each([
    ...splits,
    ...open.map(([label, header]) => [label, header, 'utf8'] as const),
  ])(
    'withholds the main.log entry whose key header a %s splits',
    async (_label, header, encoding) => {
      for (const chunkBytes of [7, 64 * 1024]) {
        const out = await scrubbed(
          'log-entries',
          'logs/main.log',
          Buffer.from(
            `${head}${header}\n${block.slice(1).join('\n')}\n${head}next\n`,
            encoding,
          ),
          chunkBytes,
        );
        expect(out).toBe(`${head}${ENTRY_WITHHELD}\n${head}next\n`);
      }
    },
  );

  it.each([
    [
      '7-bit strings that end',
      `${ESC}Pq#0${ESC}\\ ok\n${ESC}Xs${ESC}\\ ok\n${ESC}^m${ESC}\\ ok\n${ESC}_a${BEL} ok\n`,
      'utf8',
    ],
    [
      '8-bit strings and a CSI that end',
      `${control(0x9d)}0;title${ST8} ok\n${control(0x90)}q${ST8} ok\n${control(0x9b)}31mred\n`,
      'utf8',
    ],
    [
      'raw 8-bit strings and a CSI that end',
      `${control(0x9d)}0;title${ST8} ok\n${control(0x9b)}31mred\n`,
      'latin1',
    ],
    [
      'a replacement character in plain text',
      'bad byte \uFFFD here\nand \uFFFD\uFFFD there\n',
      'utf8',
    ],
  ] as const)(
    'copies a log of %s byte for byte',
    async (_label, text, encoding) => {
      const bytes = Buffer.from(`${clean}\n${text}`, encoding);
      const out = await scrubbed(
        'process-output',
        'script-runs/wt/run.log',
        bytes,
      );
      expect(out).toBe(bytes.toString('utf8'));
    },
  );
});

// A Windows main.log copy is given the account's names, and each name in a
// path segment is replaced with <user>. The output gate checks every entry
// as written first, so a replaced name never changes a verdict; no other mode
// is redacted.
describe('account names replaced in a Windows main.log copy (CAN-7623)', () => {
  const head = '[2026-11-26 09:00:00.000] [info]  ';
  const token = FAKES.githubToken.text;

  async function withNames(
    mode: FeedbackScrubMode,
    path: string,
    text: string,
    names: readonly string[] | undefined,
    chunkBytes = 64 * 1024,
  ): Promise<{ out: string; summary: unknown }> {
    const bytes = Buffer.from(text);
    const parts: Buffer[] = [];
    for (let start = 0; start < bytes.length; start += chunkBytes)
      parts.push(bytes.subarray(start, start + chunkBytes));
    let summary: unknown;
    const out: Buffer[] = [];
    const stream = Readable.from(parts).pipe(
      createFeedbackScrub(mode, {
        path,
        report: (next): void => {
          summary = next;
        },
        ...(names === undefined ? {} : { redactPathUserNames: names }),
      }),
    );
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError('expected bytes');
      out.push(chunk);
    }
    return { out: Buffer.concat(out).toString('utf8'), summary };
  }

  it.each([7, 64 * 1024])(
    'replaces a name in drive, UNC, escaped and short-form paths, in %i-byte writes',
    async (chunkBytes) => {
      const entry = `${head}opened C:\\Users\\Alexander Smith\\app, \\\\host\\Users\\Alexander Smith\\x, C:\\\\Users\\\\Alexander Smith\\\\y and C:\\Users\\ALEXAN~1\\z.\n`;
      const named = await withNames(
        'log-entries',
        'logs/main.log',
        entry,
        ['Alexander Smith'],
        chunkBytes,
      );
      expect(named.out).toBe(
        `${head}opened C:\\Users\\<user>\\app, \\\\host\\Users\\<user>\\x, C:\\\\Users\\\\<user>\\\\y and C:\\Users\\<user>\\z.\n`,
      );
      const unnamed = await withNames(
        'log-entries',
        'logs/main.log',
        entry,
        undefined,
        chunkBytes,
      );
      expect(unnamed.out).toBe(entry);
    },
  );

  it("replaces the name in a withheld entry's scope and keeps its verdict", async () => {
    const entry = `${head}[worktree /Users/alexander/proj] token=${token}\n`;
    const named = await withNames('log-entries', 'logs/main.log', entry, [
      'alexander',
    ]);
    const unnamed = await withNames(
      'log-entries',
      'logs/main.log',
      entry,
      undefined,
    );
    expect(named.out).toBe(
      `${head}[worktree /Users/<user>/proj] ${ENTRY_WITHHELD}\n`,
    );
    expect(named.summary).toEqual(unnamed.summary);
  });

  it('withholds an entry whose path segment is a credential, even when it is a given name', async () => {
    const named = await withNames(
      'log-entries',
      'logs/main.log',
      `${head}open C:\\Users\\${token}\\app\n`,
      [token],
    );
    expect(named.out).toBe(`${head}${ENTRY_WITHHELD}\n`);
    expect(named.out.includes(token)).toBe(false);
  });

  it.each([
    [
      'process output',
      'process-output',
      'script-runs/wt/run.log',
      'opened C:\\Users\\alexander\\app\n',
    ],
    [
      'the diagnostics JSONL',
      'jsonl-records',
      'diagnostics/events.jsonl',
      `${JSON.stringify({ kind: 'note', text: 'C:\\Users\\alexander\\app' })}\n`,
    ],
    [
      'a JSON document',
      'json-document',
      'snapshot.json',
      `${JSON.stringify({ path: 'C:\\Users\\alexander\\app' })}\n`,
    ],
  ] as const)(
    'copies %s byte for byte, given names',
    async (_label, mode, path, text) => {
      const named = await withNames(mode, path, text, ['alexander']);
      expect(named.out).toBe(text);
    },
  );

  it('withholds a key block entry as it does without names', async () => {
    const block = KEY_BLOCKS[0]?.[1] ?? [];
    const text = `${head}C:\\Users\\alexander\\id ${block.join('\n')}\n${head}next C:\\Users\\alexander\\b\n`;
    const named = await withNames('log-entries', 'logs/main.log', text, [
      'alexander',
    ]);
    const unnamed = await withNames(
      'log-entries',
      'logs/main.log',
      text,
      undefined,
    );
    expect(named.out).toBe(
      `${head}${ENTRY_WITHHELD}\n${head}next C:\\Users\\<user>\\b\n`,
    );
    expect(KEY_BODY.some((line) => named.out.includes(line))).toBe(false);
    expect(named.summary).toEqual(unnamed.summary);
  });

  it.each([
    [
      'a secret next to the name is still withheld',
      `${head}C:\\Users\\alexander\\.env token=${token}\n`,
      `${head}${ENTRY_WITHHELD}\n`,
    ],
    [
      'a clean line with the name is still kept',
      `${head}C:\\Users\\alexander\\.env loaded\n`,
      `${head}C:\\Users\\<user>\\.env loaded\n`,
    ],
  ] as const)(
    'gives one unit the same verdict with names: %s',
    async (_label, text, expected) => {
      for (const chunkBytes of [7, 64 * 1024]) {
        const named = await withNames(
          'log-entries',
          'logs/main.log',
          text,
          ['alexander'],
          chunkBytes,
        );
        const unnamed = await withNames(
          'log-entries',
          'logs/main.log',
          text,
          undefined,
          chunkBytes,
        );
        expect(named.out).toBe(expected);
        expect(named.summary).toEqual(unnamed.summary);
      }
    },
  );

  it.each([7, 64 * 1024])(
    'replaces account SIDs in every main.log copy, with or without names, in %i-byte writes',
    async (chunkBytes) => {
      const sid = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
      const entra = 'S-1-12-1-111-222-333-444';
      const entry = `${head}data folder grants ${sid} and ${entra}; S-1-5-11 stays\n`;
      const expected = `${head}data folder grants <account-sid> and <account-sid>; S-1-5-11 stays\n`;
      for (const names of [['alexander'], undefined]) {
        const result = await withNames(
          'log-entries',
          'logs/main.log',
          entry,
          names,
          chunkBytes,
        );
        expect(result.out).toBe(expected);
      }
      const processOutput = `grants ${sid}\n`;
      const copied = await withNames(
        'process-output',
        'script-runs/wt/run.log',
        processOutput,
        ['alexander'],
        chunkBytes,
      );
      expect(copied.out).toBe(processOutput);
    },
  );

  it('withholds a main.log entry with a SID next to a secret, as it does without SIDs', async () => {
    const sid = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
    const named = await withNames(
      'log-entries',
      'logs/main.log',
      `${head}${sid} token=${token}\n`,
      ['alexander'],
    );
    const plain = await withNames(
      'log-entries',
      'logs/main.log',
      `${head}token=${token}\n`,
      ['alexander'],
    );
    expect(named.out).toBe(`${head}${ENTRY_WITHHELD}\n`);
    expect(named.summary).toEqual(plain.summary);
  });
});

// A process output line whose only credential-looking part is a placeholder
// assignment is copied. Any value left beside, inside or glued onto the
// placeholder still withholds the whole file.
describe('a placeholder assignment in process output (CAN-7630)', () => {
  const ESC = '\u001b';
  const DOLLAR = '$';
  const value = 'Q9w8'.repeat(3);
  const word = `hunter${'two'}`;
  const npmShort = `np${'m'}_${'a'.repeat(31)}`;
  const npmTail = `${npmShort}token`;
  const awsTail = `AKI${'A'}${'Q'.repeat(11)}TOKEN`;
  const ghTail = `gh${'p'}_${'a1B2'.repeat(9)}`;
  const path = 'pipeline-executions/exec-1/steps/deploy.log';
  const log = (line: string): string => `step started\n${line}\nstep done\n`;

  it.each([7, 64 * 1024])(
    'copies a pipeline log with each ticket form as written, in %i-byte writes',
    async (chunkBytes) => {
      const text = [
        'step started',
        'token: <your token>',
        `  TOKEN: ${DOLLAR}{{ secrets.DEPLOY_TOKEN }}`,
        'api_key: $API_KEY',
        'step done',
        '',
      ].join('\n');
      const out = await scrubbed(
        'process-output',
        path,
        Buffer.from(text),
        chunkBytes,
      );
      expect(out).toBe(text);
    },
  );

  it.each([
    ['colored', `token: ${ESC}[1m<your token>${ESC}[0m`],
    ['quoted', `TOKEN: "${DOLLAR}{{ secrets.DEPLOY_TOKEN }}"`],
    ['JSON pair', `{"token":"${DOLLAR}{{ secrets.DEPLOY_TOKEN }}"}`],
    ['$DEPLOY_PAT', 'token: $DEPLOY_PAT'],
    ['NPM_TOKEN=$NPM_TOKEN', 'NPM_TOKEN=$NPM_TOKEN'],
    // Review round 3: closing punctuation that ends at the line end, a quote
    // or whitespace.
    ['JSON pair and another field', '{"token":"<your token>","b":1}'],
    ['shell statement', 'export TOKEN=$TOKEN; next'],
    // Review round 4: a color code or a flag dash before the key.
    ['colored key', `${ESC}[32mtoken: <your token>`],
    [
      'two color codes before the key',
      `${ESC}[1m${ESC}[32mtoken: <your token>`,
    ],
    ['color code after a space', `step ${ESC}[32mtoken: <your token>`],
    ['flag', '--token=$TOKEN'],
  ])('copies a log with a %s placeholder as written', async (_name, line) => {
    const text = log(line);
    expect(await scrubbed('process-output', path, Buffer.from(text))).toBe(
      text,
    );
  });

  it.each([
    ['a GitHub token', `token: <your token> ${FAKES.githubToken.text}`],
    [
      'password=value',
      `TOKEN: ${DOLLAR}{{ secrets.X }} pass${'word'}=${value}`,
    ],
    ['<pw>value', `pass${'word'}=<pw>${value}`],
    ['a braced name glued to a value', `token=${DOLLAR}{TOKEN}${value}`],
    ['a real value in brackets', `token: <${FAKES.githubToken.text}>`],
    ['$API_KEY and an sk- key', `api_key: $API_KEY ${FAKES.apiKey.text}`],
    ['a bare name glued to a value', `token: $API_KEY${value}`],
    ['a bare name, escape, then value', `token: $API_KEY${ESC}[0m${value}`],
    ['a bare name holding an AWS key', `token: $TOKEN${FAKES.awsKey.text}`],
    ['$API_KEYABCDEFGH', 'token: $API_KEYABCDEFGH'],
    ['pwd = value', `token: <t> pwd = ${value}`],
    ["password='value'", `token: $X pass${'word'}='${value}'`],
    ['two glued fakes', `token: <t> ${FAKES.npmToken.text}${FAKES.jwt.text}`],
    [
      'line-start token = value',
      `token=${DOLLAR}{{ secrets.X }} token = ${value} {`,
    ],
    [
      'a JSON placeholder and a real field',
      `{"token":"${DOLLAR}{{ secrets.X }}","pass${'word'}":"${value}"}`,
    ],
    // Review round 1: a literal inside the quotes or the brackets, without
    // the digits a value-like run needs.
    [
      'a literal after it inside the quotes',
      `{"pass${'word'}":"<your pass${'word'}> ${word}"}`,
    ],
    [
      'a literal after a quoted reference',
      `TOKEN: "${DOLLAR}{{ secrets.X }} ${word}"`,
    ],
    ['a literal before it inside the quotes', `token: "${word} <t>"`],
    ['a || fallback', `token: ${DOLLAR}{{ secrets.TOKEN || '${word}' }}`],
    ['a default() filter', `token: {{ inputs.token | default('${word}') }}`],
    ['a command substitution', `token: ${DOLLAR}(printf ${word})`],
    ['gh auth token', `TOKEN=${DOLLAR}(gh auth token) gh pr create`],
    ['an assignment inside <>', `token: <pw=${word}>`],
    ['a key with a value inside <>', `token: <pass${'word'}: ${word}>`],
    [
      'a bare name that takes the next key',
      `token: process.env.TOKENNPM_TOKEN = "${word} <t>"`,
    ],
    // Review round 3: a literal glued on after closing punctuation or a
    // closing quote, or in URL user-info.
    ['a URL password and ;', `https://token:$API_KEY;${word}@host`],
    ['a URL <> password', `https://token:<your token>;${word}@host`],
    [
      'a URL ${{ }} password',
      `https://token:${DOLLAR}{{ secrets.T }};${word}@host`,
    ],
    ['a URL password and ,', `https://token:$API_KEY,${word}@host`],
    ['a URL password and )', `https://token:$API_KEY)${word}@host`],
    ['a literal glued after ;', `pass${'word'}=$API_KEY;${word}`],
    ['a literal glued after ,', `token: <your token>,${word}`],
    ['a literal glued after )', `token: ${DOLLAR}{{ secrets.T }})${word}`],
    ['a literal after a double quote', `pass${'word'}: "$API_KEY";${word}`],
    ['a literal after a single quote', `pass${'word'}: '<x>',${word}`],
    ['a literal glued after a dot', `token: $API_KEY.${word}`],
    ['a quoted literal after ,', `pass${'word'}=$API_KEY,"${word}"`],
    ['a quoted literal after ;', `api_key: $API_KEY;'${word}'`],
    ['a quoted literal after )', `token: <your token>)"${word}"`],
    [
      'a ${{ }} then a quoted literal',
      `TOKEN: ${DOLLAR}{{ secrets.T }},"${word}"`,
    ],
    ['an unquoted JSON placeholder', '{"token":$TOKEN,"b":1}'],
    ['a quoted literal after a quoted one', `{"token":"<x>","${word}"}`],
    ['a literal glued after ]', `token: <your token>]${word}`],
    ['a literal glued after }', `token: $API_KEY}${word}`],
    ['a literal glued after @', `token: $API_KEY@${word}`],
    // Review round 4: text glued on before the key, such as a token whose
    // last characters spell the key word.
    ['an npm token ending in token', `${npmTail}: <your token>`],
    ['an npm token ending in token, then $NAME', `${npmTail}: $API_KEY`],
    [
      'an npm token ending in token, then ${{ }}',
      `${npmTail}: ${DOLLAR}{{ secrets.X }}`,
    ],
    ['an AWS key ending in TOKEN', `${awsTail}: <your token>`],
    ['an AWS key ending in TOKEN, then $NAME', `${awsTail}: $API_KEY`],
    [
      'an AWS key ending in TOKEN, then ${{ }}',
      `${awsTail}: ${DOLLAR}{{ secrets.X }}`,
    ],
    ['a short npm run and _', `${npmShort}_token: <x>`],
    ['a short npm run and -', `${npmShort}-token: <x>`],
    ['a short npm run and ,', `${npmShort},token: <x>`],
    ['a short npm run and (', `${npmShort}(token: <x>`],
    ['an AWS-like run and _', `AKI${'A'}${'Q'.repeat(16)}_TOKEN: <x>`],
    ['a GitHub token and .', `${ghTail}.token: <x>`],
    ['an unknown key prefix', `ASI${'A'}${'Q'.repeat(11)}TOKEN: <x>`],
    ['a word glued before the key', `${word}token: <x>`],
    ['a word and _ before the key', `hunter_token: <x>`],
    ['a camelCase key', `github${'Token'}: ${DOLLAR}{{ secrets.X }}`],
    ['a name prefix', `DEPLOY_TOKEN: ${DOLLAR}{{ secrets.DEPLOY_TOKEN }}`],
    ['nested JSON', `{"a":{"token":"${DOLLAR}{{ secrets.X }}"}},`],
    ['a call argument', 'f(token=$TOKEN)'],
    ['digits before the key', '1126token: <x>'],
    ['digits and _ before the key', '2025_token: <x>'],
    ['digits before the key, then $NAME', '1126TOKEN: $API_KEY'],
    ['a word, a color code, the key', `${word}${ESC}[0mtoken: <x>`],
    ['an npm run, a color code, the key', `${npmShort}${ESC}[0mtoken: <x>`],
    ['a word and _, a color code, the key', `hunter_${ESC}[32mtoken: <x>`],
    ['digits, a color code, the key', `1126${ESC}[0mtoken: <x>`],
    ['a word, a color code, the key and =', `${word}${ESC}[0mtoken=<x>`],
    [
      'digits, a color code, the key and =',
      `1126${ESC}[0mpass${'word'}=$API_KEY`,
    ],
    ['an npm run and a digit before the key', `${npmShort}9token: <x>`],
    [
      'an npm run, a color code, the key, then $NAME',
      `${npmShort}${ESC}[32mtoken: $API_KEY`,
    ],
    [
      'a word, two color codes, the key, then ${{ }}',
      `${word}${ESC}[1m${ESC}[0mtoken: ${DOLLAR}{{ secrets.X }}`,
    ],
  ])(
    'withholds the whole log for a placeholder with %s',
    async (_name, line) => {
      expect(
        await scrubbed('process-output', path, Buffer.from(log(line))),
      ).toBe(fileWithheld('deploy.log'));
    },
  );

  // A long line after a placeholder, or a long word before a bare name.
  it.each([
    ['letters after a placeholder', `token: <x> ${'a'.repeat(250_000)}`],
    ['a long word before a bare name', `${'a'.repeat(250_000)} token=$TOKEN`],
  ])(
    'copies a 250,000-character line with %s as written',
    async (_name, line) => {
      const text = log(line);
      const out = await scrubbed('process-output', path, Buffer.from(text));
      expect(out).toBe(text);
    },
  );
});
