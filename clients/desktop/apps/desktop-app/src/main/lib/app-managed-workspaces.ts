import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { hasMigrationRun, markMigrationRun } from './migrations';
import {
  w5RecordReadPaths,
  getAppManagedChatWorkspaceDir,
  getAppAdvisorHomeDir,
  getCodeReviewChatsDir,
  getDataDir,
  getLegacyCodeReviewChatsDir,
  getPipelineEditorHomeDir,
} from './paths';
import { isErrnoException, isRecord } from './type-guards';

export const APP_WORKSPACES_MIGRATION_KEY = 'app_workspaces';
export const APP_ADVISOR_HOME_MIGRATION_KEY = 'app_advisor_home';
export const CODE_REVIEW_CHATS_APP_WORKSPACE_MIGRATION_KEY =
  'code_review_chats_app_workspace';
export const PIPELINE_EDITOR_APP_WORKSPACE_MIGRATION_KEY =
  'pipeline_editor_app_workspace';
export const PIPELINE_EDITOR_HOME_MIGRATION_KEY = 'pipeline_editor_home';

const APP_MANAGED_CHAT_WORKSPACE_IDS = [
  APP_ADVISOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
] as const;

const APP_ADVISOR_HOME_MIGRATION_STATE_ENTRY =
  '.app-advisor-home-migration-state';
const APP_ADVISOR_STAGED_HOME_ENTRY = '.app-advisor-staged-home';
const PIPELINE_EDITOR_HOME_MIGRATION_STATE_ENTRY =
  '.pipeline-editor-home-migration-state';
const PIPELINE_EDITOR_STAGED_HOME_ENTRY = '.pipeline-editor-staged-home';

const APP_ADVISOR_METADATA_ENTRIES = new Set([
  APP_ADVISOR_STAGED_HOME_ENTRY,
  'archived-containers',
  'attachments',
  'chat-archives',
  'chats',
  'home',
  'settings.json',
  'sidebar-item-groups.json',
  'summaries',
  'work-entries.json',
  'worktree-data',
]);

const PIPELINE_EDITOR_METADATA_ENTRIES = new Set([
  PIPELINE_EDITOR_STAGED_HOME_ENTRY,
  'archived-containers',
  'attachments',
  'chat-archives',
  'chats',
  'home',
  'summaries',
  'worktree-data',
]);

function isAppAdvisorMetadataEntry(name: string): boolean {
  return (
    APP_ADVISOR_METADATA_ENTRIES.has(name) ||
    name.startsWith('sidebar-item-groups.json.corrupt-') ||
    (name.startsWith('.sidebar-item-groups.json.') && name.endsWith('.tmp')) ||
    ((name.startsWith('.settings-') || name.startsWith('.work-entries-')) &&
      name.endsWith('.tmp'))
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function isIndexedUserWorkspace(workspaceId: string): Promise<boolean> {
  try {
    const raw = await readFile(w5RecordReadPaths.index(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.workspaces)) {
      return false;
    }
    return parsed.workspaces.some(
      (entry) => isRecord(entry) && entry.id === workspaceId,
    );
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (isErrnoException(error) &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR'))
    ) {
      return false;
    }
    throw error;
  }
}

async function movePath(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'EXDEV') {
      throw error;
    }
    await cp(source, destination, { recursive: true, force: false });
    await rm(source, { recursive: true, force: true });
  }
}

async function removeIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    const code = isErrnoException(error) ? error.code : undefined;
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') {
      throw error;
    }
  }
}

async function mergeMissingEntries(
  sourceDir: string,
  destinationDir: string,
): Promise<void> {
  await mkdir(destinationDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(sourceDir, entry.name);
    const destination = join(destinationDir, entry.name);
    if (!(await pathExists(destination))) {
      await movePath(source, destination);
      continue;
    }
    if (entry.isDirectory()) {
      const destinationStat = await stat(destination);
      if (destinationStat.isDirectory()) {
        await mergeMissingEntries(source, destination);
        await removeIfEmpty(source);
      }
    }
  }
  await removeIfEmpty(sourceDir);
}

