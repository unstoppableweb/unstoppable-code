import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pipe = JSON.parse(
  readFileSync(
    new URL('./windows-pipe-inventory.json', import.meta.url),
    'utf8',
  ),
);

export const phase3Suites = [
  {
    file: 'apps/core-daemon/src/__tests__/windows-files-mutations.test.ts',
    layer: 'daemon-composition',
    requiredTitles: [
      'denies production interface and worker grants and closed admission before all five effects',
      'creates and saves Unicode and empty files under a write hold and refuses stale versions without effects',
      'preserves colliding files directories and dangling names and publishes copies without clobber',
      'moves files and directories on one volume and performs case-only rename without changing identity',
      'qualifies documented link-copy outcomes and moves and deletes link entries without changing targets',
      'uses EISDIR hard-link fallbacks without clobbering entries or copying file-link targets',
      'refuses dangling and outside-target link moves with public errors and unchanged entries',
      'refuses excluded-root aliases and unsafe paths on every mutation without changing protected bytes',
      'takes native cross-device transfer paths through a required UNC root and rejects cross-root symlinks',
      'deletes through Leg C native Trash with Recycle Bin identity and leaves link targets intact',
    ],
  },
  {
    file: 'packages/core-platform/src/__tests__/git-read-windows-repository.test.ts',
    layer: 'direct-platform-contract',
    minimumCases: 31,
  },
  {
    file: 'apps/core-daemon/src/__tests__/windows-git-reads.test.ts',
    layer: 'daemon-composition',
    minimumCases: 3,
  },
  {
    file: 'apps/core-daemon/src/__tests__/watch-native-windows.test.ts',
    layer: 'daemon-composition',
    requiredTitles: [
      'invalidates recursive Unicode paths with slash-normalized create change delete and rename',
      'anchors absent attachments at their existing parent and rebases their appearance',
      'keeps an absent attachment with no bounded ancestor inert and refuses an unknown root',
      'invalidates a parent-anchored root deletion and recreation without ending the stream',
      'rescans a missing root after a controlled native error and reattaches on recreation',
      'requires rescan for unnamed notifications and a buffered burst of real native paths',
      'polls HEAD invalidation while controlled watch unavailability prevents native reattachment',
      'shares a native tree across subscribers and closes it only after the last connection leaves',
      'retains shallow nonpersistent HEAD dormant but changes epoch before reuse',
      'cancels a caller signal through the bundled dispatcher and closes its tree handle',
      'characterizes client-only cancellation and releases native ownership on lease loss',
      'requires snapshots for future foreign and superseded native source cursors',
      'closes trees on daemon shutdown and rejects stale cursors after restart',
      'drives the branch observer record port from native Git HEAD replacement without moving the writer',
    ],
  },
  {
    file: 'apps/core-daemon/src/__tests__/windows-files-reads.test.ts',
    layer: 'daemon-composition',
    required: [
      'Windows Files in-process / daemon comparison compares roots, directory and file bytes under drive/case aliases, spaces and Unicode',
      'Windows Files in-process / daemon comparison compares junctions, file and directory symlinks and dangling links without outside bytes',
      'Windows Files in-process / daemon comparison compares root containment and excluded descendants while preserving separately addressable roots',
      'Windows Files in-process / daemon comparison compares Git ignore marks and paginated searches and refuses cross-backend or mismatched cursors',
      'Windows Files in-process / daemon comparison compares cancellation and reached-daemon refusals without gaining write grants',
      'Windows Files in-process / daemon comparison uses each host snapshot for Files Git reads and rejects a per-request environment',
    ],
  },
  {
    file: 'apps/desktop-app/src/main/canopy-runtime/__tests__/windows-files-route.test.ts',
    layer: 'daemon-composition',
    required: [
      'Windows Files route qualification contract keeps shipped Windows file, search and link unselected and reserved Git cells blocked',
      'Windows Files route qualification contract preserves tagged unreachable read fallback without sending mutations to the daemon',
      'Windows Files route qualification contract falls back after the attempted read connection is lost but not on a reached-daemon refusal',
      'Windows Files route qualification contract cancels an in-flight read without falling back or latching unreachable',
      'Windows Files route qualification contract pins search cursors to their original backend across loss, reattachment and the unreachable latch',
    ],
  },
  {
    file: 'apps/desktop-cli/src/__tests__/daemon-host.test.ts',
    layer: 'daemon-composition',
    minimumCases: 21,
  },
  {
    file: 'packages/core-client/src/node/__tests__/daemon-host.test.ts',
    layer: 'daemon-composition',
    minimumCases: 16,
  },
  {
    file: 'packages/core-platform/src/__tests__/windows-pipe-security.test.ts',
    layer: 'direct-platform-contract',
    required: pipe.cases.map(({ title, ancestorTitles }) =>
      [...ancestorTitles, title].join(' '),
    ),
  },
  {
    file: 'packages/core-platform/src/__tests__/git-read-windows.test.ts',
    layer: 'direct-platform-contract',
    requiredTitles: [
      'reports native where.exe winget availability on both successful and failed Git detection',
      'discovers per-user winget aliases outside the sanitized daemon PATH without changing Git discovery',
      'uses saved then mixed-case override then discovery with native paths containing spaces',
      'discovers native standard installs through mixed-case environment names',
      'matches native Git selection before and after the Windows launch allowlist',
      'rechecks native removed and replaced executables and distinguishes unusable from missing',
      'shares one native selected executable between daemon ignored reads and the write selector',
      'lists the request cwd before the supplied PATH',
      'finds real Git through the supplied PATH alone',
      'exits 1 when neither the cwd nor the supplied PATH has git',
      'runs System32 where.exe from the supplied PATH, not one planted in the request cwd',
      'rejects with command_not_found when the supplied PATH has no where.exe',
      'resolves `git` through the supplied PATH, never the request cwd',
      'supplies every omitted libuv-required key empty, and nothing from the host',
      'supplies each omitted key empty, keeps each empty key, and refuses a missing or empty PATH or SystemRoot, one at a time',
      'treats a differently cased Path as present',
      'never reports it absent, and records each query it ran',
      'settles an abort after taskkill ends the tree, within the reserve',
      'settles a deadline stop by the request deadline',
      'reports cleanup_unconfirmed at the reserve, and the delayed taskkill still ends the tree (3 s injected pre-call delay)',
      'reports cleanup_unconfirmed at the reserve while the kill helper runs, and the helper then ends the tree (taskkill stand-in)',
      'execFile with an already-aborted signal creates taskkill.exe, then terminates it',
      'owned options are not detached',
      'ends an owned Node child and the descendant it assigned to its own job',
      'ends an owned cmd.exe child but not the descendant cmd.exe started',
      'ends an owned git.exe but not the sh.exe its alias started',
      'control: an independent child outlives its host',
      'unions sequential chunks with real Git',
      'treats exit 1 (nothing ignored) as empty',
      'returns NUL-separated Unicode paths unquoted under each locale',
      'rejects a small input Git has read with exit 128',
      'records the stdin failure (EOF on Windows) versus exit 128 for 4 MiB outside a repository',
      'lists ignored paths with the discharge, and the listing starts no fsmonitor daemon',
      'builtin fsmonitor daemon: the discharged runner never starts one; raw check-ignore outlives the request where Git supports it',
    ],
  },
  {
    file: 'packages/core-platform/src/__tests__/git-read-host-repository.test.ts',
    layer: 'direct-platform-contract',
    requiredTitles: [
      'reports Windows precedence, winget and existing unusable candidates without changing preferences',
      'reports Windows stat failures as missing during detection, not selected-unusable',
      'reports a Windows candidate removed after successful stat as unusable',
      'revalidates Windows facts without a rejection TTL and does not join a forced recheck',
      'keeps the newer forced Windows detection after the older finishes last',
    ],
  },
  {
    file: 'packages/core-platform/src/__tests__/git-read-host.test.ts',
    layer: 'direct-platform-contract',
    requiredTitles: [
      'preserves an inaccessible saved Windows selection instead of spawning a fallback',
    ],
  },
  {
    file: 'packages/core-platform/src/__tests__/trash-native.test.ts',
    layer: 'direct-platform-contract',
    required: [
      'recycles a file, a directory and a junction, each as itself',
      'reports a long path truthfully: recycled and gone, or refused and in place',
      'refuses a missing entry as failed',
      'is unavailable when the addon is not staged',
    ].map((title) => `win32 IFileOperation recycle ${title}`),
  },
  {
    file: 'packages/core-platform/src/__tests__/w5-confined-read.windows.test.ts',
    layer: 'direct-platform-contract',
    requiredTitles: [
      'reads in-root files and reports absence, non-files and the byte bound',
      'refuses a final-component file symlink, dangling symlink, directory symlink and junction',
      'refuses a root that is a junction or reached through one as changed, and a missing root as unavailable',
      'rejects invalid requests in the addon itself',
      'never yields outside bytes while a workspace directory is repeatedly swapped for a junction',
      'never yields outside bytes while an ancestor of the root is repeatedly swapped for a junction',
      'loads and reads in a worker thread beside a main-thread load, as the W5 worker does',
      'captures through the reader end to end, and never outside bytes',
      'never captures outside bytes while an ancestor of the root is repeatedly swapped for a junction',
      'captures from a data root under the user profile, spelled as the host spells it',
    ],
  },
  {
    file: 'apps/core-daemon/src/__tests__/native-trash.test.ts',
    layer: 'daemon-composition',
    minimumCases: 14,
  },
  {
    file: 'apps/core-daemon/src/__tests__/windows-phase3.test.ts',
    layer: 'daemon-composition',
    required: [
      'Phase 3 test-only worker reachability projects native Windows winget and failure detail through the bundled executable query',
      'Phase 3 test-only worker reachability discovers Program Files Git and applies the override through the production launch environment',
      'Phase 3 test-only worker reachability denies production grants and reaches the Git host through the bundled binding',
      'Phase 3 test-only worker reachability refuses an ungranted interface and a foreign selection before Git runs',
    ],
  },
];

