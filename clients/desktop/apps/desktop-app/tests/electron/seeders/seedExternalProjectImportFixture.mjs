import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Seeds a Claude store for the bulk project import flow (CAN-2439,
 * CAN-3076) under the harness's isolated `CLAUDE_CONFIG_DIR`
 * (`<userDataDir>/provider-state/claude`): a `.claude.json` project registry
 * plus one transcript per project, exactly the records the adapter reads.
 *
 * Three kinds of source are seeded:
 *
 * - a git root (`can2439-git-app`) with one chat, which imports as a Code
 *   project;
 * - a plain folder (`can2439-plain-notes`) with one chat, which imports as
 *   a Cowork project;
 * - `scratchSessions`: Claude Desktop Cowork sessions run without a chosen
 *   folder. Claude Desktop runs those in a per-session `outputs` directory
 *   under its own data root, so their only recognizable name is the session
 *   title the desktop record carries (CAN-3076). The desktop root is a
 *   fixture directory the spec must hand to the app through
 *   `CANOPY_CLAUDE_DESKTOP_DATA_DIR` (see `env` in the result).
 *
 * Every fixture folder lives under the OS temp dir, which production
 * discovery excludes on purpose; the E2E build lifts that rule through
 * `CANOPY_E2E_ALLOW_TEMP_PROJECT_IMPORT` (also in `env`). The app's own
 * `userDataDir` is cleaned by `closeCanopy`; the fixture folders are not,
 * so call the returned `cleanup()` in the spec's `finally`.
 */

export const IMPORT_FIXTURE_GIT_PROJECT = 'can2439-git-app';
export const IMPORT_FIXTURE_FOLDER_PROJECT = 'can2439-plain-notes';
export const IMPORT_FIXTURE_GIT_SESSION_ID =
  '11111111-2222-4333-8444-555555555555';
export const IMPORT_FIXTURE_FOLDER_SESSION_ID =
  '66666666-7777-4888-8999-000000000000';

export function claudeProjectSlug(dir) {
  return path.resolve(dir).replace(/[^A-Za-z0-9-]/g, '-');
}

/** Candidate id the app derives for a folder: `ext-<sha256(realpath)[:24]>`. */
export function externalProjectCandidateIdFor(dir) {
  return `ext-${createHash('sha256')
    .update(realpathSync(dir))
    .digest('hex')
    .slice(0, 24)}`;
}

