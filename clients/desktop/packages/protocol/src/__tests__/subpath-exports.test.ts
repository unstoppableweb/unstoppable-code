import { build } from 'esbuild';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { TextDecoder, TextEncoder } from 'node:util';

/**
 * Every `@canopy/protocol/<subpath>` an in-repo source file imports must be
 * declared in this package's `exports` map, and every declared entry must point
 * at a file that exists.
 *
 * Most consumers never notice a missing entry: the desktop renderer, the
 * desktop main process and the Next build all resolve protocol subpaths
 * through a tsconfig `paths` alias, which bypasses the `exports` map entirely.
 * Real Node resolution only kicks in where those aliases are absent — and the
 * `apps/web` Docker builder is exactly that place, because the web build
 * context does not include the root `tsconfig.base.json`, so every workspace
 * package tsconfig that extends it loses its `paths`.
 *
 * That is how `@canopy/protocol/llm-gateway` shipped unexported and stayed
 * green for weeks: nothing bundled it under real Node resolution until the
 * `build:worker:routing-backtest` esbuild target pulled
 * `@canopy/agent-transcript` into the web image, and the staging deploy broke
 * with "The path ./llm-gateway is not exported by package @canopy/protocol".
 *
 * A dangling target is the other half of that same failure class: it passes an
 * existence-blind declaration check and then breaks the same build with
 * `ERR_MODULE_NOT_FOUND` instead of `ERR_PACKAGE_PATH_NOT_EXPORTED`. Both are
 * asserted below.
 *
 * The scan is specifier-driven, so a new subpath is covered with no edit here.
 */
const REPO_ROOT = resolve(__dirname, '../../../..');
const PROTOCOL_DIR = join(REPO_ROOT, 'packages/protocol');
const SCAN_ROOTS = ['apps', 'packages'] as const;
// Dot-prefixed directories (`.next`, `.cache`, `.turbo`, `.playwright`, …) are
// already skipped wholesale by the `startsWith('.')` check below.
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'out-e2e',
  'generated',
  'coverage',
]);
const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];
// Anchored on the module-specifier forms rather than on bare text, so a TSDoc
// comment or string literal naming a planned subpath cannot red the build.
// `mock`/`requireActual` are included because a `jest.mock(...)` first argument
// is a real specifier site that Jest resolves like any other. The character
// class is deliberately wider than the naming convention: an off-convention
// subpath should surface honestly rather than be captured truncated.
const SUBPATH_PATTERN =
  /(?:from|import|require|mock|requireActual)\s*\(?\s*['"]@canopy\/protocol\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)['"]/;

function collectSourceFiles(directory: string, found: string[]): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(directory);
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) {
      continue;
    }
    if (SKIP_DIRECTORIES.has(entry)) {
      continue;
    }

    const entryPath = join(directory, entry);
    // This file necessarily quotes specifier syntax in its own comments and
    // assertions; scanning it would make the guard report itself.
    if (entryPath === __filename) {
      continue;
    }
    // `lstat`, not `stat`: `apps/desktop-cli/main` and `apps/desktop-cli/shared`
    // are symlinks back into trees this scan already walks.
    const stats = lstatSync(entryPath);
    if (stats.isSymbolicLink()) {
      continue;
    }
    if (stats.isDirectory()) {
      collectSourceFiles(entryPath, found);
      continue;
    }
    if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      found.push(entryPath);
    }
  }

  return found;
}