export const phase3ElectronCases = [
  'electron-launch-secured-pipe',
  'electron-attachment-same-daemon',
];

export function windowsQualificationLane(platform, architecture, release) {
  if (platform !== 'win32') return 'unsupported host';
  const [major, , build] = release.split('.').map(Number);
  return architecture === 'x64' && major === 10 && build >= 22000
    ? 'local Windows 11 x64 desktop'
    : 'manual Windows host';
}

export function assertExactHead(git) {
  // autocrlf=true runners can report stat/CRLF noise after a fresh checkout.
  // Compare content to HEAD, including the index, and still refuse untracked files.
  for (const index of [[], ['--cached']])
    git(
      'diff',
      '--quiet',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-cr-at-eol',
      ...index,
      'HEAD',
      '--',
    );
  assert.equal(
    git('ls-files', '--others', '--exclude-standard', '-z'),
    '',
    'exact-head qualification refuses untracked files',
  );
}

/**
 * @typedef {{ fullName: string, title?: string, status: string }} AssertionResult
 * @typedef {{ name: string, status: string, assertionResults: AssertionResult[], message?: string }} SuiteResult
 * @typedef {{ success?: boolean, wasInterrupted?: boolean, testResults: SuiteResult[] }} JestResults
 * @typedef {{ file: string, layer: string, required?: string[], requiredTitles?: string[], minimumCases?: number }} RequiredSuite
 * @typedef {{ file?: string, name?: string, layer: string, status: string, required: boolean }} CaseResult
 */

