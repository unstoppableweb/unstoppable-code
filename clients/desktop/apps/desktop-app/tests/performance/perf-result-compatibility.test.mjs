import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatRepeatedComparisonLines } from './compare.mjs';
import {
  comparePerformanceResults,
  compareRepeatedPerformanceResults,
} from './comparison.mjs';
import {
  parseRendererGoneMessage,
  retainCrashDumps,
} from './renderer-crash-evidence.mjs';
import { finalizeResult } from './results.mjs';
import { assessSmokeRun } from './smoke-acceptance.mjs';
import { judgeWorkRatchet } from './work-ratchet.mjs';
import { RENDERER_GONE_MARKER } from '../electron/renderer-gone-marker.mjs';
import {
  assessBundleIdentity,
  bundleIdentityRecord,
  clearBundleIdentity,
  readCheckoutIdentity,
  writeBundleIdentity,
} from '../../../../scripts/lib/bundle-identity.mjs';

// Owned fixture cleanup.
const roots = new WeakMap();
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};
const requireOwned = (condition, detail) =>
  assert.ok(condition, `Owned test root: ${detail}`);

function createOwnedTestRoot(prefix = 'canopy-184-') {
  requireOwned(/^[a-zA-Z0-9_-]+-$/.test(prefix), 'invalid fixture prefix');
  const canonicalParent = realpathSync(path.resolve(tmpdir()));
  const created = mkdtempSync(path.join(canonicalParent, prefix));
  const initial = lstatSync(created);
  requireOwned(
    initial.isDirectory() && !initial.isSymbolicLink(),
    'fixture is not a directory',
  );
  const registration = Object.freeze({ dev: initial.dev, ino: initial.ino });
  const canonical = realpathSync(created);
  requireOwned(
    canonical === path.join(canonicalParent, path.basename(created)),
    'fixture is not a canonical direct child',
  );
  const checkIdentity = (stat) => {
    requireOwned(
      stat.isDirectory() && !stat.isSymbolicLink(),
      'fixture is not a directory',
    );
    requireOwned(stat.dev === registration.dev, 'device identity changed');
    requireOwned(stat.ino === registration.ino, 'inode identity changed');
  };
  checkIdentity(lstatSync(canonical));
  checkIdentity(lstatSync(created));
  const owner = Object.freeze({ path: created });
  roots.set(owner, Object.freeze({ canonical, ...registration }));
  return owner;
}

// These checks are not atomic with removal. Concurrent replacement remains untested.
function removeOwnedTestRoot(owner, target = owner?.path, ports = {}) {
  const receipt = roots.get(owner);
  requireOwned(receipt, 'unregistered owner');
  const inspect = ports.lstat ?? lstatSync;
  const resolve = ports.realpath ?? realpathSync;
  const entries = ports.readdir ?? readdirSync;
  const remove = ports.remove ?? rmSync;
  requireOwned(typeof target === 'string', 'missing removal path');
  const lexical = path.resolve(target);
  requireOwned(inside(owner.path, lexical), 'lexical escape');
  requireOwned(
    lexical === owner.path,
    'only the created fixture root may be removed',
  );
  const checkRoot = () => {
    const current = inspect(owner.path);
    requireOwned(
      current.isDirectory() && !current.isSymbolicLink(),
      'root is not a regular directory',
    );
    requireOwned(current.dev === receipt.dev, 'device identity changed');
    requireOwned(current.ino === receipt.ino, 'inode identity changed');
    requireOwned(
      resolve(owner.path) === receipt.canonical,
      'canonical root changed',
    );
  };
  checkRoot();
  requireOwned(inside(receipt.canonical, resolve(lexical)), 'canonical escape');
  const visit = (directory) => {
    for (const entry of entries(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      requireOwned(inside(owner.path, child), 'descendant lexical escape');
      const stat = inspect(child);
      const resolved = resolve(child);
      requireOwned(
        inside(receipt.canonical, resolved),
        'descendant symlink escape',
      );
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) visit(child);
    }
  };
  visit(lexical);
  checkRoot();
  remove(lexical, { recursive: true, force: true });
  if (remove === rmSync) roots.delete(owner);
}
// End owned fixture cleanup.

