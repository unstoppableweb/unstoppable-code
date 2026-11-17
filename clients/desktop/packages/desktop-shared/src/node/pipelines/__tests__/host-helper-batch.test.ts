// CAN-6702 golden: git-commit-push and github-create-pr on a model whose
// harness has a host runner run in three phases (prepare, host turns, apply),
// and nothing is committed, pushed or created unless every turn succeeded and
// the repository is still what the turns saw. The real executor runs freshly
// built bundled actions against local fixtures only: `origin` is a local bare
// repository behind a GitHub-style URL, `gh` is a fake on PATH that records
// its calls, the runner is a fake, and model base URLs point at a closed
// local port, so nothing reaches a real model, remote or GitHub.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { executePipeline } from '@canopy/execution-engine/node/pipelines/executor/index';
import { loadExecutionState } from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import type {
  AntigravityPromptRunnerRequest,
  CodexPromptRunnerResult,
  ExecutionRuntime,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import { toAntigravityModelId } from '@canopy/execution-engine/lib/antigravity-models';
import { getExecutionHarnessForModel } from '@canopy/execution-engine/model-catalog';

jest.setTimeout(120_000);

const ROOT = resolve(__dirname, '../../../../../..');
const BRAND = process.env.CANOPY_BRAND ?? 'canopy';
const BUILT_ACTIONS = join(
  ROOT,
  '.cache',
  'brand',
  BRAND,
  'resources',
  'actions',
);
const MODEL = toAntigravityModelId('gemini-3.8-flash');

type Reply = { structured: unknown } | { fail: string };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

interface FixtureControls {
  reply: Reply;
  duringTurn?: () => void;
  currentHandle?: { cancel(): void };
}
interface Fixture {
  root: string;
  work: string;
  bare: string;
  turns: AntigravityPromptRunnerRequest[];
  controls: FixtureControls;
  run(
    uses: string,
    input: string,
    id: string,
    after?: string[],
  ): Promise<ExecutionState>;
  ghCalls(): string[][];
  close(): void;
}
function createFixture(kind: 'commit' | 'pr'): Fixture {
  const turns: AntigravityPromptRunnerRequest[] = [];
  const controls: FixtureControls = {
    reply: { fail: 'No fixture reply supplied' },
  };

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-helper-batch-')));
  mkdirSync(join(root, 'bin'));
  installFakeGh(join(root, 'bin'));
  const work = join(root, 'work');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.email', 'fixture@example.invalid');
  git(work, 'config', 'user.name', 'Fixture');
  git(work, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(work, 'a.txt'), 'one\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');
  // The bare repository stands in for GitHub through `insteadOf`, so its
  // path names the same `fixture/origin` the helper checks gh against.
  mkdirSync(join(root, 'fixture'));
  const bare = join(root, 'fixture', 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const url = 'https://github.com/fixture/origin.git';
  git(work, 'config', `url.${bare}.insteadOf`, url);
  git(work, 'remote', 'add', 'origin', url);
  git(work, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feature');

  function ghCalls(): string[][] {
    const log = join(root, 'gh-calls.log');
    if (!existsSync(log)) return [];
    return readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line): string[] => {
        const parsed: unknown = JSON.parse(line);
        return Array.isArray(parsed) ? parsed.map(String) : [];
      });
  }

  function installFakeGh(binDir: string): void {
    const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(root, 'gh-calls.log'))}, JSON.stringify(args) + '\\n');