/** @param {JestResults} jest @param {RequiredSuite[]} suites @returns {CaseResult[]} */
export function collectCaseResults(jest, suites = phase3Suites) {
  return suites.flatMap((suite) => {
    const matches = (jest.testResults ?? []).filter(({ name }) =>
      name.replaceAll('\\', '/').endsWith(`/${suite.file}`),
    );
    const cases = matches.length === 1 ? matches[0].assertionResults : [];
    if (!suite.requiredTitles && !suite.required && cases.length > 0)
      return cases.map(({ fullName, status }) => ({
        file: suite.file,
        name: fullName,
        layer: suite.layer,
        status,
        required: true,
      }));
    const names =
      suite.requiredTitles ??
      suite.required ??
      cases.map(({ fullName }) => fullName);
    const field = suite.requiredTitles ? 'title' : 'fullName';
    if (names.length === 0)
      return [
        {
          file: suite.file,
          layer: suite.layer,
          status: 'missing',
          required: true,
        },
      ];
    const required = names.map((name) => {
      const found = cases.filter((result) => result[field] === name);
      const status =
        matches.length > 1 || found.length > 1
          ? 'duplicate'
          : found.length === 0
            ? 'missing'
            : found[0].status;
      return {
        file: suite.file,
        name: found[0]?.fullName ?? name,
        layer: suite.layer,
        status,
        required: true,
      };
    });
    const optional = cases
      .filter((result) => !names.includes(result[field]))
      .map((result) => ({
        file: suite.file,
        name: result.fullName,
        layer: suite.layer,
        status: result.status,
        required: false,
      }));
    return [...required, ...optional];
  });
}

// Never infer qualification from Jest's exit status or aggregate passed count.
/** @param {JestResults} jest @param {RequiredSuite[]} suites */
export function requiredCaseResults(jest, suites = phase3Suites) {
  assert.equal(jest.success, true, 'Jest must succeed');
  assert.equal(jest.wasInterrupted, false, 'Jest must complete');
  for (const suite of suites) {
    const matches = jest.testResults.filter(({ name }) =>
      name.replaceAll('\\', '/').endsWith(`/${suite.file}`),
    );
    assert.equal(matches.length, 1, `one result required: ${suite.file}`);
    // Jest serializes a file with pending assertions as "focused", even without .only.
    assert.ok(
      ['passed', 'focused'].includes(matches[0].status),
      `suite did not complete: ${suite.file} (${matches[0].status})`,
    );
    assert.ok(!matches[0].message, `suite error: ${suite.file}`);
    for (const result of matches[0].assertionResults)
      assert.notEqual(
        result.status,
        'failed',
        `case failed: ${suite.file} ${result.fullName}`,
      );
    assert.ok(
      matches[0].assertionResults.length >= (suite.minimumCases ?? 1),
      `required case inventory shrank: ${suite.file}`,
    );
  }
  const results = collectCaseResults(jest, suites).filter(
    ({ required }) => required,
  );
  assert.ok(results.length > 0, 'nonempty required contract');
  for (const result of results)
    assert.equal(
      result.status,
      'passed',
      `required case did not pass: ${result.file} ${result.name ?? '(missing)'}`,
    );
  return results;
}
