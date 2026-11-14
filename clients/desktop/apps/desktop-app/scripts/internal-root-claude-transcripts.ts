/** Offline only: never import this copier into startup or chat execution. */
import { constants, createReadStream } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { hostOperatingSystem } from '../../../packages/core-platform/src/host-platform';
import type {
  InternalRootIdentity,
  InternalRootMigrationWorker,
} from '../../../packages/core-runtime/src/node/internal-root-migration';
import { internalRootMigrationProgress } from '../../../packages/desktop-shared/src/node/internal-root-migration/progress';
import {
  claudeProjectDirCandidates,
  normalizeClaudeProjectCwd,
} from '../src/main/lib/claude-project-paths';

export interface ClaudeTranscriptCopyReport {
  configDirs: string[];
  copied: number;
  skippedExisting: number;
  skippedMissingDestination: number;
  skippedOutsideSource: number;
  skippedNoCwd: number;
  errors: { path: string; message: string }[];
}

export async function copyCompletedInternalRootClaudeTranscripts(
  worker: Pick<
    InternalRootMigrationWorker,
    'coordinate' | 'readJournal' | 'proveCold'
  >,
  identity: InternalRootIdentity,
  additionalConfigDirs: readonly string[],
): Promise<ClaudeTranscriptCopyReport> {
  const release = await worker.coordinate(identity);
  try {
    const completed = await worker.readJournal(identity);
    if (completed?.phase !== 'complete')
      throw new Error(
        'Transcript copying requires a completed migration journal. Retain both roots.',
      );
    const configDirs = internalRootClaudeConfigDirs(additionalConfigDirs);
    await worker.proveCold(identity, [
      ...completed.externalFiles,
      ...configDirs.map((directory) => join(directory, 'projects')),
    ]);
    return await copyInternalRootClaudeTranscripts({ ...identity, configDirs });
  } finally {
    await release();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function missing(error: unknown): boolean {
  return hasCode(error, 'ENOENT');
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function realpathWithMissingSuffix(value: string): Promise<string> {
  const path = resolve(value);
  let ancestor = path;
  while (!(await exists(ancestor))) {
    const parent = dirname(ancestor);
    if (parent === ancestor)
      throw new Error('No existing destination ancestor');
    ancestor = parent;
  }
  return resolve(await realpath(ancestor), relative(ancestor, path));
}

async function destinationDirectoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (missing(error) || hasCode(error, 'ENOTDIR')) return false;
    throw error;
  }
}

function relocate(
  path: string,
  source: string,
  destination: string,
): string | undefined {
  const platform = hostOperatingSystem();
  const suffix = relative(
    normalizeClaudeProjectCwd(resolve(source), platform),
    normalizeClaudeProjectCwd(resolve(path), platform),
  );
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
    return undefined;
  return resolve(destination, suffix);
}

async function recordedCwd(transcript: string): Promise<string | undefined> {
  const input = createReadStream(transcript, { encoding: 'utf8' });
  input.on('data', () =>
    internalRootMigrationProgress('read Claude transcript chunk'),
  );
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        typeof value === 'object' &&
        value !== null &&
        'cwd' in value &&
        typeof value.cwd === 'string'
      )
        return value.cwd;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return undefined;
}

async function assertOutsideSource(
  path: string,
  source: string,
): Promise<void> {
  const physicalSource = await realpathWithMissingSuffix(source);
  if (
    relocate(
      await realpathWithMissingSuffix(path),
      physicalSource,
      physicalSource,
    ) !== undefined
  )
    throw new Error('Destination resolves inside the retained source');
}

async function plainDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  if (!(await lstat(path)).isDirectory())
    throw new Error('Expected a directory, not a link or file');
}

