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

import { FeedbackBundleBuilder } from '../feedback-archive';
import { feedbackLogsForTests } from '../feedback-bundle';
import {
  getAgentObservabilityAppEventsDayFilePath,
  getAgentObservabilityAuditDayFilePath,
  getAgentObservabilitySessionEventsDayFilePath,
  getAgentObservabilitySnapshotPath,
  getDataDir,
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
