#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadBrand } from './brand/load-brand.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(root, 'dist', 'legal', 'THIRD_PARTY_NOTICES.txt');
const selectedBrand = loadBrand(process.env.CANOPY_BRAND ?? 'canopy', {
  repoRoot: root,
});

const PACKAGE_ROOTS = [
  '',
  'apps/desktop-app',
  'apps/desktop-cli',
  'packages/protocol',
  'packages/plugin-interop',
  'packages/memory-consolidation',
  'packages/desktop-shared',
  'packages/execution-engine',
  'packages/ui-shared',
  'packages/ui-rich',
];

const MOONSHINE_RUNTIME_VERSION = 'v0.1.6';

function assertMoonshineRuntimePin() {
  const pinPath = 'apps/canopy-dictate-linux/moonshine-runtime.txt';
  const pinned = readFileSync(join(root, pinPath), 'utf8')
    .split('\n')
    .some(
      (line) =>
        /^linux-x64\s+(\S+)\s/.exec(line)?.[1] === MOONSHINE_RUNTIME_VERSION,
    );
  if (!pinned) {
    throw new Error(
      `${pinPath} must pin linux-x64 to ${MOONSHINE_RUNTIME_VERSION}, the Moonshine Voice version declared in BUNDLED_TOOLS. Update the Moonshine Voice and ONNX Runtime entries and re-vendor scripts/vendor/moonshine-voice and scripts/vendor/onnxruntime.`,
    );
  }
}

const BUNDLED_TOOLS = [
  {
    label: 'Node.js (private desktop interpreter and standalone SEA runtime)',
    packageKey: 'cli-node',
    versionKey: 'version',
    source: 'https://nodejs.org/',
    license:
      'MIT and bundled third-party licenses. The private desktop payload includes the complete upstream license at node-runtime/NODE-LICENSE; TSX and its dependencies carry their licenses under node-runtime/node_modules.',
  },
  {
    label: 'Claude Code CLI',
    packageKey: 'claude-code',
    versionKey: 'version',
    source: 'https://docs.anthropic.com/en/docs/claude-code',
    license: 'See upstream Anthropic terms and distribution notices.',
  },
  {
    label: 'OpenAI Codex CLI',
    packageKey: 'codex',
    versionKey: 'version',
    source: 'https://github.com/openai/codex',
    license: 'See upstream OpenAI terms and distribution notices.',
  },
  {
    label:
      'bubblewrap 0.11.2 (Linux sandbox helper; version below is the Codex distribution)',
    packageKey: 'codex',
    versionKey: 'version',
    source:
      'https://github.com/openai/codex/tree/rust-v0.159.0/codex-rs/vendor/bubblewrap',
    license: 'LGPL-2.0-or-later',
    licensePath: 'scripts/vendor/bubblewrap/COPYING',
  },
  // The Linux dictation runtime. Its versions are static because the pin lives
  // in apps/canopy-dictate-linux/moonshine-runtime.txt (read by build.sh), not
  // in package.json; assertMoonshineRuntimePin() keeps the two in step.
  {
    label: 'Moonshine Voice (libmoonshine.so, Linux x64 dictation runtime)',
    version: MOONSHINE_RUNTIME_VERSION,
    source: `https://github.com/moonshine-ai/moonshine/tree/${MOONSHINE_RUNTIME_VERSION}`,
    license: `MIT and bundled third-party licenses. Components compiled into libmoonshine.so keep their own licenses, listed under core/third-party/ in the upstream source at ${MOONSHINE_RUNTIME_VERSION}.`,
    licensePath: 'scripts/vendor/moonshine-voice/LICENSE',
  },
  {
    label: 'ONNX Runtime (libonnxruntime.so.1, Linux x64 dictation runtime)',
    version: '1.23.2',
    source: 'https://github.com/microsoft/onnxruntime/tree/v1.23.2',
    license:
      "MIT and bundled third-party licenses. Microsoft's third-party notices for this build follow in the next entry.",
    licensePath: 'scripts/vendor/onnxruntime/LICENSE',
  },
  {
    label: 'ONNX Runtime third-party notices (bundled in libonnxruntime.so.1)',
    version: '1.23.2',
    source: 'https://www.nuget.org/packages/Microsoft.ML.OnnxRuntime/1.23.2',
    license: 'See the notices below.',
    licensePath: 'scripts/vendor/onnxruntime/ThirdPartyNotices.txt',
  },
  {
    label: 'GitHub CLI',
    packageKey: 'gh-cli',
    versionKey: 'version',
    source: 'https://github.com/cli/cli',
    license: 'MIT',
  },
  {
    label: 'ripgrep',
    packageKey: 'ripgrep',
    versionKey: 'version',
    source: 'https://github.com/BurntSushi/ripgrep',
    license: 'MIT OR Unlicense',
  },
  {
    label: 'RTK CLI',
    packageKey: 'rtk',
    versionKey: 'version',
    source: 'https://github.com/upstash/redis-toolkit',
    license: 'See upstream distribution notices.',
  },
];

