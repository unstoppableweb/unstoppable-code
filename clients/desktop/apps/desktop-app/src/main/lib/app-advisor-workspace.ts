import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { OrchestratorInstructionsConflictError } from '@canopy/protocol/remote-control/shell';
import { createSerialQueue } from '@canopy/core-runtime/node/w5/file-store';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type AppAdvisorClaudeMdLoadResponse,
  type AppAdvisorClaudeMdSaveRequest,
  type AppAdvisorClaudeMdSaveResponse,
  type AppAdvisorSettingsSaveRequest,
  type AppAdvisorWorkspaceSettingsFile,
} from '@canopy/desktop-shared/types';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import {
  MAX_ARCHIVE_RETENTION_DAYS,
  appAdvisorPurgeRetentionDays,
  resolveAutoArchiveDays,
} from '@canopy/desktop-shared/lib/archive-retention';
import { readChatArchivesFile, removeChatArchive } from './chat-archives';
import { listWorkEntryIds } from './cowork-work-entries';
import {
  InstructionsChangedError,
  loadManagedInstructionPair,
  saveManagedInstructionPair,
  scaffoldManagedInstructionPair,
} from './chat-project-instructions';
import {
  getAppAdvisorHomeDir,
  getAppAdvisorInstructionSaveFilePath,
  getAppAdvisorSettingsFilePath,
} from './paths';
import { isErrnoException, isRecord } from './type-guards';
import { touchAllWorkspaceTargets } from './workspace-activity';
import { withArchivedWorkspaceOperationLock } from './archived-containers';

const APP_ADVISOR_CLAUDE_MD_CONTENT = [
  `This project is the home for ${ORCHESTRATOR_LABEL} conversations.`,
  "Generated outputs (files you create) go directly in this folder's root unless the user names a different location.",
  `Durable notes, reusable prompt snippets, and user-provided attachments live under ${BRAND.storage.projectConfigDirNames[0]}/notes, ${BRAND.storage.projectConfigDirNames[0]}/prompts, and ${BRAND.storage.projectConfigDirNames[0]}/attachments.`,
  'Archived chat history lives outside this folder and is not browsable here.',
].join(' ');

const DEFAULT_SETTINGS: AppAdvisorWorkspaceSettingsFile = {
  version: 1,
  archiveRetentionDays: null,
  autoArchiveDays: null,
};
const serializeInstructions = createSerialQueue();

function normalizeSettings(value: unknown): AppAdvisorWorkspaceSettingsFile {
  if (!isRecord(value) || value.version !== 1) {
    return { ...DEFAULT_SETTINGS };
  }
  const description =
    typeof value.description === 'string' ? value.description : undefined;
  const archiveRetentionDays =
    value.archiveRetentionDays === null ||
    (typeof value.archiveRetentionDays === 'number' &&
      Number.isInteger(value.archiveRetentionDays) &&
      value.archiveRetentionDays >= 0 &&
      value.archiveRetentionDays <= MAX_ARCHIVE_RETENTION_DAYS)
      ? value.archiveRetentionDays
      : null;
  const autoArchiveDays =
    value.autoArchiveDays === null ||
    (typeof value.autoArchiveDays === 'number' &&
      Number.isInteger(value.autoArchiveDays) &&
      value.autoArchiveDays >= 1 &&
      value.autoArchiveDays <= MAX_ARCHIVE_RETENTION_DAYS)
      ? value.autoArchiveDays
      : null;
  return {
    version: 1,
    ...(description !== undefined ? { description } : {}),
    archiveRetentionDays,
    autoArchiveDays,
  };
}

