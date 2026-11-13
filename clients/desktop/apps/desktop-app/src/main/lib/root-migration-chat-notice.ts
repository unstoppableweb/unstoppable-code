import log from 'electron-log/main.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { getCompletedRootMigration } from '@canopy/execution-engine/node/lib/completed-root-migration';
import { getRootMigrationChatNoticesDir } from './paths';
import { isErrnoException } from './type-guards';

interface Notice {
  text: string;
  delivered: () => Promise<void>;
}

const settledNotices = new Set<string>();

interface NoticeInput {
  projectId: string;
  worktreeId: string;
  chatId: string;
  createdAt: () => Promise<string | undefined>;
  provider: string | undefined;
  userText: string;
}

/** Delivery receipts never alter chat history or the retained migration source. */
export async function prepareRootMigrationChatNotice(
  input: NoticeInput,
): Promise<Notice | undefined> {
  try {
    return await prepareNotice(input);
  } catch (error) {
    log.warn(
      '[root-migration-notice] Could not prepare migration notice',
      error,
    );
    return undefined;
  }
}

async function prepareNotice(input: NoticeInput): Promise<Notice | undefined> {
  if (input.provider !== 'claude' && input.provider !== 'codex')
    return undefined;
  // Defer commands: injected text would block their prefix or enter their arguments.
  if (/^\s*[/$][A-Za-z0-9][A-Za-z0-9._:-]*(?=\s|$)/.test(input.userText))
    return undefined;
  const migration = await getCompletedRootMigration();
  if (!migration) return undefined;
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        migration.transactionId,
        input.projectId,
        input.worktreeId,
        input.chatId,
      ]),
    )
    .digest('hex');
  const directory = getRootMigrationChatNoticesDir();
  const receipt = join(directory, `${key}.json`);
  if (settledNotices.has(receipt)) return undefined;
  try {
    await readFile(receipt, 'utf8');
    settledNotices.add(receipt);
    return undefined;
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  }
  const value = await input.createdAt();
  const createdAt = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(createdAt)) return undefined;
  if (createdAt >= migration.completedAtMs) {
    settledNotices.add(receipt);
    return undefined;
  }
  return {
    text: `This work moved from ${migration.source} to ${migration.destination}. The old folder is a backup: do not read, edit, or run Git there. Map paths from earlier turns to the current root.`,
    delivered: async () => {
      // Queue acceptance must not become a failed user input on receipt I/O.
      if (settledNotices.has(receipt)) return;
      settledNotices.add(receipt);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(
          receipt,
          JSON.stringify({ version: 1, delivered: true }),
          {
            mode: 0o600,
            flag: 'wx',
          },
        );
      } catch (error) {
        log.warn(
          '[root-migration-notice] Could not persist delivery receipt',
          error,
        );
      }
    },
  };
}