const BUNDLED_ASSETS = [
  {
    label: 'Unicode Emoji 16.0 data (emoji-test.txt, CLDR short names)',
    version: '16.0',
    source: 'https://unicode.org/Public/emoji/16.0/emoji-test.txt',
    license: 'Unicode-3.0',
    licensePath: 'packages/ui-shared/src/components/bots/UNICODE-LICENSE.txt',
  },
  {
    label: 'Material Symbols (Rounded, weight 300)',
    version:
      'google/material-design-icons@49d4db35df873165d6bd6ba09b063c7dafbac2f4',
    source: 'https://github.com/google/material-design-icons',
    license: 'Apache-2.0',
    licensePath: 'packages/ui-shared/src/icons/vendor/material/LICENSE',
  },
  {
    label: 'Simple Icons (selected brand marks)',
    version: '16.35.0',
    source: 'https://github.com/simple-icons/simple-icons',
    license: 'CC0-1.0',
    licensePath: 'packages/ui-shared/src/icons/vendor/simple-icons/LICENSE',
  },
  {
    label: 'LobeHub Icons (selected brand marks)',
    version: '1.95.1',
    source: 'https://github.com/lobehub/lobe-icons',
    license: 'MIT',
    licensePath: 'packages/ui-shared/src/icons/vendor/lobehub/LICENSE',
  },
  {
    label: 'Octicons (selected git and GitHub glyphs)',
    version: '19.40.0',
    source: 'https://github.com/primer/octicons',
    license: 'MIT',
    licensePath: 'packages/ui-shared/src/icons/vendor/octicons/LICENSE',
  },
  {
    label: 'Git logo by Jason Long',
    version: 'simple-icons 16.35.0 (git)',
    source: 'https://git-scm.com/downloads/logos',
    license: 'CC BY 3.0',
    licensePath: 'packages/ui-shared/src/icons/vendor/README.md',
  },
  {
    label: 'Inter',
    version: '4.001',
    source: 'https://github.com/rsms/inter',
    license: 'SIL Open Font License 1.1',
    licensePath: 'packages/ui-shared/src/assets/fonts/inter/LICENSE.txt',
  },
  {
    label: 'JetBrains Mono',
    version: '2.304',
    source: 'https://github.com/JetBrains/JetBrainsMono',
    license: 'SIL Open Font License 1.1',
    licensePath:
      'packages/ui-shared/src/assets/fonts/jetbrains-mono/LICENSE.txt',
  },
];

const LICENSE_FILE_PATTERN =
  /^(licen[sc]e|copying|notice|third[-_ ]?party[-_ ]?(notice|notices)?)(\..*)?$/i;
const MAX_NOTICE_FILE_BYTES = 256 * 1024;
const fatalUtf8Decoder = new TextDecoder('utf8', { fatal: true });

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function toPosix(path) {
  return path.split('\\').join('/');
}

function packageNameFromPath(lockPath, lockEntry, packageJson) {
  if (typeof lockEntry?.name === 'string' && lockEntry.name.length > 0) {
    return lockEntry.name;
  }
  if (typeof packageJson?.name === 'string' && packageJson.name.length > 0) {
    return packageJson.name;
  }

  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  if (index === -1) {
    return lockPath || 'canopy';
  }
  const tail = lockPath.slice(index + marker.length);
  if (tail.startsWith('@')) {
    const [scope, name] = tail.split('/');
    return `${scope}/${name}`;
  }
  return tail.split('/')[0];
}

function loadPackageJson(lockPath) {
  const packageJsonPath = join(root, lockPath, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }
  return readJson(packageJsonPath);
}

/**
 * The installed node_modules tree in the shape of a package-lock `packages`
 * map: keys are install paths, values carry the manifest fields the walk reads.
 * The flat layout (nodeLinker: hoisted) is the one npm produced. Workspace
 * links are leaves, as they were in the npm lockfile.
 */