// Isolated fixture Git environment.
// This synchronous interval also covers the imported identity helper's Git calls.
function withIsolatedGitEnvironment(policy, run, environment = process.env) {
  const isGitEntry = (key) => /^GIT_/i.test(key);
  const previous = Object.fromEntries(
    Object.keys(environment)
      .filter(isGitEntry)
      .map((key) => [key, environment[key]]),
  );
  const clear = () => {
    for (const key of Object.keys(environment)) {
      if (isGitEntry(key)) delete environment[key];
    }
  };
  try {
    clear();
    Object.assign(environment, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.excludesFile',
      GIT_CONFIG_VALUE_0: policy.excludesFile,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: policy.configFile,
      GIT_CONFIG_GLOBAL: policy.configFile,
      GIT_TEMPLATE_DIR: policy.templateDirectory,
      GIT_TERMINAL_PROMPT: '0',
    });
    return run();
  } finally {
    clear();
    Object.assign(environment, previous);
  }
}
// End isolated fixture Git environment.

// CAN-5642: matched comparisons pair a baseline result from an older build
// with a candidate from a newer one, so every reader must treat the added
// crash and bundle identity fields as invisible.
const fixturePath = fileURLToPath(
  new URL(
    '../../../../scripts/fixtures/perf-result-schema2.json',
    import.meta.url,
  ),
);
const readOld = () => JSON.parse(readFileSync(fixturePath, 'utf8'));

function withAddedFields(result) {
  const next = structuredClone(result);
  next.source.bundleIdentity = {
    outDir: '/checkout/out-e2e',
    ...assessBundleIdentity({
      stamp: { version: 1, commit: 'a'.repeat(40), dirty: false },
      checkout: { commit: 'b'.repeat(40), dirty: false },
    }),
  };
  next.scenarios[0].rendererProcessGone = [
    {
      reason: 'crashed',
      exitCode: 5,
      url: 'file:///checkout/out-e2e/renderer/index.html',
      observedAt: '2026-11-07T13:48:40.000Z',
    },
  ];
  next.scenarios[0].crashDumps = {
    retained: true,
    directory: '/artifacts/w5-diagnostics/w5-store-reload/crash-dumps',
    files: ['crash.dmp'],
    bytes: 1024,
    skippedFiles: 0,
  };
  return next;
}

/** A one-sample, non-repeated result built from the fixture's first sample. */
function singleRun(result) {
  const single = structuredClone(result);
  delete single.repeat;
  single.scenarios = single.scenarios
    .filter((scenario) => scenario.sample === 0)
    .map((scenario) => {
      const next = { ...scenario, status: 'ok' };
      delete next.sample;
      return next;
    });
  return finalizeResult(single);
}

test('result readers give identical answers for files with and without the added fields', () => {
  const oldResult = readOld();
  const newResult = withAddedFields(oldResult);

  assert.deepEqual(
    finalizeResult(structuredClone(newResult)).metrics,
    finalizeResult(structuredClone(oldResult)).metrics,
  );

  const baseline = compareRepeatedPerformanceResults(oldResult, oldResult);
  assert.equal(baseline.compatible, true);
  for (const [left, right] of [
    [oldResult, newResult],
    [newResult, oldResult],
    [newResult, newResult],
  ]) {
    const comparison = compareRepeatedPerformanceResults(left, right);
    assert.deepEqual(comparison, baseline);
    assert.deepEqual(
      formatRepeatedComparisonLines(comparison, { profile: left.profile }),
      formatRepeatedComparisonLines(baseline, { profile: left.profile }),
    );
  }

  const singleOld = singleRun(oldResult);
  const singleNew = singleRun(newResult);
  assert.deepEqual(
    comparePerformanceResults(singleOld, singleNew),
    comparePerformanceResults(singleOld, singleOld),
  );

  assert.deepEqual(assessSmokeRun(newResult), assessSmokeRun(oldResult));
  assert.deepEqual(judgeWorkRatchet(newResult), judgeWorkRatchet(oldResult));
});

test('a bundle identity mismatch is reported, never thrown', () => {
  const checkout = { commit: 'b'.repeat(40), dirty: false };
  assert.deepEqual(
    assessBundleIdentity({
      stamp: { version: 1, commit: 'a'.repeat(40), dirty: false },
      checkout,
    }),
    {
      status: 'mismatch',
      reasons: ['commit'],
      stamp: { version: 1, commit: 'a'.repeat(40), dirty: false },
      checkout,
    },
  );
  assert.equal(
    assessBundleIdentity({ stamp: { commit: checkout.commit }, checkout })
      .status,
    'verified',
  );
  assert.deepEqual(assessBundleIdentity({ stamp: null, checkout }).reasons, [
    'no-stamp',
  ]);
});