function transcript(cwd, sessionId, title, prompt, timestamp) {
  const records = [
    {
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      uuid: `${sessionId}-u1`,
      timestamp,
      cwd,
      sessionId,
      version: '2.1.235',
      entrypoint: 'cli',
      userType: 'external',
    },
    // A scratch session carries no provider title record: its title must
    // come from the Claude Desktop session record instead.
    ...(title ? [{ type: 'ai-title', aiTitle: title, sessionId }] : []),
    {
      parentUuid: `${sessionId}-u1`,
      isSidechain: false,
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Working on: ${prompt}` }],
      },
      uuid: `${sessionId}-a1`,
      timestamp: new Date(Date.parse(timestamp) + 5_000).toISOString(),
      cwd,
      sessionId,
    },
  ];
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

/**
 * Adds one Claude Code chat to a seeded store, e.g. between two scans.
 * `title` is the transcript's `ai-title`; pass null for none.
 */
export function writeImportFixtureTranscript(
  claudeDir,
  cwd,
  sessionId,
  title,
  prompt,
  timestamp,
) {
  writeTranscript(claudeDir, cwd, sessionId, title, prompt, timestamp);
}

function writeTranscript(claudeDir, cwd, sessionId, title, prompt, timestamp) {
  const projectDir = path.join(claudeDir, 'projects', claudeProjectSlug(cwd));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    transcript(cwd, sessionId, title, prompt, timestamp),
  );
}

/**
 * @param {object} options
 * @param {string} [options.userDataDir]
 * @param {string} [options.claudeDir] The Claude store to seed; defaults to
 *   `<userDataDir>/provider-state/claude`. Pass the launch's own
 *   `CLAUDE_CONFIG_DIR` when it is elsewhere.
 * @param {string} [options.fixturesParent] Parent of the generated fixture
 *   directory; defaults to the OS temp directory.
 * @param {{ gitApp?: string; notes?: string }} [options.activityTimestamps]
 * @param {Array<{ name: string; lastActivityAt: string; rules?: string }>} [options.extraGitProjects]
 * @param {Array<{ id: string; title: string; prompt: string; lastActivityAt: string }>} [options.scratchSessions]
 *   Folder-less Cowork sessions, newest first as listed.
 */
export function seedExternalProjectImportFixture({
  userDataDir,
  claudeDir: claudeDirOption,
  fixturesParent = os.tmpdir(),
  scratchSessions = [],
  activityTimestamps = {},
  extraGitProjects = [],
}) {
  if (!claudeDirOption && !userDataDir) {
    throw new Error('Pass userDataDir or claudeDir.');
  }
  const claudeDir =
    claudeDirOption ?? path.join(userDataDir, 'provider-state', 'claude');
  const fixturesRoot = mkdtempSync(
    path.join(fixturesParent, 'can2439-fixtures-'),
  );

  const gitApp = path.join(fixturesRoot, IMPORT_FIXTURE_GIT_PROJECT);
  mkdirSync(gitApp, { recursive: true });
  writeFileSync(path.join(gitApp, 'README.md'), '# Git app\n');
  const git = (args) =>
    execFileSync('git', args, { cwd: gitApp, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main']);
  git(['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', 'add', '.']);
  git([
    '-c',
    'user.name=E2E',
    '-c',
    'user.email=e2e@example.com',
    'commit',
    '-q',
    '-m',
    'init',
  ]);

  const notes = path.join(fixturesRoot, IMPORT_FIXTURE_FOLDER_PROJECT);
  mkdirSync(notes, { recursive: true });
  writeFileSync(path.join(notes, 'notes.md'), '# Notes\n');

  // Opt-in committed repositories let import flows distinguish recency from
  // a rules offer without changing the original fixture's two projects.
  const extraProjects = extraGitProjects.map((project, index) => {
    const dir = path.join(fixturesRoot, project.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'README.md'), `# ${project.name}\n`);
    if (project.rules)
      writeFileSync(path.join(dir, '.cursorrules'), project.rules);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=E2E',
        '-c',
        'user.email=e2e@example.com',
        'commit',
        '-q',
        '-m',
        'init',
      ],
      { cwd: dir },
    );
    return {
      ...project,
      dir,
      sessionId: `77777777-2222-4333-8444-${String(index + 1).padStart(12, '0')}`,
    };
  });

  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    path.join(claudeDir, '.claude.json'),
    JSON.stringify({
      projects: {
        [gitApp]: { allowedTools: [] },
        [notes]: { allowedTools: [] },
        ...Object.fromEntries(
          extraProjects.map(({ dir }) => [dir, { allowedTools: [] }]),
        ),
      },
    }),
  );
  writeTranscript(
    claudeDir,
    gitApp,
    IMPORT_FIXTURE_GIT_SESSION_ID,
    'Login bug',
    'Fix the login bug',
    activityTimestamps.gitApp ?? '2026-09-01T10:00:00.000Z',
  );
  writeTranscript(
    claudeDir,
    notes,
    IMPORT_FIXTURE_FOLDER_SESSION_ID,
    'Meeting notes',
    'Summarize my meeting notes',
    activityTimestamps.notes ?? '2026-09-01T10:00:00.000Z',
  );
  for (const project of extraProjects) {
    writeTranscript(
      claudeDir,
      project.dir,
      project.sessionId,
      `${project.name} task`,
      `Work in ${project.name}`,
      project.lastActivityAt,
    );
  }

  // Claude Desktop's data root: `local-agent-mode-sessions/<account>/<org>/`
  // holds one `local_<id>.json` record per Cowork session and, for a
  // folder-less session, its `local_<id>/outputs` working directory.
  const desktopDataDir = path.join(fixturesRoot, 'claude-desktop');
  const coworkSessionsDir = path.join(
    desktopDataDir,
    'local-agent-mode-sessions',
    'acct',
    'org',
  );
  mkdirSync(coworkSessionsDir, { recursive: true });
  const scratch = scratchSessions.map((session, index) => {
    const recordId = `local_${session.id}`;
    const cwd = path.join(coworkSessionsDir, recordId, 'outputs');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(path.join(cwd, 'result.md'), `# ${session.title}\n`);
    const lastActivityMs = Date.parse(session.lastActivityAt);
    writeFileSync(
      path.join(coworkSessionsDir, `${recordId}.json`),
      JSON.stringify({
        sessionId: recordId,
        cliSessionId: session.id,
        cwd,
        userSelectedFolders: [],
        createdAt: lastActivityMs - 60_000,
        lastActivityAt: lastActivityMs,
        isArchived: false,
        title: session.title,
        systemPrompt: 'never surfaced',
      }),
    );
    writeTranscript(
      claudeDir,
      cwd,
      session.id,
      null,
      session.prompt,
      new Date(lastActivityMs - 60_000 - index).toISOString(),
    );
    return { cwd, sessionId: session.id, title: session.title };
  });

  return {
    fixturesRoot,
    gitApp,
    notes,
    claudeDir,
    desktopDataDir,
    scratch,
    extraProjects,
    env: {
      CANOPY_E2E_ALLOW_TEMP_PROJECT_IMPORT: '1',
      CANOPY_CLAUDE_DESKTOP_DATA_DIR: desktopDataDir,
    },
    cleanup: () => rmSync(fixturesRoot, { recursive: true, force: true }),
  };
}
