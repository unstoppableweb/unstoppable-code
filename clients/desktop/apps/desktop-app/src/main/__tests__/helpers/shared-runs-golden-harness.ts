// Shared harness for the CAN-4169 shared-runs goldens: fixture ids, the
// in-test cloud transport, the waits and snapshot helpers, and data-root
// ownership with its outside-write guard. Test files keep their own
// jest.mock calls and read the shared state below from them.
// shortcut: the comments goldens' PR carries an identical copy of this file;
// dedupe when the first PR lands.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '@canopy/brand/current';
import type { SharedRunMetadata } from '@canopy/desktop-shared/types';

export const WORKSPACE_ID = 'shared-runs-golden';
export const WORKTREE_ID = 'golden-wt';
// Hosted team and organization ids are UUIDs; the runs API refuses others.
export const TEAM_ID = '00000000-0000-4000-8000-00000000a001';
export const ORG_ID = '00000000-0000-4000-8000-00000000b001';
export const LAPSED_TEAM_ID = '00000000-0000-4000-8000-00000000a002';
export const LAPSED_ORG_ID = '00000000-0000-4000-8000-00000000b002';
/** The nth run id the fake server mints; hosted run ids are UUIDs. */
export const runId = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const API_KEY = 'csk_shared_runs_golden_fake';
export const FIXED_TIME = '2026-11-01T12:00:00.000Z';
const API = `/api/v1/${BRAND.web.apiNamespace}`;
const WELL_KNOWN = `/.well-known/${BRAND.web.wellKnownNamespace}`;
const realSetTimeout = setTimeout;

export type Json = Record<string, unknown>;
type Handler = (event: unknown, ...args: unknown[]) => unknown;

/** IPC handlers by channel, as the mocked registerIpcHandler records them. */
export const handlers = new Map<string, Handler>();
/** The chat's saved share metadata, by `project/worktree/chat`. */
export const savedShares = new Map<string, SharedRunMetadata>();
/** Session diagnostics the jobs record. */
export const diagnostics: Json[] = [];
/** The observability members both goldens' code paths call. */
export const observability = {
  getRetentionDays: (): number => 30,
  recordSessionDiagnostic: (diagnostic: Json): void => {
    diagnostics.push(diagnostic);
  },
};

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('expected a value');
  return value;
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
  body?: unknown;
}
interface Fault {
  method: string;
  path: string;
  status: number;
  body: Json;
}
interface FakeCloud {
  requests: RecordedRequest[];
  faults: Fault[];
  capabilities: string[];
  /** The `<api>/runs…` routes each golden serves. */
  route: (method: string, path: string, body: Json) => Response;
}

export const cloud: FakeCloud = {
  requests: [],
  faults: [],
  capabilities: ['runs-crud-v1', 'run-comments-v1'],
  route: () => json(404, { error: 'Not found.' }),
};

/** Answer the next `method path` request with `status` and an error body. */
export function fault(
  method: string,
  path: string,
  status: number,
  error: string,
): void {
  cloud.faults.push({ method, path, status, body: { error } });
}

export function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Records every request, answers planned faults, then the golden's routes. */
export function fakeCloud(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(requestUrl(input));
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const parsed: unknown =
    typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  const path = url.pathname.replace(API, '<api>');
  cloud.requests.push({
    method,
    path,
    authorization: headers.get('authorization'),
    ...(parsed === undefined ? {} : { body: parsed }),
  });
  const faultIndex = cloud.faults.findIndex(
    (fault) => fault.method === method && fault.path === path,
  );
  if (faultIndex >= 0) {
    const fault = must(cloud.faults.splice(faultIndex, 1)[0]);
    return Promise.resolve(json(fault.status, fault.body));
  }
  if (path === WELL_KNOWN) {
    return Promise.resolve(json(200, { capabilities: cloud.capabilities }));
  }
  return Promise.resolve(
    cloud.route(method, path, isRecord(parsed) ? parsed : {}),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    realSetTimeout(done, ms);
  });
}

export async function until(
  check: () => boolean,
  label: string,
): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(5);
  }
}

const inFlight = new Set<Promise<unknown>>();

/**
 * Wait until `track()`ed work settles and `fingerprint` holds still, so no tick is
 * cut short. A stable fingerprint alone is not enough: a slow registry write
 * on a busy runner leaves the poll running past it, and the poller skips the
 * next tick while one is still running.
 */