function readExportMap(): Map<string, string> {
  const raw = readFileSync(join(PROTOCOL_DIR, 'package.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || !('exports' in parsed)) {
    throw new Error('packages/protocol/package.json has no exports map');
  }
  const exportsValue: unknown = parsed.exports;
  if (typeof exportsValue !== 'object' || exportsValue === null) {
    throw new Error('packages/protocol/package.json has no exports map');
  }

  const exportMap = new Map<string, string>();
  for (const subpath of Object.keys(exportsValue)) {
    const target: unknown = Reflect.get(exportsValue, subpath);
    if (typeof target !== 'string') {
      throw new Error(`Non-string export target for "${subpath}"`);
    }
    exportMap.set(subpath, target);
  }
  return exportMap;
}

function collectImportedSubpaths(): Map<string, string[]> {
  const imported = new Map<string, string[]>();

  for (const root of SCAN_ROOTS) {
    for (const file of collectSourceFiles(join(REPO_ROOT, root), [])) {
      const contents = readFileSync(file, 'utf8');
      // A fresh RegExp per file so `lastIndex` never carries across files.
      const pattern = new RegExp(SUBPATH_PATTERN.source, 'g');
      let match: RegExpExecArray | null = pattern.exec(contents);
      while (match !== null) {
        const captured: string = match[1] ?? '';
        match = pattern.exec(contents);
        if (captured === '') {
          continue;
        }
        const subpath = `./${captured}`;
        const importers = imported.get(subpath) ?? [];
        if (!importers.includes(file)) {
          importers.push(file);
        }
        imported.set(subpath, importers);
      }
    }
  }

  return imported;
}

describe('@canopy/protocol subpath exports', () => {
  it('declares every subpath that in-repo sources import', () => {
    const exported = new Set(readExportMap().keys());
    const imported = collectImportedSubpaths();

    expect(imported.size).toBeGreaterThan(0);

    const missing: string[] = [];
    imported.forEach((importers: string[], subpath: string): void => {
      if (exported.has(subpath)) {
        return;
      }
      const shown = importers
        .slice(0, 3)
        .map((importer: string): string =>
          importer.slice(REPO_ROOT.length + 1),
        );
      missing.push(`${subpath} (imported by ${shown.join(', ')})`);
    });
    missing.sort();

    expect(missing).toEqual([]);
  });

  it('points every declared subpath at a file that exists', () => {
    const exportMap = readExportMap();

    expect(exportMap.size).toBeGreaterThan(0);

    const dangling: string[] = [];
    exportMap.forEach((target: string, subpath: string): void => {
      if (!existsSync(join(PROTOCOL_DIR, target))) {
        dangling.push(`${subpath} -> ${target}`);
      }
    });
    dangling.sort();

    expect(dangling).toEqual([]);
  });

  it('declares the worktree branch-name helpers consumed by the server and the desktop shims', () => {
    // The desktop shims and the cloud worktree routes import these helpers by
    // subpath. Pin the entry so dropping it fails here, with the subpath named,
    // instead of in a bundler error under real Node resolution.
    expect(readExportMap().get('./worktree-branch-names')).toBe(
      './src/worktree-branch-names/index.ts',
    );
  });
});

it.each([
  'app-errors',
  'feedback-report',
  'remote-control',
  'remote-control/channels',
  'device-relay',
  'pipeline-relay',
])('bundles %s using only protocol and Zod', async (subpath) => {
  const result = await build({
    absWorkingDir: REPO_ROOT,
    stdin: {
      resolveDir: REPO_ROOT,
      contents: `export * from '@canopy/protocol/${subpath}';`,
    },
    tsconfigRaw: { compilerOptions: {} },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
  });
  const forbidden = Object.keys(result.metafile.inputs).filter(
    (input) =>
      input !== '<stdin>' &&
      !input.startsWith('packages/protocol/src/') &&
      !/^node_modules\/(?:\.pnpm\/zod@[^/]+\/node_modules\/)?zod\//.test(input),
  );
  expect(forbidden).toEqual([]);
});

it('bundles @canopy/remote-session for browser workers from protocol and Zod only', async () => {
  // The browser SharedWorker and the hosted Node service both load this
  // package; it may use only WebCrypto, streams and injected sockets.
  const result = await build({
    absWorkingDir: REPO_ROOT,
    stdin: {
      resolveDir: REPO_ROOT,
      contents: `export * from '@canopy/remote-session';`,
    },
    tsconfigRaw: { compilerOptions: {} },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs);
  expect(inputs).toContain('packages/remote-session/src/index.ts');
  const forbidden = inputs.filter(
    (input) =>
      input !== '<stdin>' &&
      !input.startsWith('packages/remote-session/src/') &&
      !input.startsWith('packages/protocol/src/') &&
      !/^node_modules\/(?:\.pnpm\/zod@[^/]+\/node_modules\/)?zod\//.test(input),
  );
  expect(forbidden).toEqual([]);
  const text = result.outputFiles.map((file) => file.text).join('\n');
  expect(text).not.toMatch(/\bfrom\s+["']node:|require\(["']node:/);
  expect(text).not.toMatch(/\b(?:window|document|localStorage|indexedDB)\./);
});

it('bundles published file-indexing and desktop compatibility exports for browsers without Node', async () => {
  const result = await build({
    absWorkingDir: REPO_ROOT,
    stdin: {
      resolveDir: REPO_ROOT,
      contents: `
        import { BUILTIN_INDEX_GLOBS, BUILTIN_INDEX_GLOB_IDS,
          getBuiltinIndexGlob, createDefaultFileIndexingPreferences }
          from '@canopy/protocol/file-indexing';
        import * as compatibility from '@canopy/desktop-shared/file-indexing';
        export { BUILTIN_INDEX_GLOBS, BUILTIN_INDEX_GLOB_IDS,
          getBuiltinIndexGlob, createDefaultFileIndexingPreferences, compatibility };
      `,
    },
    tsconfigRaw: { compilerOptions: {} },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
  });
  expect(Object.keys(result.metafile.inputs).sort()).toEqual([
    '<stdin>',
    'packages/desktop-shared/src/file-indexing.ts',
    'packages/protocol/src/file-indexing/index.ts',
  ]);
});

it('runs the published Node file-indexing APIs without workspace path aliases', async () => {
  const result = await build({
    absWorkingDir: REPO_ROOT,
    stdin: {
      resolveDir: REPO_ROOT,
      contents: `
        import assert from 'node:assert/strict';
        import { normalizeFileIndexingPreferences, buildFileGlobMatcher,
          buildFileExplorerGlobMatcher } from '@canopy/core-runtime/node';
        import { createFileIndexingMatchPolicy } from '@canopy/core-platform';
        import { createDefaultFileIndexingPreferences } from '@canopy/protocol/file-indexing';
        const preferences = normalizeFileIndexingPreferences({
          customGlobs: [{ pattern: ' café/** ' }],
        });
        assert.deepEqual(preferences.customGlobs,
          [{ id: 'custom-cadf99727580', pattern: 'café/**', enabled: true }]);
        assert.deepEqual(createDefaultFileIndexingPreferences(),
          { disabledBuiltinGlobIds: [], customGlobs: [] });
        for (const os of ['linux', 'darwin', 'win32']) {
          const policy = createFileIndexingMatchPolicy(os);
          const index = buildFileGlobMatcher(preferences, policy);
          const explorer = buildFileExplorerGlobMatcher(policy);
          assert.equal(index.isIndexExcluded('café/x', 'file'), true);
          assert.equal(index.isIndexExcluded('CAFÉ/x', 'file'), os !== 'linux');
          assert.equal(explorer.isIndexExcluded('café/x', 'file'), false);
          assert.equal(explorer.isTraversalDeferred('node_modules'), true);
        }
        export const verified = true;
      `,
    },
    tsconfigRaw: { compilerOptions: {} },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  expect(result.outputFiles).toHaveLength(1);
  const context = {
    module: { exports: {} },
    require,
    process,
    Buffer,
    TextDecoder,
    TextEncoder,
  };
  for (const output of result.outputFiles) {
    runInNewContext(output.text, context);
  }
  expect(Reflect.get(context.module.exports, 'verified')).toBe(true);
});

it('bundles the Git selection helpers and desktop compatibility exports for browsers without Node', async () => {
  const result = await build({
    absWorkingDir: REPO_ROOT,
    stdin: {
      resolveDir: REPO_ROOT,
      contents: `
        import * as helpers from '@canopy/protocol/git-executable';
        import * as compatibility from '@canopy/desktop-shared/lib/git-executable.ts';
        export { helpers, compatibility };
      `,
    },
    tsconfigRaw: { compilerOptions: {} },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
  });
  expect(Object.keys(result.metafile.inputs).sort()).toEqual([
    '<stdin>',
    'packages/desktop-shared/src/lib/git-executable.ts',
    'packages/protocol/src/git-executable/index.ts',
  ]);
});

it('re-exports the same Git selection helpers from core-runtime/node and desktop-shared', async () => {
  const result = await build({
    absWorkingDir: REPO_ROOT,
    stdin: {
      resolveDir: REPO_ROOT,
      contents: `
        import assert from 'node:assert/strict';
        import * as runtime from '@canopy/core-runtime/node';
        import * as helpers from '@canopy/protocol/git-executable';
        import * as compatibility from '@canopy/desktop-shared/lib/git-executable.ts';
        const names = Object.keys(helpers).sort();
        assert.deepEqual(names, [
          'LINUX_SYSTEM_GIT_PATH',
          'MAC_COMMAND_LINE_TOOLS_GIT_PATH',
          'MAC_HOMEBREW_GIT_PATHS',
          'getGitExecutableDetectionMode',
          'getGitExecutableProbeOrder',
          'getGitExecutableRequirement',
          'getLinuxGitCandidates',
          'getMacGitCandidates',
          'getWindowsGitCandidates',
          'isMacGitShim',
          'parseGitVersion',
          'parseWhereExeOutput',
          'selectLinuxExplicitGitChoice',
          'shapeGitExecutableStatus',
          'shouldJoinGitExecutableDetection',
        ]);
        for (const name of names) {
          assert.equal(runtime[name], helpers[name], name);
          assert.equal(compatibility[name], helpers[name], name);
        }
        assert.equal(typeof compatibility.getGitExecutableCommand, 'function');
        export const verified = true;
      `,
    },
    tsconfigRaw: { compilerOptions: {} },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  expect(result.outputFiles).toHaveLength(1);
  const context = {
    module: { exports: {} },
    require,
    process,
    Buffer,
    TextDecoder,
    TextEncoder,
  };
  for (const output of result.outputFiles) {
    runInNewContext(output.text, context);
  }
  expect(Reflect.get(context.module.exports, 'verified')).toBe(true);
});
