import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { logMainProcessWarn } from './main-process-logging';

/**
 * Size ceiling for the legacy `portal-state.json` read. Matches the ceiling the
 * Portal state store applied: a larger file is abandoned unread, which already
 * cost the identifier before this module existed.
 */
export const LEGACY_REMOTE_CONTROL_STATE_FILE_MAX_BYTES = 64 * 1024 * 1024;

const INSTALL_IDENTITY_FILE = 'install-identity.json';
const LEGACY_REMOTE_CONTROL_STATE_FILE = 'portal-state.json';

interface InstallIdentityRecord {
  version: 1;
  installId: string;
}

interface LoadedInstallIdentity {
  installId: string;
  /** Whether `installId` is known to be on disk. */
  durable: boolean;
}

function userDataDir(): string {
  return app.getPath('userData');
}

export function installIdentityFilePath(): string {
  return path.join(userDataDir(), INSTALL_IDENTITY_FILE);
}

export function legacyPortalStateFilePath(): string {
  return path.join(userDataDir(), LEGACY_REMOTE_CONTROL_STATE_FILE);
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

/**
 * Reads a small JSON file. `missing` covers ENOENT, `unusable` covers content
 * that cannot be parsed or exceeds `maxBytes`. Any other read error (EACCES,
 * EIO, ...) is thrown, so a transient failure never stands in for "no ID".
 */
export async function readJsonFileForIdentity(
  filePath: string,
  maxBytes: number,
): Promise<
  | { kind: 'missing' }
  | { kind: 'unusable' }
  | { kind: 'parsed'; value: unknown }
> {
  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  if (size > maxBytes) return { kind: 'unusable' };
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  try {
    const value: unknown = JSON.parse(raw);
    return { kind: 'parsed', value };
  } catch {
    return { kind: 'unusable' };
  }
}

function nonEmptyStringField(value: unknown, field: string): string | null {
  if (typeof value !== 'object' || value === null || !(field in value)) {
    return null;
  }
  const candidate: unknown = Reflect.get(value, field);
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : null;
}

async function writeInstallIdentity(installId: string): Promise<void> {
  const filePath = installIdentityFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Unique per write, so two concurrent saves never share a temp file.
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const record: InstallIdentityRecord = { version: 1, installId };
  try {
    // Flush before the rename: callers treat a resolved write as durable, and
    // a crash must not leave an empty file that reads as "no ID".
    const handle = await fs.open(tempPath, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function loadInstallIdentity(): Promise<LoadedInstallIdentity> {
  // 1. The install's own file.
  const own = await readJsonFileForIdentity(
    installIdentityFilePath(),
    LEGACY_REMOTE_CONTROL_STATE_FILE_MAX_BYTES,
  );
  if (own.kind === 'parsed') {
    const installId = nonEmptyStringField(own.value, 'installId');
    if (installId) return { installId, durable: true };
  }
  if (own.kind !== 'missing') {
    // Rare (writes are atomic), and it changes this install's identity
    // unless the legacy identifier below is still there: leave a trace.
    logMainProcessWarn(
      'Install identity file is unusable; adopting or minting a replacement',
    );
  }
  // 2. Adopt the identifier the Portal state store minted (`clientDeviceId`).
  //    Read-only: this module never writes `portal-state.json`, so an older
  //    build installed over this one still finds the same identifier there.
  const legacy = await readJsonFileForIdentity(
    legacyPortalStateFilePath(),
    LEGACY_REMOTE_CONTROL_STATE_FILE_MAX_BYTES,
  );
  const adopted =
    legacy.kind === 'parsed'
      ? nonEmptyStringField(legacy.value, 'clientDeviceId')
      : null;
  // 3. Otherwise mint. Both files are missing or unusable here; a read error
  //    other than ENOENT has already rejected above, so nothing is minted over
  //    an identifier that was only temporarily unreadable.
  const installId = adopted ?? randomUUID();
  try {
    await writeInstallIdentity(installId);
    return { installId, durable: true };
  } catch {
    return { installId, durable: false };
  }
}

let cached: LoadedInstallIdentity | null = null;
let cachedForDir: string | null = null;
let loadInFlight: Promise<LoadedInstallIdentity> | null = null;
let loadInFlightDir: string | null = null;

async function readInstallIdentity(): Promise<LoadedInstallIdentity> {
  const dir = userDataDir();
  if (cached && cachedForDir === dir) return cached;
  // Single-flight per process and userData path: concurrent first readers must
  // not each mint a different identifier on a fresh profile. A failed load is
  // not cached, so the next call retries.
  if (!loadInFlight || loadInFlightDir !== dir) {
    const run = loadInstallIdentity().then((loaded) => {
      if (userDataDir() === dir) {
        cached = loaded;
        cachedForDir = dir;
      }
      return loaded;
    });
    loadInFlight = run;
    loadInFlightDir = dir;
    void run.then(
      () => {
        if (loadInFlight === run) loadInFlight = null;
      },
      () => {
        if (loadInFlight === run) loadInFlight = null;
      },
    );
  }
  return loadInFlight;
}

/**
 * This install's stable identifier. When it could not be saved, the
 * in-memory value is still returned and stays stable for this process.
 * Rejects only when an existing file could not be read.
 */
export async function getInstallId(): Promise<string> {
  return (await readInstallIdentity()).installId;
}

/**
 * This install's identifier, resolved only once it is on disk, so a value is
 * never reported that a restart would replace. Throws when it cannot be read
 * or saved.
 */
export async function readDurableInstallId(): Promise<string> {
  const loaded = await readInstallIdentity();
  if (loaded.durable) return loaded.installId;
  await writeInstallIdentity(loaded.installId);
  const dir = userDataDir();
  if (cached && cachedForDir === dir && cached.installId === loaded.installId) {
    cached = { installId: loaded.installId, durable: true };
  }
  return loaded.installId;
}