export async function quiet(fingerprint: () => string): Promise<void> {
  let stable = 0;
  let last = fingerprint();
  while (stable < 8) {
    await until(() => inFlight.size === 0, 'quiet: tracked work settles');
    await sleep(10);
    const now = fingerprint();
    // A poll may have started during the sleep.
    stable = now === last && inFlight.size === 0 ? stable + 1 : 0;
    last = now;
  }
}

/** Count background `work` a job starts without awaiting until it settles. */
export function track<T>(work: Promise<T>): Promise<T> {
  inFlight.add(work);
  const done = (): void => void inFlight.delete(work);
  void work.then(done, done);
  return work;
}
/** Wait for all tracked work, including work it starts, before teardown. */
export async function drain(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

const marks = new Map<unknown[], number>();
/** Remember where each list ends, so `since` returns what came after. */
export function mark(...lists: unknown[][]): void {
  for (const list of lists) marks.set(list, list.length);
}
export function since<T>(list: T[]): T[] {
  return list.slice(marks.get(list) ?? 0);
}

/** The comments registry as it sits on disk, or null when never written. */
export function registryFile(dataDir: string): unknown {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(dataDir, 'shared-run-comments.json'), 'utf8'),
    );
    return raw;
  } catch {
    return null;
  }
}

/** What a renderer call answers, or the message its rejection carries. */
export async function invoke(
  channel: string,
  request: unknown,
): Promise<unknown> {
  const handler = must(handlers.get(channel));
  try {
    const value: unknown = await handler({}, request);
    return { resolved: value };
  } catch (error) {
    return {
      rejected: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The product name, API namespaces and fixture key are masked in snapshots. */
export function stable(value: unknown): unknown {
  const masks: [string, string][] = [
    [BRAND.displayName, '<Brand>'],
    [API_KEY, '<api key>'],
    [BRAND.web.apiNamespace, '<ns>'],
    [BRAND.web.wellKnownNamespace, '<ns>'],
  ];
  const mask = (_key: string, entry: unknown): unknown =>
    typeof entry !== 'string'
      ? entry
      : masks.reduce((text, [from, to]) => text.split(from).join(to), entry);
  const masked: unknown = JSON.parse(JSON.stringify(value), mask);
  return masked;
}

type Session = Record<'projectId' | 'worktreeId' | 'chatId', string>;
export function session(chatId: string): Session {
  return { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId };
}

export function saveShare(
  chatId: string,
  share: SharedRunMetadata | null,
): void {
  const key = `${WORKSPACE_ID}/${WORKTREE_ID}/${chatId}`;
  if (share) savedShares.set(key, share);
  else savedShares.delete(key);
}

/** A chat's saved share metadata for a team-scoped run. */
export function teamShare(externalId: string): SharedRunMetadata {
  return {
    externalId,
    shareScope: 'team',
    teamId: TEAM_ID,
    sharedAt: FIXED_TIME,
  };
}

/** Save the fake account through the real account store. */
export async function saveAccount(capabilities: string[]): Promise<void> {
  const store = await import('../../lib/canopy-cloud-account-store');
  const dates = { createdAt: FIXED_TIME, updatedAt: FIXED_TIME };
  const org = { id: ORG_ID, name: 'Example Org', ...dates };
  const lapsed = { id: LAPSED_ORG_ID, name: 'Lapsed Org', ...dates };
  await store.saveCanopyCloudAccount({
    apiKey: API_KEY,
    capabilities,
    organizations: [org, lapsed],
    teams: [
      { id: TEAM_ID, name: 'Platform', organization: org, ...dates },
      {
        id: LAPSED_TEAM_ID,
        name: 'Lapsed team',
        organization: lapsed,
        ...dates,
      },
    ],
    orgBillingStates: [
      {
        organizationId: LAPSED_ORG_ID,
        organizationName: 'Lapsed Org',
        teamsEntitled: false,
      },
    ],
    ...dates,
  });
}

// The real module object the code under test shares, not an interop copy.
const fs = jest.requireActual<typeof NodeFs>('node:fs');

/** Every data-root override the shared-run code paths read. */
const DATA_ROOT_ENV = ['CANOPY_DATA_DIR', 'CANOPY_SECURE_DATA_DIR'] as const;

/** fs functions that write or delete, with the indexes of their path args. */
const WRITERS: [string, number[]][] = [
  ...'writeFile appendFile mkdir mkdtemp rm rmdir unlink truncate'
    .split(' ')
    .map((name): [string, number[]] => [name, [0]]),
  ...'copyFile cp link symlink'
    .split(' ')
    .map((name): [string, number[]] => [name, [1]]),
  ['rename', [0, 1]],
];

export interface OwnedDataRoot {
  dataDir: string;
  secureDir: string;
  /** Writes and deletes the guard refused because they fell outside the root. */
  outsideWrites: string[];
  /** Undo everything, then assert the guard saw only writes inside the root. */
  release: () => void;
}

function pathOf(value: unknown): string | null {
  if (typeof value === 'string') return resolve(value);
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return resolve(value.toString());
  return null;
}

function opensForWrite(flags: unknown): boolean {
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  if (typeof flags !== 'number') return false;
  const { O_WRONLY, O_RDWR, O_APPEND, O_CREAT } = fs.constants;
  return (flags & (O_WRONLY | O_RDWR | O_APPEND | O_CREAT)) !== 0;
}

/**
 * Point every data-root override at a fresh temp root and refuse (and record)
 * any fs write or delete outside it. Call before the code under test loads.
 */
export function ownDataRoot(prefix: string): OwnedDataRoot {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const roots = [root, join(tmpdir(), basename(root))];
  // Jest's default transform cache sits beside the root under the temp dir
  // and is written when a module first loads: `jest_<uid>` where the platform
  // has uids, plain `jest` on Windows. The repo sets no cacheDirectory.
  const jestCache = join(realpathSync(tmpdir()), 'jest');
  const inJestCache = (target: string): boolean =>
    target === jestCache ||
    target.startsWith(jestCache + sep) ||
    target.startsWith(`${jestCache}_`);
  const insideWrites: string[] = [];
  const owned: OwnedDataRoot = {
    dataDir: join(root, 'data'),
    secureDir: join(root, 'secure'),
    outsideWrites: [],
    release: () => undefined,
  };
  const previous = DATA_ROOT_ENV.map(
    (name) => [name, process.env[name]] as const,
  );
  process.env.CANOPY_DATA_DIR = owned.dataDir;
  process.env.CANOPY_SECURE_DATA_DIR = owned.secureDir;

  const check = (value: unknown): void => {
    const target = pathOf(value);
    if (target === null || inJestCache(target)) return;
    if (roots.some((dir) => target === dir || target.startsWith(dir + sep))) {
      insideWrites.push(target);
      return;
    }
    owned.outsideWrites.push(target);
    throw new Error(`Golden wrote outside its data root: ${target}`);
  };
  const restores: (() => void)[] = [];
  let owning = true;
  const wrap = (
    target: object,
    name: string,
    paths: (args: unknown[]) => unknown[],
  ): void => {
    const original: unknown = Reflect.get(target, name);
    if (typeof original !== 'function') return;
    Reflect.set(
      target,
      name,
      function (this: unknown, ...args: unknown[]): unknown {
        // Restoring fs cannot reach copies taken meanwhile (Node's internal
        // rimraf keeps the fs.rmdir and fs.unlink it first saw for the whole
        // worker), so a released wrapper must pass every call straight through.
        if (owning) for (const path of paths(args)) check(path);
        const result: unknown = Reflect.apply(original, this, args);
        return result;
      },
    );
    restores.push(() => Reflect.set(target, name, original));
  };
  for (const [name, indexes] of WRITERS) {
    const paths = (args: unknown[]): unknown[] =>
      indexes.map((index) => args[index]);
    wrap(fs, name, paths);
    wrap(fs, `${name}Sync`, paths);
    wrap(fs.promises, name, paths);
  }
  const opened = (args: unknown[]): unknown[] =>
    opensForWrite(args[1]) ? [args[0]] : [];
  wrap(fs, 'open', opened);
  wrap(fs, 'openSync', opened);
  wrap(fs.promises, 'open', opened);
  wrap(fs, 'createWriteStream', (args) => [args[0]]);

  owned.release = (): void => {
    owning = false;
    for (const restore of restores.reverse()) restore();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
    expect(owned.outsideWrites).toEqual([]);
    expect(insideWrites).toEqual(
      expect.arrayContaining([
        join(owned.dataDir, 'shared-run-comments.json'),
        expect.stringContaining(owned.secureDir),
      ]),
    );
  };
  return owned;
}
