// Shared harness for the CAN-6501 shared-container goldens: the in-test
// hosted service at `fetch`, IPC invocation, snapshot masking and data-root
// ownership with its outside-write guard, after the CAN-4169 harness.
// shortcut: each CAN-6501 PR carries an identical copy of this file; dedupe
// when the first one lands.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type * as NodeFs from 'node:fs';
import type * as NodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '@canopy/brand/current';
import { BrowserWindow } from 'electron';

export const FIXED_TIME = '2026-11-01T12:00:00.000Z';
export const API_KEY = 'csk_shared_containers_golden_fake';
const API = `/api/v1/${BRAND.web.apiNamespace}`;
const WELL_KNOWN = `/.well-known/${BRAND.web.wellKnownNamespace}`;

export type Json = Record<string, unknown>;
type Handler = (event: unknown, ...args: unknown[]) => unknown;

/** IPC handlers by channel, as the mocked registerIpcHandler records them. */
export const handlers = new Map<string, Handler>();

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- In-test hosted service ---------------------------------------------------

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
  body?: unknown;
}

export const cloud: {
  requests: RecordedRequest[];
  capabilities: string[];
  /** The `<api>/…` routes a golden serves; everything else is a 404. */
  route: (method: string, path: string, body: Json) => Response;
} = {
  requests: [],
  capabilities: [],
  route: () => json(404, { error: 'Not found.' }),
};

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

/** Records every request, then answers it from the golden's routes. */
export function fakeCloud(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(requestUrl(input));
  const method = (init?.method ?? 'GET').toUpperCase();
  const parsed: unknown =
    typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  const path = `${url.pathname.replace(API, '<api>')}${url.search}`;
  cloud.requests.push({
    method,
    path,
    authorization: new Headers(init?.headers).get('authorization'),
    ...(parsed === undefined ? {} : { body: parsed }),
  });
  if (url.pathname === WELL_KNOWN) {
    return Promise.resolve(json(200, { capabilities: cloud.capabilities }));
  }
  return Promise.resolve(
    cloud.route(method, path, isRecord(parsed) ? parsed : {}),
  );
}

/** Save the fake account through the real account store. */
export async function saveAccount(capabilities: string[]): Promise<void> {
  const store = await import('../../lib/canopy-cloud-account-store');
  await store.saveCanopyCloudAccount({
    apiKey: API_KEY,
    capabilities,
    organizations: [],
    teams: [],
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  });
}

// --- Invocation and snapshots -------------------------------------------------

/** Give main one window and record the pushes sent to it. */
export function recordPushes(): {
  /** A copy of each push so far, as `[channel, ...payload]`. */
  list: () => unknown[][];
  clear: () => void;
} {
  const window = new BrowserWindow();
  jest.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([window]);
  const send = jest.spyOn(window.webContents, 'send');
  return {
    list: () => send.mock.calls.map((call: unknown[]) => call.slice()),
    clear: () => send.mockClear(),
  };
}