function installedPackages() {
  const entries = new Map();
  const read = (installPath) => {
    const directory = join(root, installPath);
    if (
      installPath.includes('node_modules/') &&
      lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()
    ) {
      return { link: true };
    }
    const manifest = loadPackageJson(installPath);
    if (!manifest) {
      return undefined;
    }
    const license =
      typeof manifest.license === 'string'
        ? manifest.license
        : manifest.license?.type;
    return {
      name: manifest.name,
      version: manifest.version,
      license,
      dependencies: manifest.dependencies,
      optionalDependencies: manifest.optionalDependencies,
    };
  };
  return new Proxy(
    {},
    {
      get(_target, installPath) {
        if (typeof installPath !== 'string') {
          return undefined;
        }
        if (!entries.has(installPath)) {
          entries.set(installPath, read(installPath));
        }
        return entries.get(installPath);
      },
    },
  );
}

function dependencyNames(lockEntry) {
  return [
    ...Object.keys(lockEntry?.dependencies ?? {}),
    ...Object.keys(lockEntry?.optionalDependencies ?? {}),
  ].sort();
}

function parentLockPath(lockPath) {
  if (!lockPath) {
    return null;
  }
  const next = dirname(lockPath);
  return next === '.' ? '' : toPosix(next);
}

function resolveDependency(packages, fromLockPath, dependencyName) {
  let current = fromLockPath;
  while (current !== null) {
    const candidate = current
      ? `${current}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (packages[candidate]) {
      return candidate;
    }
    current = parentLockPath(current);
  }
  return null;
}

function collectProductionPackagePaths(lock) {
  const packages = lock.packages ?? {};
  const queue = [...PACKAGE_ROOTS];
  const visited = new Set();
  const externalPackagePaths = new Set();

  while (queue.length > 0) {
    const lockPath = queue.shift();
    if (visited.has(lockPath)) {
      continue;
    }
    visited.add(lockPath);

    const lockEntry = packages[lockPath];
    if (!lockEntry) {
      continue;
    }

    const isExternalPackage = lockPath.includes('node_modules/');
    if (
      isExternalPackage &&
      !existsSync(join(root, lockPath, 'package.json'))
    ) {
      continue;
    }

    if (isExternalPackage) {
      externalPackagePaths.add(lockPath);
    }

    for (const dependencyName of dependencyNames(lockEntry)) {
      const resolved = resolveDependency(packages, lockPath, dependencyName);
      if (resolved && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return [...externalPackagePaths].sort();
}

function findNoticeFiles(packageDir) {
  if (!existsSync(packageDir)) {
    return [];
  }
  return readdirSync(packageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function truncateUtf8Content(content, maxBytes) {
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return null;
  }

  for (let byteLength = maxBytes; byteLength >= 0; byteLength -= 1) {
    try {
      return fatalUtf8Decoder.decode(buffer.subarray(0, byteLength)).trimEnd();
    } catch {
      continue;
    }
  }

  return '';
}

function readNoticeFile(packageDir, fileName) {
  const path = join(packageDir, fileName);
  const content = readFileSync(path, 'utf8');
  const truncatedContent = truncateUtf8Content(content, MAX_NOTICE_FILE_BYTES);
  if (truncatedContent !== null) {
    return `${truncatedContent}\n\n[Notice file truncated by ${selectedBrand.displayName} because it exceeds ${MAX_NOTICE_FILE_BYTES} bytes. See ${relative(root, path)} for the complete text.]`;
  }
  return content.trimEnd();
}

function normalizeRepository(repository) {
  if (!repository) {
    return '';
  }
  if (typeof repository === 'string') {
    return repository;
  }
  if (typeof repository.url === 'string') {
    return repository.url;
  }
  return '';
}

function buildPackageNotices(lock) {
  const packages = lock.packages ?? {};
  const byIdentity = new Map();

  for (const lockPath of collectProductionPackagePaths(lock)) {
    const lockEntry = packages[lockPath];
    const packageJson = loadPackageJson(lockPath);
    const name = packageNameFromPath(lockPath, lockEntry, packageJson);
    const version =
      lockEntry.version ?? packageJson?.version ?? 'version unavailable';
    const identity = `${name}@${version}`;
    const packageDir = join(root, lockPath);
    const noticeFiles = findNoticeFiles(packageDir).map((fileName) => ({
      fileName,
      content: readNoticeFile(packageDir, fileName),
    }));
    const next = {
      name,
      version,
      license: lockEntry.license ?? packageJson?.license ?? 'Not specified',
      homepage: packageJson?.homepage ?? '',
      repository: normalizeRepository(packageJson?.repository),
      paths: [lockPath],
      noticeFiles,
    };

    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, next);
      continue;
    }
    existing.paths.push(lockPath);
    if (existing.noticeFiles.length === 0 && noticeFiles.length > 0) {
      existing.noticeFiles = noticeFiles;
    }
  }

  return [...byIdentity.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );
}

function buildBundledToolNotices(rootPackage) {
  return BUNDLED_TOOLS.map((tool) => {
    const source = rootPackage[tool.packageKey];
    return {
      ...tool,
      version:
        source?.[tool.versionKey] ?? tool.version ?? 'version unavailable',
    };
  });
}

function buildBundledAssetNotices() {
  return BUNDLED_ASSETS.map((asset) => ({
    ...asset,
    licenseText: readFileSync(join(root, asset.licensePath), 'utf8').trimEnd(),
  }));
}

function appendSection(lines, title) {
  lines.push('');
  lines.push(title);
  lines.push('='.repeat(title.length));
  lines.push('');
}

function renderNotices(
  rootPackage,
  packageNotices,
  bundledToolNotices,
  bundledAssetNotices,
) {
  const lines = [
    `${selectedBrand.displayName} Third-Party Notices`,
    '='.repeat(`${selectedBrand.displayName} Third-Party Notices`.length),
    '',
    `Generated from the installed dependency tree for ${selectedBrand.displayName} ${rootPackage.version ?? 'unknown'}.`,
    '',
    `This file summarizes third-party software and bundled command line tools distributed with ${selectedBrand.displayName} desktop and CLI builds. License text is copied from installed package metadata when available. If a package entry references upstream terms, those terms remain authoritative.`,
  ];

  appendSection(lines, 'Bundled command line tools');
  for (const tool of bundledToolNotices) {
    lines.push(`${tool.label}`);
    lines.push(`Version: ${tool.version}`);
    lines.push(`License: ${tool.license}`);
    lines.push(`Source: ${tool.source}`);
    if (tool.licensePath) {
      lines.push(`--- ${tool.licensePath} ---`);
      lines.push(readFileSync(join(root, tool.licensePath), 'utf8').trimEnd());
    }
    lines.push('');
  }

  appendSection(lines, 'Bundled fonts and assets');
  for (const asset of bundledAssetNotices) {
    lines.push(asset.label);
    lines.push(`Version: ${asset.version}`);
    lines.push(`License: ${asset.license}`);
    lines.push(`Source: ${asset.source}`);
    lines.push('');
    lines.push(`--- ${asset.licensePath} ---`);
    lines.push(asset.licenseText);
    lines.push('');
  }

  appendSection(lines, 'npm production dependencies');
  for (const notice of packageNotices) {
    lines.push(`${notice.name}`);
    lines.push(`Version: ${notice.version}`);
    lines.push(`License: ${notice.license}`);
    if (notice.homepage) {
      lines.push(`Homepage: ${notice.homepage}`);
    }
    if (notice.repository) {
      lines.push(`Repository: ${notice.repository}`);
    }
    lines.push(`Installed path: ${notice.paths.sort().join(', ')}`);

    if (notice.noticeFiles.length === 0) {
      lines.push('License file: Not found in installed package.');
      lines.push('');
      continue;
    }

    for (const file of notice.noticeFiles) {
      lines.push('');
      lines.push(`--- ${file.fileName} ---`);
      lines.push(file.content);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

assertMoonshineRuntimePin();
const rootPackage = readJson(join(root, 'package.json'));
const lock = { packages: installedPackages() };
const packageNotices = buildPackageNotices(lock);
const bundledToolNotices = buildBundledToolNotices(rootPackage);
const bundledAssetNotices = buildBundledAssetNotices();
const rendered = renderNotices(
  rootPackage,
  packageNotices,
  bundledToolNotices,
  bundledAssetNotices,
);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, rendered);

console.log(
  `Wrote ${relative(root, outputPath)} with ${packageNotices.length} package notices, ${bundledToolNotices.length} bundled tool notices, and ${bundledAssetNotices.length} bundled asset notices.`,
);
