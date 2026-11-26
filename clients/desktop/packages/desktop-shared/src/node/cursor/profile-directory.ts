import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  ensurePrivateLockDirectory,
  withOwnerLockFile,
} from '@canopy/execution-engine/node/lib/owner-lock-file';
import {
  assertCursorHookPathBudget,
  encodeCursorProjectDir,
} from './project-dir';

/** Cursor state belongs to the work entry that owns the conversation. */
export function getCursorProfileDirectory(
  ownerDirectory: string,
  profileId: string,
  platform: NodeJS.Platform | null = hostOperatingSystem(),
): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(profileId)) {
    throw new Error('Cursor conversation identity is not a path component.');
  }
  return platform === 'win32'
    ? join(
        ownerDirectory,
        'cs',
        createHash('sha256').update(profileId).digest('hex').slice(0, 32),
      )
    : join(ownerDirectory, 'cursor-sessions', profileId);
}

async function inspect(
  target: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
}

async function readRecord(target: string): Promise<string | undefined> {
  const info = await inspect(target);
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) {
    throw new Error(
      "Couldn't prepare Cursor's saved conversation because its location record is unreadable. Keep the saved files and report this error.",
    );
  }
  return readFile(target, 'utf8');
}

async function publishRecord(
  target: string,
  record: string,
  stagingRoot = dirname(target),
  readOnly = false,
): Promise<void> {
  const temporary = join(stagingRoot, `.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(record, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    if (readOnly) await chmod(temporary, 0o400);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

const CONFLICT =
  "Couldn't prepare Cursor's saved conversation because its old and new locations conflict. Keep both locations and report this error.";
const MISSING =
  "Couldn't find Cursor's relocated conversation. Restore its saved files before continuing.";

function isDirectory(info: Awaited<ReturnType<typeof inspect>>): boolean {
  return Boolean(info?.isDirectory() && !info.isSymbolicLink());
}

// The old app always writes this generated file before spawning Cursor. Keep
// it read-only until the permanent guard is in place, including across a crash
// between moving the private HOME and installing its guard.
async function legacyHookFile(legacy: string, cwd: string): Promise<string> {
  let directory = legacy;
  for (const part of ['projects', encodeCursorProjectDir(cwd), '.cursor']) {
    directory = join(directory, part);
    await ensurePrivateLockDirectory(directory);
  }
  return join(directory, 'hooks.json');
}

async function protectLegacyHook(
  target: string,
  record: string,
  stagingRoot: string,
): Promise<void> {
  const info = await inspect(target);
  if (info && !info.isFile()) throw new Error(CONFLICT);
  if (
    info?.size === Buffer.byteLength(record) &&
    (await readRecord(target)) === record
  ) {
    if (info.nlink !== 1) throw new Error(CONFLICT);
    await chmod(target, 0o400);
    return;
  }
  // Replace only the generated hooks configuration. No native session data
  // moves until the legacy app is unable to overwrite this marker on Windows.
  await publishRecord(target, record, stagingRoot, true);
}

async function moveEntry(source: string, target: string): Promise<void> {
  if (await inspect(target)) throw new Error(CONFLICT);
  await rename(source, target);
}

// A retry must distinguish the original HOME from one an older app recreated
// after the rename. The directory's file ID survives a same-volume rename.
async function stageLegacyHome(home: string, stage: string): Promise<void> {
  const saved = join(stage, 'home');
  const staged = await inspect(saved);
  const source = await inspect(home);
  const journal = `${stage}.home-id`;
  const recorded = await readRecord(journal);
  if (!staged && !source) {
    if (recorded !== undefined) throw new Error(MISSING);
    return;
  }
  if ((staged && !isDirectory(staged)) || (source && !isDirectory(source))) {
    throw new Error(CONFLICT);
  }
  const directory = await lstat(staged ? saved : home, { bigint: true });
  const fileId = directory.ino
    ? `${directory.dev}:${directory.ino}`
    : undefined;
  if (recorded !== undefined && recorded !== fileId) throw new Error(CONFLICT);
  if (staged) {
    if (source) {
      if (!fileId || !recorded) throw new Error(CONFLICT);
      await moveEntry(home, `${stage}.recreated-home-${randomUUID()}`);
    }
    return;
  }
  if (fileId && recorded === undefined) await publishRecord(journal, fileId);
  await moveEntry(home, saved);
}

async function stageLegacyProfile(
  legacy: string,
  stage: string,
  cwd: string,
  record: string,
  guarded: boolean,
): Promise<void> {
  const home = join(legacy, 'home');
  if (!guarded) {
    const hook = await legacyHookFile(legacy, cwd);
    await protectLegacyHook(hook, record, dirname(stage));
    await stageLegacyHome(home, stage);
    await publishRecord(home, record, dirname(stage));
  }
  await rm(`${stage}.home-id`, { force: true });
  // Older builds reject the regular file as their private HOME. Their driver
  // can no longer start, even if it runs from a different working directory.
  if (await inspect(join(legacy, 'projects'))) {
    const hook = await legacyHookFile(legacy, cwd);
    if ((await readRecord(hook)) !== record || (await lstat(hook)).nlink !== 1)
      throw new Error(CONFLICT);
    await chmod(hook, 0o600);
    // Move projects first so interrupted retries know whether to unseal it.
    await moveEntry(join(legacy, 'projects'), join(stage, 'projects'));
  }
  for (const name of await readdir(legacy)) {
    if (name.toLowerCase() !== 'home') {
      await moveEntry(join(legacy, name), join(stage, name));
    }
  }
}

interface PreparedCursorProfile {
  directory: string;
  /** Only the saved session that accompanied an actual migration needs verification. */
  confirmResume?: () => Promise<void>;
}

export async function prepareCursorProfileDirectory(
  ownerDirectory: string,
  profileId: string,
  cwd: string,
  options: { platform?: NodeJS.Platform; sessionId?: string } = {},
): Promise<PreparedCursorProfile> {
  const platform = options.platform ?? hostOperatingSystem();
  const profile = getCursorProfileDirectory(
    ownerDirectory,
    profileId,
    platform,
  );
  if (platform !== 'win32') return { directory: profile };
  assertCursorHookPathBudget(profile, cwd, platform);
  const legacy = join(ownerDirectory, 'cursor-sessions', profileId);
  const record = `${JSON.stringify({ version: 1, profileId })}\n`;
  const stage = `${profile}.moving`;
  const recordPath = `${profile}.json`;
  const pending = `${profile}.resume`;
  const sessionDigest = options.sessionId
    ? createHash('sha256').update(options.sessionId).digest('hex')
    : undefined;
  await ensurePrivateLockDirectory(dirname(profile));
  return withOwnerLockFile(
    `${profile}.lock`,
    async () => {
      await ensurePrivateLockDirectory(dirname(legacy));
      const old = await inspect(legacy);
      const current = await inspect(profile);
      const staging = await inspect(stage);
      const identity = await readRecord(recordPath);
      const pendingDigest = await readRecord(pending);
      if (
        (identity !== undefined && identity !== record) ||
        (pendingDigest !== undefined &&
          (!identity || !/^[a-f0-9]{64}$/.test(pendingDigest))) ||
        (current && (!isDirectory(current) || !identity || staging)) ||
        (staging && (!isDirectory(staging) || !identity)) ||
        (old && !isDirectory(old) && !old.isFile())
      )
        throw new Error(CONFLICT);

      const home = join(legacy, 'home');
      const oldHome = isDirectory(old) ? await inspect(home) : undefined;
      const guarded = oldHome?.isFile() && (await readRecord(home)) === record;
      if (oldHome && !guarded && !isDirectory(oldHome))
        throw new Error(CONFLICT);
      if (old?.isFile() && (await readRecord(legacy)) !== record)
        throw new Error(CONFLICT);
      if ((guarded || old?.isFile()) && !current && !staging)
        throw new Error(MISSING);

      if (current) {
        if (isDirectory(old)) {
          if (!guarded || (await readdir(legacy)).length !== 1)
            throw new Error(CONFLICT);
        } else if (!old) {
          // Finish the marker for an interrupted upgrade from the initial layout.
          await publishRecord(legacy, record, dirname(profile));
        }
      } else {
        if (!isDirectory(old) && staging && (await readdir(stage)).length)
          throw new Error(MISSING);
        if (!identity) await publishRecord(recordPath, record);
        if (!staging) await mkdir(stage, { mode: 0o700 });
        if (isDirectory(old)) {
          if (!guarded && sessionDigest && pendingDigest === undefined)
            await publishRecord(pending, sessionDigest);
          await stageLegacyProfile(
            legacy,
            stage,
            cwd,
            record,
            Boolean(guarded),
          );
        } else if (!old) {
          await publishRecord(legacy, record, dirname(profile));
        }
        // Only a complete profile is visible to a provider. Staging and guards
        // are inside this work entry and use same-volume renames.
        await rename(stage, profile);
      }
      if (sessionDigest && (await readRecord(pending)) === sessionDigest) {
        return {
          directory: profile,
          confirmResume: () => rm(pending, { force: true }),
        };
      }
      return { directory: profile };
    },
    {
      maxWaitMs: 10_000,
      timeoutMessage:
        "Couldn't prepare Cursor's saved conversation because another process is moving it. Wait for it to finish, then try again.",
    },
  );
}