/** Stage a complete independent inode; link publishes atomically without replacement. */
async function publishFile(
  source: string,
  destination: string,
  staging: string,
): Promise<boolean> {
  if (await exists(destination)) return false;
  const temporary = join(staging, 'file');
  await copyFile(
    source,
    temporary,
    constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
  );
  internalRootMigrationProgress('copied Claude transcript file');
  try {
    const metadata = await stat(source);
    await utimes(temporary, metadata.atime, metadata.mtime);
    try {
      await link(temporary, destination);
    } catch (error) {
      if (hasCode(error, 'EEXIST')) return false;
      throw error;
    }
    return true;
  } finally {
    await rm(temporary);
  }
}

async function copySidecar(
  source: string,
  destination: string,
  staging: string,
): Promise<void> {
  const metadata = await lstat(source);
  internalRootMigrationProgress('inspected Claude sidecar entry');
  if (metadata.isDirectory()) {
    await plainDirectory(destination);
    for (const entry of await readdir(source))
      await copySidecar(join(source, entry), join(destination, entry), staging);
  } else if (metadata.isFile()) {
    await publishFile(source, destination, staging);
  } else {
    throw new Error(
      'Sidecar links and special files are not copied; retain the original',
    );
  }
}

interface TranscriptCopyContext {
  source: string;
  destination: string;
  realSource: string;
  projects: string;
  targetProjects: string;
}

type CopyOutcome =
  | 'copied'
  | 'skippedExisting'
  | 'skippedNoCwd'
  | 'skippedOutsideSource'
  | 'skippedMissingDestination';