test('a stamp from a build whose inputs or checkout moved never verifies', (t) => {
  const ownedRoot = createOwnedTestRoot('perf-bundle-identity-');
  const fixtureRoot = ownedRoot.path;
  t.after(() => removeOwnedTestRoot(ownedRoot, fixtureRoot));
  const root = path.join(fixtureRoot, 'repo');
  mkdirSync(root);
  const gitPolicy = {
    configFile: path.join(fixtureRoot, 'empty.gitconfig'),
    excludesFile: path.join(fixtureRoot, 'empty.gitignore'),
    templateDirectory: path.join(fixtureRoot, 'empty-template'),
  };
  writeFileSync(gitPolicy.configFile, '');
  writeFileSync(gitPolicy.excludesFile, '');
  mkdirSync(gitPolicy.templateDirectory);
  return withIsolatedGitEnvironment(gitPolicy, () => {
    const git = (...args) =>
      execFileSync(
        'git',
        [
          '-C',
          root,
          '-c',
          'user.name=perf',
          '-c',
          'user.email=perf@example.com',
          ...args,
        ],
        { stdio: 'ignore' },
      );
    git('init', '-q');
    writeFileSync(path.join(root, '.gitignore'), 'out-e2e/\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'one');
    const outDir = path.join(root, 'out-e2e');
    mkdirSync(outDir);
    const startedFrom = readCheckoutIdentity(root);

    writeBundleIdentity(outDir, root, { startedFrom });
    assert.equal(bundleIdentityRecord(root, outDir).status, 'verified');

    // A build clears the stamp first; one that then fails leaves none behind.
    clearBundleIdentity(outDir);
    assert.deepEqual(bundleIdentityRecord(root, outDir).reasons, ['no-stamp']);

    writeBundleIdentity(outDir, root, { startedFrom, inputsChanged: true });
    assert.deepEqual(bundleIdentityRecord(root, outDir).reasons, [
      'changed-during-build',
    ]);

    git('commit', '-q', '--allow-empty', '-m', 'two');
    writeBundleIdentity(outDir, root, { startedFrom });
    const moved = bundleIdentityRecord(root, outDir);
    assert.equal(moved.status, 'unverified');
    assert.deepEqual(moved.reasons, ['changed-during-build']);
  });
});

test('crash evidence parses the relay and copies only bounded dumps into the artifact directory', (t) => {
  assert.deepEqual(
    parseRendererGoneMessage(
      `${RENDERER_GONE_MARKER} ${JSON.stringify({ url: 'app://x', reason: 'oom', exitCode: -1 })}`,
    ),
    { reason: 'oom', exitCode: -1, url: 'app://x' },
  );
  assert.equal(parseRendererGoneMessage('[renderer:error] unrelated'), null);

  const ownedRoot = createOwnedTestRoot('perf-crash-dumps-');
  const fixtureRoot = ownedRoot.path;
  const root = fixtureRoot;
  t.after(() => removeOwnedTestRoot(ownedRoot, fixtureRoot));
  const source = path.join(root, 'Crashpad');
  mkdirSync(path.join(source, 'completed'), { recursive: true });
  for (const [name, bytes] of [
    ['a.dmp', 40],
    ['b.dmp', 40],
    ['c.dmp', 40],
  ])
    writeFileSync(path.join(source, 'completed', name), Buffer.alloc(bytes));
  writeFileSync(path.join(source, 'settings.dat'), 'not a dump');
  const destination = path.join(root, 'artifacts', 'crash-dumps');

  const retained = retainCrashDumps({
    source,
    destination,
    maxFiles: 5,
    maxBytes: 100,
  });
  assert.equal(retained.retained, true);
  assert.equal(retained.bytes, 80);
  assert.equal(retained.skippedFiles, 1);
  assert.deepEqual(readdirSync(destination).sort(), [...retained.files].sort());
  assert.equal(
    retainCrashDumps({ source, destination: null }).reason,
    'no-artifact-directory',
  );
});