/** What a renderer call answers, or the message its rejection carries. */
export async function invoke(
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  try {
    const value: unknown = await handler({}, ...args);
    return { resolved: value };
  } catch (error) {
    return {
      rejected: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Masks the product name, API namespaces, the fake key and the data root. */
export function stable(value: unknown, root?: string): unknown {
  const masks: [string, string][] = [
    ...(root ? [[root, '<root>'] as [string, string]] : []),
    [BRAND.displayName, '<Brand>'],
    [API_KEY, '<api key>'],
    [BRAND.web.apiNamespace, '<ns>'],
    [BRAND.web.wellKnownNamespace, '<ns>'],
  ];
  const mask = (_key: string, entry: unknown): unknown =>
    typeof entry !== 'string'
      ? entry
      : masks.reduce((text, [from, to]) => text.split(from).join(to), entry);
  const masked: unknown = JSON.parse(JSON.stringify(value ?? null), mask);
  return masked;
}

// --- Data-root ownership ------------------------------------------------------

// The real module object the code under test shares, not an interop copy.
const fs = jest.requireActual<typeof NodeFs>('node:fs');

const os = jest.requireActual<typeof NodeOs>('node:os');

/** Every data-root override the shared-container code paths read. */
const DATA_ROOT_ENV = ['CANOPY_DATA_DIR', 'CANOPY_SECURE_DATA_DIR'];
const isGitEnv = (name: string): boolean => name.startsWith('GIT_');

/** fs functions that write or delete, with the indexes of their path args. */
const WRITERS: [string, number[]][] = [
  ...'writeFile appendFile mkdir mkdtemp rm rmdir unlink truncate chmod'
    .split(' ')
    .map((name): [string, number[]] => [name, [0]]),
  ...'copyFile cp link symlink'
    .split(' ')
    .map((name): [string, number[]] => [name, [1]]),
  ['rename', [0, 1]],
];

export interface OwnedDataRoot {
  root: string;
  dataDir: string;
  secureDir: string;
  /** An empty git template dir the golden owns, for `git init --template`. */
  gitTemplateDir: string;
  /** Writes and deletes the guard refused because they fell outside the root. */
  outsideWrites: string[];
  /** Writes and deletes the guard let through inside the root. */
  insideWrites: string[];
  /**
   * Restores the fs functions and env values and removes the root, then
   * asserts nothing landed outside it.
   */
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
 * Give the golden its own temp data root: point every data-root override at
 * it, and refuse (and record) any fs write or delete outside it. Call before
 * the first import of the code under test, so modules that capture fs
 * functions at load capture the guarded ones.
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
  const owned: OwnedDataRoot = {
    root,
    dataDir: join(root, 'data'),
    secureDir: join(root, 'secure'),
    gitTemplateDir: join(root, 'git', 'template'),
    outsideWrites: [],
    insideWrites: [],
    release: () => undefined,
  };
  // Every inherited GIT_ variable is dropped, whatever it points at.
  const previous = [
    ...DATA_ROOT_ENV,
    ...Object.keys(process.env).filter(isGitEnv),
  ].map((name) => [name, process.env[name]] as const);
  const restores: (() => void)[] = [];
  let owning = true;
  const undo = (): void => {
    owning = false;
    for (const restore of restores.reverse()) restore();
    for (const name of Object.keys(process.env).filter(isGitEnv)) {
      delete process.env[name];
    }
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  };

  const check = (value: unknown): void => {
    const target = pathOf(value);
    if (target === null || inJestCache(target)) return;
    if (roots.some((dir) => target === dir || target.startsWith(dir + sep))) {
      owned.insideWrites.push(target);
      return;
    }
    owned.outsideWrites.push(target);
    throw new Error(`Golden wrote outside its data root: ${target}`);
  };
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

  try {
    for (const [name] of previous) delete process.env[name];
    process.env.CANOPY_DATA_DIR = owned.dataDir;
    process.env.CANOPY_SECURE_DATA_DIR = owned.secureDir;
    // Fixture and production git commands spread this env: they see only a
    // git config, template and identity the golden owns, with no system
    // config, global excludes or hooks of the developer's or CI image's.
    const gitDir = join(root, 'git');
    mkdirSync(join(gitDir, 'hooks'), { recursive: true });
    mkdirSync(owned.gitTemplateDir);
    writeFileSync(join(gitDir, 'ignore'), '');
    // Quoted, so the backslashes of a Windows path are not read as escapes.
    const value = (path: string): string => JSON.stringify(path);
    writeFileSync(
      join(gitDir, 'config'),
      `[core]\n\texcludesFile = ${value(join(gitDir, 'ignore'))}\n\thooksPath = ${value(join(gitDir, 'hooks'))}\n[init]\n\ttemplateDir = ${value(owned.gitTemplateDir)}\n`,
    );
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: join(gitDir, 'config'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TEMPLATE_DIR: owned.gitTemplateDir,
      GIT_AUTHOR_NAME: 'Golden',
      GIT_AUTHOR_EMAIL: 'golden@example.test',
      GIT_COMMITTER_NAME: 'Golden',
      GIT_COMMITTER_EMAIL: 'golden@example.test',
    });
    // Git executable validation makes its scratch repositories in the OS
    // temp dir, so the golden owns that too.
    const ownTmp = join(root, 'tmp');
    mkdirSync(ownTmp);

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
    const realTmpdir = os.tmpdir;
    Reflect.set(os, 'tmpdir', () => (owning ? ownTmp : realTmpdir()));
    restores.push(() => Reflect.set(os, 'tmpdir', realTmpdir));
  } catch (error) {
    // A setup that fails partway leaves no env, fs patch or temp tree behind.
    undo();
    throw error;
  }

  owned.release = (): void => {
    undo();
    expect(owned.outsideWrites).toEqual([]);
  };
  return owned;
}