async function migrateLegacyAppWorkspace(workspaceId: string): Promise<void> {
  const source = join(getDataDir(), 'workspaces', workspaceId);
  const destination = getAppManagedChatWorkspaceDir(workspaceId);
  if (!(await pathExists(source))) {
    return;
  }
  if (await isIndexedUserWorkspace(workspaceId)) {
    return;
  }
  if (await pathExists(destination)) {
    // A previous launch already created the destination. Move only missing
    // legacy entries across; leave conflicting source files in place rather
    // than overwriting newer destination data.
    await mergeMissingEntries(source, destination);
    return;
  }
  await movePath(source, destination);
}

async function migrateLegacyCodeReviewChats(): Promise<void> {
  const source = getLegacyCodeReviewChatsDir();
  const destination = getCodeReviewChatsDir();
  if (!(await pathExists(source))) {
    return;
  }
  if (await pathExists(destination)) {
    await mergeMissingEntries(source, destination);
    return;
  }
  await movePath(source, destination);
}

async function nextAvailableLegacyDestination(path: string): Promise<string> {
  let candidate = `${path}.legacy-app-advisor`;
  let suffix = 2;
  while (await pathExists(candidate)) {
    candidate = `${path}.legacy-app-advisor-${String(suffix)}`;
    suffix += 1;
  }
  return candidate;
}

async function moveLegacyAppAdvisorHomeEntry(
  source: string,
  destination: string,
): Promise<void> {
  if (!(await pathExists(destination))) {
    await movePath(source, destination);
    return;
  }

  const [sourceStat, destinationStat] = await Promise.all([
    lstat(source),
    lstat(destination),
  ]);
  if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
    await mergeMissingEntries(source, destination);
    if (!(await pathExists(source))) {
      return;
    }
  }

  // Preserve both sides of a partial/previous migration without overwriting
  // either. The legacy suffix also makes the collision visible to the user.
  await movePath(source, await nextAvailableLegacyDestination(destination));
}

async function migrateLegacyAppAdvisorHome(): Promise<void> {
  const metadataRoot = getAppManagedChatWorkspaceDir(APP_ADVISOR_PROJECT_ID);
  if (!(await pathExists(metadataRoot))) {
    return;
  }

  const home = getAppAdvisorHomeDir();
  const migrationState = join(
    getDataDir(),
    APP_ADVISOR_HOME_MIGRATION_STATE_ENTRY,
  );
  const stagedHome = join(metadataRoot, APP_ADVISOR_STAGED_HOME_ENTRY);
  if (!(await pathExists(migrationState))) {
    if (!(await pathExists(stagedHome)) && (await pathExists(home))) {
      await movePath(home, stagedHome);
    }
    await mkdir(migrationState, { recursive: true });
  }

  await mkdir(home, { recursive: true });
  if (await pathExists(stagedHome)) {
    await moveLegacyAppAdvisorHomeEntry(stagedHome, join(home, 'home'));
  }

  const entries = await readdir(metadataRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (isAppAdvisorMetadataEntry(entry.name)) {
      continue;
    }
    await moveLegacyAppAdvisorHomeEntry(
      join(metadataRoot, entry.name),
      join(home, entry.name),
    );
  }
}

async function nextAvailablePipelineEditorLegacyDestination(
  path: string,
): Promise<string> {
  let candidate = `${path}.legacy-pipeline-editor`;
  let suffix = 2;
  while (await pathExists(candidate)) {
    candidate = `${path}.legacy-pipeline-editor-${String(suffix)}`;
    suffix += 1;
  }
  return candidate;
}