async function writeSettingsAtomic(
  settings: AppAdvisorWorkspaceSettingsFile,
): Promise<void> {
  const filePath = getAppAdvisorSettingsFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), `.settings-${randomUUID()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

async function withAppAdvisorInstructionsHome<T>(
  operation: (home: string) => Promise<T>,
): Promise<T> {
  const home = getAppAdvisorHomeDir();
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(getCoworkManagedSubdir(home, 'notes'), { recursive: true }),
    mkdir(getCoworkManagedSubdir(home, 'prompts'), { recursive: true }),
    mkdir(getCoworkManagedSubdir(home, 'attachments'), { recursive: true }),
  ]);

  return serializeInstructions(() => operation(home));
}

export async function ensureAppAdvisorHomeScaffold(): Promise<void> {
  await withAppAdvisorInstructionsHome((home) =>
    scaffoldManagedInstructionPair(home, APP_ADVISOR_CLAUDE_MD_CONTENT),
  );
}

export async function readAppAdvisorWorkspaceSettings(): Promise<AppAdvisorWorkspaceSettingsFile> {
  try {
    const raw = await readFile(getAppAdvisorSettingsFilePath(), 'utf8');
    return normalizeSettings(JSON.parse(raw));
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (isErrnoException(error) && error.code === 'ENOENT')
    ) {
      return { ...DEFAULT_SETTINGS };
    }
    throw error;
  }
}

/**
 * `precondition` runs under the settings lock with the stored settings and may
 * throw to refuse the save before anything is written (CAN-6004).
 */
export async function saveAppAdvisorWorkspaceSettings(
  request: AppAdvisorSettingsSaveRequest,
  precondition?: (current: AppAdvisorWorkspaceSettingsFile) => void,
): Promise<AppAdvisorWorkspaceSettingsFile> {
  return withArchivedWorkspaceOperationLock(
    APP_ADVISOR_PROJECT_ID,
    async () => {
      const current = await readAppAdvisorWorkspaceSettings();
      precondition?.(current);
      const settings = normalizeSettings({ ...current, ...request });
      const enablingAutoArchive =
        resolveAutoArchiveDays(
          'app-advisor',
          current.archiveRetentionDays,
          current.autoArchiveDays,
        ) === null &&
        resolveAutoArchiveDays(
          'app-advisor',
          settings.archiveRetentionDays,
          settings.autoArchiveDays,
        ) !== null;
      if (enablingAutoArchive) {
        await touchAllWorkspaceTargets(APP_ADVISOR_PROJECT_ID);
      }
      await writeSettingsAtomic(settings);
      return settings;
    },
  );
}

export async function readAppAdvisorClaudeMd(): Promise<AppAdvisorClaudeMdLoadResponse> {
  return withAppAdvisorInstructionsHome((home) =>
    loadManagedInstructionPair(
      home,
      APP_ADVISOR_CLAUDE_MD_CONTENT,
      getAppAdvisorInstructionSaveFilePath(),
    ),
  );
}

export async function saveAppAdvisorClaudeMd(
  request: AppAdvisorClaudeMdSaveRequest,
): Promise<AppAdvisorClaudeMdSaveResponse> {
  return serializeInstructions(async () => {
    try {
      return await saveManagedInstructionPair(
        getAppAdvisorHomeDir(),
        request,
        getAppAdvisorInstructionSaveFilePath(),
      );
    } catch (error) {
      if (error instanceof InstructionsChangedError)
        throw new OrchestratorInstructionsConflictError(error);
      throw error;
    }
  });
}

export async function applyAppAdvisorArchiveRetention(): Promise<void> {
  const settings = await readAppAdvisorWorkspaceSettings();
  const retentionDays = appAdvisorPurgeRetentionDays(
    settings.archiveRetentionDays,
  );
  if (retentionDays === null) {
    return;
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const entryIds = new Set([
    ...(await listWorkEntryIds(APP_ADVISOR_PROJECT_ID)),
    APP_ADVISOR_WORKTREE_ID,
  ]);
  for (const entryId of Array.from(entryIds)) {
    const archives = await readChatArchivesFile(
      APP_ADVISOR_PROJECT_ID,
      entryId,
    );
    const expired = archives.archived.filter(
      (entry) => new Date(entry.archivedAt).getTime() < cutoff,
    );
    for (const entry of expired) {
      await removeChatArchive(APP_ADVISOR_PROJECT_ID, entryId, entry.tab.id);
    }
  }
}

export async function loadAppAdvisorWorkspaceSettings(): Promise<AppAdvisorWorkspaceSettingsFile> {
  await applyAppAdvisorArchiveRetention();
  return readAppAdvisorWorkspaceSettings();
}

export async function initializeAppAdvisorWorkspace(): Promise<void> {
  await ensureAppAdvisorHomeScaffold();
  await applyAppAdvisorArchiveRetention();
}
