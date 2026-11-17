import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { promisify } from 'node:util';
import { ANTIGRAVITY_RUNTIME_VERSION } from './runtime-metadata';

/**
 * Google's Developer ID designated requirement for the pinned macOS CLI.
 * The identifier excludes Google's other signed tools, such as the IDE's
 * language server, and the certificate fields admit only a Developer ID
 * Application leaf, not a development certificate from the same team.
 */
const ANTIGRAVITY_CODE_REQUIREMENT = [
  'anchor apple generic',
  'identifier "cli"',
  'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
  'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
  'certificate leaf[subject.OU] = "EQHXZ8M8AV"',
].join(' and ');

const CODESIGN = '/usr/bin/codesign';
const VERIFY_TIMEOUT_MS = 60_000;

const ANTIGRAVITY_UNVERIFIED_EXECUTABLE_MESSAGE = `This Antigravity CLI isn't Google's signed release. Reinstall Antigravity CLI ${ANTIGRAVITY_RUNTIME_VERSION} from Google.`;
/** An identity change can be a genuine reinstall, so it asks for a retry. */
const ANTIGRAVITY_CHANGED_EXECUTABLE_MESSAGE =
  'The Antigravity CLI changed during launch. Try again.';

/**
 * A verdict is reused only while every field that changes when the file's
 * bytes are replaced or rewritten still matches. Renames change the inode,
 * and in-place writes change the size or ctime, which a caller cannot reset.
 */
function fileIdentity(info: BigIntStats): string {
  return [
    info.dev,
    info.ino,
    info.size,
    info.mtimeNs,
    info.ctimeNs,
    info.mode,
  ].join(':');
}

const verified = new Map<string, string>();
/** One codesign run per file identity, shared by launches that start together. */
const pending = new Map<string, Promise<void>>();

const execFileAsync = promisify(execFile);

function changedDuringLaunch(detail: string, cause?: unknown): Error {
  return Object.assign(new Error(ANTIGRAVITY_CHANGED_EXECUTABLE_MESSAGE), {
    cause: Object.assign(new Error(detail), { cause }),
  });
}

/** The identity now on disk, or undefined once the file is gone. */
async function identityNow(file: string): Promise<string | undefined> {
  try {
    return fileIdentity(await stat(file, { bigint: true }));
  } catch {
    return undefined;
  }
}

function refusal(cause?: unknown): Error {
  // The copy stays generic; the cause keeps codesign's exit, stderr or
  // timeout for logs, so a slow host is distinguishable from a bad file.
  return Object.assign(new Error(ANTIGRAVITY_UNVERIFIED_EXECUTABLE_MESSAGE), {
    cause,
  });
}

async function currentIdentity(file: string): Promise<BigIntStats> {
  try {
    return await stat(file, { bigint: true });
  } catch (error) {
    throw refusal(error);
  }
}

/**
 * Runs codesign once for this identity and records the verdict only when the
 * file still has that identity afterward: bytes replaced while codesign was
 * reading them are not the bytes verified.
 */
function verifyIdentity(file: string, identity: string): Promise<void> {
  const key = `${file}\0${identity}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const verification = (async (): Promise<void> => {
    try {
      await execFileAsync(
        CODESIGN,
        ['--verify', '--strict', `-R=${ANTIGRAVITY_CODE_REQUIREMENT}`, file],
        { timeout: VERIFY_TIMEOUT_MS, env: {} },
      );
    } catch (error) {
      // A reinstall caught mid-read is a change, not an unsigned file.
      if ((await identityNow(file)) !== identity)
        throw changedDuringLaunch(
          'executable changed during verification',
          error,
        );
      throw refusal(error);
    }
    if ((await identityNow(file)) !== identity)
      throw changedDuringLaunch('executable changed during verification');
    verified.set(file, identity);
  })().finally(() => pending.delete(key));
  // A caller that was cancelled no longer awaits the shared run.
  verification.catch(() => undefined);
  pending.set(key, verification);
  return verification;
}

/**
 * Verifies the resolved native executable before it is spawned and returns the
 * real path to launch, so a later symlink retarget cannot redirect the spawn.
 * Only macOS reaches this; other hosts are refused before resolution.
 */
export async function verifyAntigravityExecutable(
  executable: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  let file: string;
  try {
    file = await realpath(executable);
  } catch (error) {
    throw refusal(error);
  }
  const before = await currentIdentity(file);
  // A launch cancelled while its path resolved stops here, before codesign.
  signal?.throwIfAborted();
  if (!before.isFile()) throw refusal(new Error('not a regular file'));
  const identity = fileIdentity(before);
  if (verified.get(file) === identity) return file;
  verified.delete(file);
  let stopWaiting: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    stopWaiting = resolve;
    signal?.addEventListener('abort', stopWaiting, { once: true });
  });
  try {
    await Promise.race([verifyIdentity(file, identity), aborted]);
  } catch (error) {
    // A cancelled launch keeps its own reason, even when the run refused.
    signal?.throwIfAborted();
    throw error;
  } finally {
    if (stopWaiting) signal?.removeEventListener('abort', stopWaiting);
  }
  // The shared run still finishes and caches its verdict for other launches.
  signal?.throwIfAborted();
  return file;
}

/**
 * Re-checks a verified executable just before it is spawned, narrowing the
 * re-execution window to the spawn itself.
 */
export async function assertAntigravityExecutableUnchanged(
  file: string,
): Promise<void> {
  const identity = await identityNow(file);
  if (identity === undefined || verified.get(file) !== identity)
    throw changedDuringLaunch('executable changed before launch');
}