async function moveLegacyPipelineEditorHomeEntry(
  source: string,
  destination: string,
): Promise<void> {
  if (!(await pathExists(destination))) {
    await movePath(source, destination);
    return;
  }

  const [sourceStat, destinationStat] = await Promise.all([
    lstat(source),
    lstat(destination),
  ]);
  if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
    await mergeMissingEntries(source, destination);
    if (!(await pathExists(source))) {
      return;
    }
  }

  await movePath(
    source,
    await nextAvailablePipelineEditorLegacyDestination(destination),
  );
}

async function migrateLegacyPipelineEditorHome(): Promise<void> {
  // Older builds used the app-managed workspace root as both durable metadata
  // storage and the assistant cwd. Keep the metadata entries in place while
  // moving every working-file entry under the new writable home directory.
  const metadataRoot = getAppManagedChatWorkspaceDir(
    PIPELINE_EDITOR_PROJECT_ID,
  );
  if (!(await pathExists(metadataRoot))) {
    return;
  }

  const home = getPipelineEditorHomeDir();
  const migrationState = join(
    getDataDir(),
    PIPELINE_EDITOR_HOME_MIGRATION_STATE_ENTRY,
  );
  const stagedHome = join(metadataRoot, PIPELINE_EDITOR_STAGED_HOME_ENTRY);
  if (!(await pathExists(migrationState))) {
    if (!(await pathExists(stagedHome)) && (await pathExists(home))) {
      await movePath(home, stagedHome);
    }
    await mkdir(migrationState, { recursive: true });
  }

  await mkdir(home, { recursive: true });
  if (await pathExists(stagedHome)) {
    await moveLegacyPipelineEditorHomeEntry(stagedHome, join(home, 'home'));
  }

  const entries = await readdir(metadataRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (PIPELINE_EDITOR_METADATA_ENTRIES.has(entry.name)) {
      continue;
    }
    await moveLegacyPipelineEditorHomeEntry(
      join(metadataRoot, entry.name),
      join(home, entry.name),
    );
  }
}

export async function migrateAppManagedChatWorkspaces(): Promise<void> {
  if (!(await hasMigrationRun(APP_WORKSPACES_MIGRATION_KEY))) {
    for (const workspaceId of APP_MANAGED_CHAT_WORKSPACE_IDS) {
      await migrateLegacyAppWorkspace(workspaceId);
    }
    await markMigrationRun(APP_WORKSPACES_MIGRATION_KEY);
  }
  if (!(await hasMigrationRun(APP_ADVISOR_HOME_MIGRATION_KEY))) {
    await migrateLegacyAppAdvisorHome();
    await markMigrationRun(APP_ADVISOR_HOME_MIGRATION_KEY);
  }
  await rm(join(getDataDir(), APP_ADVISOR_HOME_MIGRATION_STATE_ENTRY), {
    recursive: true,
    force: true,
  });
  if (!(await hasMigrationRun(CODE_REVIEW_CHATS_APP_WORKSPACE_MIGRATION_KEY))) {
    await migrateLegacyCodeReviewChats();
    await markMigrationRun(CODE_REVIEW_CHATS_APP_WORKSPACE_MIGRATION_KEY);
  }
  // The pipeline editor became app-managed after the original aggregate
  // migration shipped. Give it a distinct marker so installations that
  // already recorded `app_workspaces` still move any legacy metadata.
  if (!(await hasMigrationRun(PIPELINE_EDITOR_APP_WORKSPACE_MIGRATION_KEY))) {
    await migrateLegacyAppWorkspace(PIPELINE_EDITOR_PROJECT_ID);
    await markMigrationRun(PIPELINE_EDITOR_APP_WORKSPACE_MIGRATION_KEY);
  }
  if (!(await hasMigrationRun(PIPELINE_EDITOR_HOME_MIGRATION_KEY))) {
    await migrateLegacyPipelineEditorHome();
    await markMigrationRun(PIPELINE_EDITOR_HOME_MIGRATION_KEY);
  }
  await rm(join(getDataDir(), PIPELINE_EDITOR_HOME_MIGRATION_STATE_ENTRY), {
    recursive: true,
    force: true,
  });
}