async function publishSession(
  projectPath: string,
  newProject: string,
  fileName: string,
  sidecarName: string,
): Promise<CopyOutcome> {
  const staging = await mkdtemp(join(newProject, '.transcript-copy-'));
  try {
    const sidecar = join(projectPath, sidecarName);
    if (await exists(sidecar)) {
      if (!(await lstat(sidecar)).isDirectory())
        throw new Error('Expected a sidecar directory, not a link or file');
      await copySidecar(sidecar, join(newProject, sidecarName), staging);
    }
    // Transcript is published last: a retry can fill an interrupted sidecar.
    const published = await publishFile(
      join(projectPath, fileName),
      join(newProject, fileName),
      staging,
    );
    return published ? 'copied' : 'skippedExisting';
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function copyTranscript(
  context: TranscriptCopyContext,
  projectName: string,
  fileName: string,
): Promise<CopyOutcome | undefined> {
  const { source, destination, realSource, projects, targetProjects } = context;
  const projectPath = join(projects, projectName);
  const sidecarName = fileName.slice(0, -'.jsonl'.length);
  if (sidecarName === '.' || sidecarName === '..')
    throw new Error(
      'Transcript session filename must not resolve to a parent or project directory',
    );
  const cwd = await recordedCwd(join(projectPath, fileName));
  if (!cwd || !isAbsolute(cwd)) return 'skippedNoCwd';
  const mapped =
    relocate(cwd, source, destination) ??
    relocate(await realpathWithMissingSuffix(cwd), realSource, destination);
  if (!mapped) return 'skippedOutsideSource';
  if (!(await destinationDirectoryExists(mapped)))
    return 'skippedMissingDestination';
  const candidates = await claudeProjectDirCandidates(mapped);
  const slug = candidates[0];
  if (!slug) throw new Error('No Claude project slug for the destination cwd');
  if (projects === targetProjects && candidates.includes(projectName))
    return undefined;
  for (const candidate of candidates) {
    try {
      if (await exists(join(targetProjects, candidate, fileName)))
        return 'skippedExisting';
    } catch (error) {
      // An untruncated legacy slug may exceed this filesystem's name limit.
      if (!hasCode(error, 'ENAMETOOLONG')) throw error;
    }
  }
  await assertOutsideSource(targetProjects, realSource);
  await plainDirectory(targetProjects);
  const newProject = join(targetProjects, slug);
  await plainDirectory(newProject);
  await assertOutsideSource(newProject, realSource);
  return publishSession(projectPath, newProject, fileName, sidecarName);
}

function recordError(
  report: ClaudeTranscriptCopyReport,
  path: string,
  error: unknown,
): void {
  report.errors.push({
    path,
    message:
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof error.message === 'string'
        ? error.message
        : 'Unknown copy failure',
  });
}

async function copyProject(
  context: TranscriptCopyContext,
  projectName: string,
  report: ClaudeTranscriptCopyReport,
): Promise<void> {
  const projectPath = join(context.projects, projectName);
  try {
    for (const entry of await readdir(projectPath, { withFileTypes: true })) {
      internalRootMigrationProgress('inspected Claude project entry');
      if (
        !entry.isFile() ||
        entry.name.length <= '.jsonl'.length ||
        !entry.name.endsWith('.jsonl')
      )
        continue;
      try {
        const outcome = await copyTranscript(context, projectName, entry.name);
        if (outcome) report[outcome]++;
      } catch (error) {
        recordError(report, join(projectPath, entry.name), error);
      } finally {
        internalRootMigrationProgress('inspected Claude transcript');
      }
    }
  } catch (error) {
    recordError(report, projectPath, error);
  }
}

export async function copyInternalRootClaudeTranscripts(options: {
  source: string;
  destination: string;
  configDirs: readonly string[];
}): Promise<ClaudeTranscriptCopyReport> {
  const source = resolve(options.source);
  const destination = resolve(options.destination);
  const realSource = await realpathWithMissingSuffix(source);
  if (
    source === destination ||
    relocate(destination, source, destination) !== undefined ||
    relocate(source, destination, source) !== undefined
  )
    throw new Error('Migration roots must be disjoint');
  const configDirs = [
    ...new Set(options.configDirs.map((directory) => resolve(directory))),
  ];
  const report: ClaudeTranscriptCopyReport = {
    configDirs,
    copied: 0,
    skippedExisting: 0,
    skippedMissingDestination: 0,
    skippedOutsideSource: 0,
    skippedNoCwd: 0,
    errors: [],
  };
  internalRootMigrationProgress('resolved Claude transcript roots');
  for (const configDir of configDirs) {
    const projects = join(configDir, 'projects');
    const targetProjects = projects;
    try {
      const relocatedConfigDir =
        relocate(configDir, source, destination) ??
        relocate(
          await realpathWithMissingSuffix(configDir),
          realSource,
          destination,
        );
      if (relocatedConfigDir !== undefined)
        throw new Error(
          `Couldn't copy transcripts into a config folder inside the retained source; config-directory overrides are not rewritten. Retain both folders, point shell, workspace agent and terminal overrides at ${JSON.stringify(relocatedConfigDir)}, and rerun with --claude-config-dir=${JSON.stringify(relocatedConfigDir)}.`,
        );
      if (!(await exists(projects))) continue;
      // Snapshot project membership before creating new slugs; never scan sidecars.
      const projectEntries = await readdir(projects, { withFileTypes: true });
      for (const project of projectEntries) {
        internalRootMigrationProgress('inspected Claude project directory');
        if (project.isDirectory())
          await copyProject(
            { source, destination, realSource, projects, targetProjects },
            project.name,
            report,
          );
      }
    } catch (error) {
      recordError(report, projects, error);
    } finally {
      internalRootMigrationProgress('inspected Claude config directory');
    }
  }
  return report;
}

export function internalRootClaudeConfigDirs(
  additional: readonly string[],
): string[] {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (configured !== undefined && !isAbsolute(configured))
    throw new Error(
      'Relative CLAUDE_CONFIG_DIR is ambiguous offline. Unset it and pass each resolved chat config folder with --claude-config-dir=<absolute-directory>.',
    );
  return [
    ...new Set([
      join(homedir(), '.claude'),
      ...(configured !== undefined ? [configured] : []),
      ...additional,
    ]),
  ];
}