const statePath = ${JSON.stringify(join(root, 'gh-state.json'))};
const pr = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
if (args[0] === 'repo' && args[1] === 'view') {
  const url = require('child_process').execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
  const parts = url.split('/');
  const name = (parts.pop() || '').replace('.git', '');
  const owner = parts.pop() || '';
  process.stdout.write(JSON.stringify(args.includes('nameWithOwner') ? { nameWithOwner: owner + '/' + name } : { defaultBranchRef: { name: 'main' } }));
} else if (args[0] === 'pr' && args[1] === 'list') {
  const state = args[args.indexOf('--state') + 1];
  process.stdout.write(JSON.stringify(pr && state === 'open' ? [pr] : []));
} else if (args[0] === 'pr' && args[1] === 'create') {
  const value = (flag) => args[args.indexOf(flag) + 1];
  fs.writeFileSync(statePath, JSON.stringify({ number: 7, title: value('--title'), url: 'https://example.invalid/pr/7', baseRefName: value('--base'), headRefName: value('--head'), isDraft: false }));
  process.stdout.write('https://example.invalid/pr/7\\n');
} else {
  process.stderr.write('fake gh: unsupported ' + args.join(' '));
  process.exit(1);
}
`;
    writeFileSync(join(binDir, 'gh'), script);
    chmodSync(join(binDir, 'gh'), 0o755);
  }

  function answer(
    request: AntigravityPromptRunnerRequest,
  ): Promise<CodexPromptRunnerResult> {
    turns.push(request);
    controls.duringTurn?.();
    const reply = controls.reply;
    const line = JSON.stringify({ type: 'result', provider: 'antigravity' });
    request.onTranscriptLine?.(line);
    if ('fail' in reply)
      return Promise.resolve({
        status: 'failure' as const,
        transcript: `${line}\n`,
        failure: {
          version: 1 as const,
          provider: 'antigravity',
          agent_harness: 'antigravity',
          had_agent_activity: false,
          message: reply.fail,
        },
      });
    return Promise.resolve({
      status: 'success' as const,
      sessionId: 'host-turn',
      rawText: JSON.stringify(reply.structured),
      transcript: `${line}\n`,
      usage: {},
      structured: reply.structured,
    });
  }

  function runtime(): ExecutionRuntime {
    return {
      isModelBlockedByOrgPolicy: () => Promise.resolve(false),
      isOrgModelPolicyActive: () => Promise.resolve(false),
      executionsDir: join(root, 'executions'),
      tempRootDir: join(root, 'tmp'),
      bundledActionsDir: BUILT_ACTIONS,
      getProjectActionsDir: (repoPath) => join(repoPath, '.canopy', 'actions'),
      getProjectPipelinesDir: (repoPath) =>
        join(repoPath, '.canopy', 'pipelines'),
      processEnvironment: {
        PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
        ANTHROPIC_API_KEY: 'fixture-no-key',
        OPENAI_BASE_URL: 'http://127.0.0.1:9',
        OPENAI_API_KEY: 'fixture-no-key',
      },
      resolvePipelineTarget: () =>
        Promise.resolve({
          cwd: work,
          scope: 'worktree' as const,
          target: {
            scope: 'worktree' as const,
            workspace_id: 'workspace',
            worktree_id: 'worktree',
            path: work,
            created: false,
          },
          projectId: 'workspace',
          worktreeId: 'worktree',
          repoPath: work,
        }),
      antigravityPromptRunner: { runAntigravityPrompt: answer },
    };
  }

  async function run(
    uses: string,
    input: string,
    id: string,
    after: string[] = [],
  ): Promise<ExecutionState> {
    const yaml = [
      'pipeline:',
      '  name: Helpers',
      '  on: dispatch',
      '  jobs:',
      '    work:',
      '      steps:',
      '        - id: helper',
      `          uses: ${uses}`,
      '          with:',
      `            ${input}: "${MODEL}"`,
      ...after,
      '',
    ].join('\n');
    const handle = await executePipeline(parsePipelineText(yaml), {
      cwd: work,
      repoPath: work,
      scope: 'worktree',
      projectId: 'workspace',
      worktreeId: 'worktree',
      runtime: runtime(),
      executionId: id,
      pipelineId: 'helpers',
      initiationSource: 'user',
    });
    controls.currentHandle = handle;
    try {
      return await handle.waitForCompletion();
    } catch {
      const state = await loadExecutionState(id, join(root, 'executions'));
      if (!state) throw new Error('The execution left no state.');
      return state;
    }
  }

  if (kind === 'commit') git(work, 'push', '-q', '-u', 'origin', 'feature');
  writeFileSync(join(work, 'a.txt'), 'two\n');
  if (kind === 'pr') git(work, 'commit', '-q', '-am', 'change a');
  return {
    root,
    work,
    bare,
    turns,
    controls,
    run,
    ghCalls,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
function scenario(
  name: string,
  kind: 'commit' | 'pr',
  body: (fixture: Fixture) => Promise<void>,
): void {
  it.concurrent(name, async () => {
    const fixture = createFixture(kind);
    try {
      await body(fixture);
    } finally {
      fixture.close();
    }
  });
}

function helperStep(
  state: ExecutionState,
): ExecutionState['jobs'][string]['steps'][string] | undefined {
  return state.jobs.work?.steps.helper;
}

function repoResults(state: ExecutionState): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(
    helperStep(state)?.outputs?.results_json ?? '[]',
  );
  return Array.isArray(parsed)
    ? parsed.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' && entry !== null,
      )
    : [];
}

beforeAll(() => {
  const built = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts/build-builtin-actions.mjs')],
    { cwd: ROOT, stdio: 'ignore' },
  );
  if (built.status !== 0) throw new Error('The builtin actions did not build.');
});

it('the fixture model runs on a host runner, never inline', () => {
  expect(getExecutionHarnessForModel(MODEL)).toBe('antigravity');
});

describe('git-commit-push', () => {
  scenario(
    'commits and pushes already-staged content after one read-only turn',
    'commit',
    async (fixture) => {
      git(fixture.work, 'add', 'a.txt');
      fixture.controls.reply = {
        structured: { message: 'feat: change a to two' },
      };
      const state = await fixture.run(
        'builtin/git-commit-push',
        'commit_model',
        'commit',
      );
      expect(helperStep(state)?.status).toBe('success');
      expect(fixture.turns).toHaveLength(1);
      expect(fixture.turns[0]?.permissionPreset).toBe('read_only');
      expect(repoResults(state)[0]).toMatchObject({
        status: 'committed_and_pushed',
        pushed: true,
        error: '',
      });
      expect(git(fixture.bare, 'log', '-1', '--format=%s', 'feature')).toBe(
        'feat: change a to two',
      );
      expect(git(fixture.work, 'status', '--porcelain')).toBe('');
    },
  );

  scenario(
    'a failed turn commits and pushes nothing',
    'commit',
    async (fixture) => {
      const before = git(fixture.bare, 'rev-parse', 'feature');
      fixture.controls.reply = { fail: 'model unavailable' };
      const state = await fixture.run(
        'builtin/git-commit-push',
        'commit_model',
        'failed',
      );
      expect(helperStep(state)?.status).toBe('failure');
      expect(git(fixture.work, 'log', '-1', '--format=%s')).toBe('init');
      expect(git(fixture.bare, 'rev-parse', 'feature')).toBe(before);
    },
  );

  scenario(
    'a cancel during the turn discards its late result and applies nothing',
    'commit',
    async (fixture) => {
      const before = git(fixture.bare, 'rev-parse', 'feature');
      fixture.controls.reply = { structured: { message: 'feat: never' } };
      fixture.controls.duringTurn = (): void =>
        fixture.controls.currentHandle?.cancel();
      const state = await fixture.run(
        'builtin/git-commit-push',
        'commit_model',
        'cancelled',
      );
      expect(helperStep(state)?.status).toBe('cancelled');
      expect(git(fixture.work, 'log', '-1', '--format=%s')).toBe('init');
      expect(git(fixture.bare, 'rev-parse', 'feature')).toBe(before);
    },
  );

  scenario(
    'a repository changed during the turn is refused with nothing committed or pushed',
    'commit',
    async (fixture) => {
      const before = git(fixture.bare, 'rev-parse', 'feature');
      fixture.controls.reply = { structured: { message: 'feat: stale' } };
      fixture.controls.duringTurn = (): void =>
        writeFileSync(join(fixture.work, 'a.txt'), 'changed meanwhile\n');
      const state = await fixture.run(
        'builtin/git-commit-push',
        'commit_model',
        'changed',
      );
      expect(repoResults(state)[0]).toMatchObject({ status: 'failed' });
      expect(git(fixture.work, 'log', '-1', '--format=%s')).toBe('init');
      expect(git(fixture.bare, 'rev-parse', 'feature')).toBe(before);
    },
  );

  scenario(
    'reports the local commit and does not push when the real index is locked',
    'commit',
    async (fixture) => {
      const before = git(fixture.bare, 'rev-parse', 'feature');
      git(fixture.work, 'add', 'a.txt');
      writeFileSync(
        join(fixture.work, '.git', 'hooks', 'pre-commit'),
        '#!/bin/sh\ntouch .git/index.lock\n',
      );
      chmodSync(join(fixture.work, '.git', 'hooks', 'pre-commit'), 0o755);
      fixture.controls.reply = { structured: { message: 'feat: local only' } };
      fixture.controls.duringTurn = (): void => {
        if (fixture.turns.length > 1)
          fixture.controls.reply = {
            structured: { title: 'Should not create', body: 'Blocked' },
          };
      };
      const state = await fixture.run(
        'builtin/git-commit-push',
        'commit_model',
        'index-lock',
        [
          '        - id: pr',
          '          uses: builtin/github-create-pr',
          '          with:',
          `            pr_model: "${MODEL}"`,
        ],
      );
      expect(helperStep(state)?.status).toBe('failure');
      expect(state.jobs.work?.status).toBe('failure');
      expect(state.jobs.work?.steps.pr?.status).toBe('pending');
      expect(fixture.turns).toHaveLength(1);
      expect(
        fixture.ghCalls().filter((call) => call[1] === 'create'),
      ).toHaveLength(0);
      const commit = git(fixture.work, 'rev-parse', 'HEAD');
      expect(commit).not.toBe(before);
      expect(repoResults(state)[0]).toMatchObject({
        status: 'failed',
        pushed: false,
        commitHash: commit,
        failurePhase: 'commit',
      });
      expect(git(fixture.bare, 'rev-parse', 'feature')).toBe(before);
    },
  );

  scenario(
    'preserves partial staging and stops before push or PR when the commit needs index reconciliation',
    'commit',
    async (fixture) => {
      const before = git(fixture.bare, 'rev-parse', 'feature');
      writeFileSync(join(fixture.work, 'a.txt'), 'staged portion\n');
      git(fixture.work, 'add', 'a.txt');
      writeFileSync(join(fixture.work, 'a.txt'), 'working content\n');
      const indexBefore = readFileSync(join(fixture.work, '.git', 'index'));
      fixture.controls.reply = { structured: { message: 'feat: local only' } };
      const state = await fixture.run(
        'builtin/git-commit-push',
        'commit_model',
        'preserve-index',
        [
          '        - id: pr',
          '          uses: builtin/github-create-pr',
          '          with:',
          `            pr_model: "${MODEL}"`,
        ],
      );
      expect(helperStep(state)?.status).toBe('failure');
      expect(state.jobs.work?.steps.pr?.status).toBe('pending');
      expect(fixture.turns).toHaveLength(1);
      expect(
        fixture.ghCalls().filter((call) => call[1] === 'create'),
      ).toHaveLength(0);
      const commit = git(fixture.work, 'rev-parse', 'HEAD');
      expect(commit).not.toBe(before);
      expect(repoResults(state)[0]).toMatchObject({
        status: 'failed',
        pushed: false,
        commitHash: commit,
        failurePhase: 'commit',
      });
      expect(readFileSync(join(fixture.work, '.git', 'index'))).toEqual(
        indexBefore,
      );
      expect(git(fixture.work, 'show', ':a.txt')).toBe('staged portion');
      expect(git(fixture.work, 'show', `${commit}:a.txt`)).toBe(
        'working content',
      );
      expect(git(fixture.bare, 'rev-parse', 'feature')).toBe(before);
    },
  );

  scenario(
    "a failing pre-commit hook leaves the user's index untouched",
    'commit',
    async (fixture) => {
      writeFileSync(join(fixture.work, 'b.txt'), 'staged before\n');
      git(fixture.work, 'add', 'b.txt');
      const indexBefore = readFileSync(join(fixture.work, '.git', 'index'));
      writeFileSync(
        join(fixture.work, '.git', 'hooks', 'pre-commit'),
        '#!/bin/sh\nexit 1\n',
      );
      chmodSync(join(fixture.work, '.git', 'hooks', 'pre-commit'), 0o755);
      fixture.controls.reply = { structured: { message: 'feat: blocked' } };
      const state = await fixture.run(
        'builtin/git-commit-push',
        'commit_model',
        'hook',
      );
      expect(repoResults(state)[0]).toMatchObject({
        status: 'failed',
        failurePhase: 'commit',
      });
      expect(
        readFileSync(join(fixture.work, '.git', 'index')).equals(indexBefore),
      ).toBe(true);
      expect(git(fixture.work, 'log', '-1', '--format=%s')).toBe('init');
    },
  );
});

describe('github-create-pr', () => {
  scenario(
    'prepares without pushing or creating, then pushes and creates on the checked repository',
    'pr',
    async (fixture) => {
      let pushedDuringTurn = '';
      let createsDuringTurn = -1;
      fixture.controls.duringTurn = (): void => {
        pushedDuringTurn = git(fixture.bare, 'branch', '--list', 'feature');
        createsDuringTurn = fixture
          .ghCalls()
          .filter((call) => call[1] === 'create').length;
      };
      fixture.controls.reply = {
        structured: { title: 'Change a to two', body: 'From the host turn.' },
      };
      const state = await fixture.run(
        'builtin/github-create-pr',
        'pr_model',
        'pr',
      );
      expect(helperStep(state)?.status).toBe('success');
      expect(pushedDuringTurn).toBe('');
      expect(createsDuringTurn).toBe(0);
      const creates = fixture.ghCalls().filter((call) => call[1] === 'create');
      expect(creates).toHaveLength(1);
      expect(creates[0]).toEqual(
        expect.arrayContaining([
          '--title',
          'Change a to two',
          '--repo',
          'fixture/origin',
        ]),
      );
      expect(git(fixture.bare, 'rev-parse', 'feature')).toBe(
        git(fixture.work, 'rev-parse', 'HEAD'),
      );
    },
  );

  scenario(
    'a failed turn pushes and creates nothing',
    'pr',
    async (fixture) => {
      fixture.controls.reply = { fail: 'model unavailable' };
      const state = await fixture.run(
        'builtin/github-create-pr',
        'pr_model',
        'pr-failed',
      );
      expect(helperStep(state)?.status).toBe('failure');
      expect(git(fixture.bare, 'branch', '--list', 'feature')).toBe('');
      expect(
        fixture.ghCalls().filter((call) => call[1] === 'create'),
      ).toHaveLength(0);
    },
  );
});

// Pushes that need no model turn still go only where prepare saw them, and
// a repository that changed during the turns is refused (review of #9390).
describe('host-run pushes without a model request', () => {
  scenario(
    "pushes a clean worktree's unpushed commits to the prepared target",
    'commit',
    async (fixture) => {
      git(fixture.work, 'commit', '-qam', 'local change');
      const head = git(fixture.work, 'rev-parse', 'HEAD');
      const state = await fixture.run(
        'builtin/git-commit-push',
        'commit_model',
        'push-only',
      );
      expect(helperStep(state)?.status).toBe('success');
      expect(fixture.turns).toHaveLength(0);
      expect(repoResults(state)[0]).toMatchObject({
        status: 'pushed',
        pushed: true,
      });
      expect(git(fixture.bare, 'rev-parse', 'feature')).toBe(head);
    },
  );

  scenario(
    'refuses to push a worktree that another commit made clean during the turn',
    'commit',
    async (fixture) => {
      const before = git(fixture.bare, 'rev-parse', 'feature');
      fixture.controls.reply = { structured: { message: 'feat: generated' } };
      fixture.controls.duringTurn = (): void => {
        git(fixture.work, 'commit', '-qam', 'committed meanwhile');
      };
      const state = await fixture.run(
        'builtin/git-commit-push',
        'commit_model',
        'clean-race',
      );
      expect(fixture.turns).toHaveLength(1);
      expect(repoResults(state)[0]).toMatchObject({
        status: 'failed',
        pushed: false,
      });
      expect(git(fixture.bare, 'rev-parse', 'feature')).toBe(before);
    },
  );

  scenario(
    "pushes an existing pull request's branch to the prepared target",
    'pr',
    async (fixture) => {
      writeFileSync(
        join(fixture.root, 'gh-state.json'),
        JSON.stringify({
          number: 7,
          title: 'existing',
          url: 'https://example.invalid/pr/7',
          baseRefName: 'main',
          headRefName: 'feature',
          isDraft: false,
        }),
      );
      const state = await fixture.run(
        'builtin/github-create-pr',
        'pr_model',
        'existing',
      );
      expect(helperStep(state)?.status).toBe('success');
      expect(fixture.turns).toHaveLength(0);
      expect(
        fixture.ghCalls().filter((call) => call[1] === 'create'),
      ).toHaveLength(0);
      expect(repoResults(state)[0]).toMatchObject({
        status: 'existing',
        prNumber: 7,
      });
      expect(git(fixture.bare, 'rev-parse', 'feature')).toBe(
        git(fixture.work, 'rev-parse', 'HEAD'),
      );
    },
  );

  scenario(
    'refuses a branch switched to an existing pull request during the turn',
    'pr',
    async (fixture) => {
      fixture.controls.reply = {
        structured: { title: 'generated', body: 'body' },
      };
      fixture.controls.duringTurn = (): void => {
        git(fixture.work, 'checkout', '-qb', 'other');
        writeFileSync(
          join(fixture.root, 'gh-state.json'),
          JSON.stringify({
            number: 7,
            title: 'existing',
            url: 'https://example.invalid/pr/7',
            baseRefName: 'main',
            headRefName: 'other',
            isDraft: false,
          }),
        );
      };
      const state = await fixture.run(
        'builtin/github-create-pr',
        'pr_model',
        'existing-race',
      );
      expect(repoResults(state)[0]).toMatchObject({ status: 'failed' });
      expect(
        spawnSync('git', ['rev-parse', '--verify', 'refs/heads/other'], {
          cwd: fixture.bare,
        }).status,
      ).not.toBe(0);
      expect(git(fixture.bare, 'branch', '--list', 'feature')).toBe('');
    },
  );

  scenario(
    "leaves an existing pull request's branch alone when origin is ahead of it",
    'pr',
    async (fixture) => {
      git(fixture.work, 'push', '-q', '-u', 'origin', 'feature');
      const pushed = git(fixture.bare, 'rev-parse', 'feature');
      git(fixture.work, 'reset', '-q', '--hard', 'HEAD~1');
      writeFileSync(
        join(fixture.root, 'gh-state.json'),
        JSON.stringify({
          number: 7,
          title: 'existing',
          url: 'https://example.invalid/pr/7',
          baseRefName: 'main',
          headRefName: 'feature',
          isDraft: false,
        }),
      );
      const state = await fixture.run(
        'builtin/github-create-pr',
        'pr_model',
        'existing-behind',
      );
      expect(helperStep(state)?.status).toBe('success');
      expect(fixture.turns).toHaveLength(0);
      expect(repoResults(state)[0]).toMatchObject({ status: 'existing' });
      expect(git(fixture.bare, 'rev-parse', 'feature')).toBe(pushed);
    },
  );

  scenario(
    'refuses an effective push URL rewritten to another repository',
    'pr',
    async (fixture) => {
      const other = join(fixture.root, 'other.git');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', other]);
      git(
        fixture.work,
        'config',
        `url.${other}.pushInsteadOf`,
        'https://github.com/fixture/origin.git',
      );
      fixture.controls.reply = {
        structured: { title: 'generated', body: 'body' },
      };
      const state = await fixture.run(
        'builtin/github-create-pr',
        'pr_model',
        'push-insteadof',
      );
      expect(repoResults(state)[0]).toMatchObject({ status: 'failed' });
      expect(fixture.turns).toHaveLength(0);
      expect(
        spawnSync('git', ['rev-parse', '--verify', 'refs/heads/feature'], {
          cwd: other,
        }).status,
      ).not.toBe(0);
    },
  );

  scenario(
    'refuses a push URL that names another repository than gh would use',
    'pr',
    async (fixture) => {
      const other = join(fixture.root, 'other.git');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', other]);
      git(fixture.work, 'config', 'remote.origin.pushurl', other);
      fixture.controls.reply = {
        structured: { title: 'generated', body: 'body' },
      };
      const state = await fixture.run(
        'builtin/github-create-pr',
        'pr_model',
        'pushurl-mismatch',
      );
      expect(repoResults(state)[0]).toMatchObject({ status: 'failed' });
      expect(fixture.turns).toHaveLength(0);
      expect(
        spawnSync('git', ['rev-parse', '--verify', 'refs/heads/feature'], {
          cwd: other,
        }).status,
      ).not.toBe(0);
      expect(
        fixture.ghCalls().filter((call) => call[1] === 'create'),
      ).toHaveLength(0);
    },
  );
});
