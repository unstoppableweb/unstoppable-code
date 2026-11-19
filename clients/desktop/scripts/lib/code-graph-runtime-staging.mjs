/**
 * Stages the code-graph runtime beside a standalone executable: a real
 * `resources/code-graph/` directory and the externalized `web-tree-sitter` and
 * `typescript` packages under `node_modules/`, which a SEA resolves from its
 * own directory. The `typescript` package is a wrapper that requires
 * `@typescript/old`, so that package is staged too.
 *
 * `build:cli` stages this beside every CLI and `build:core-daemon` beside the
 * daemon (CAN-5072, CAN-5089); both ship it, so both use this one copy. Every
 * target excludes `.map` files, matching afterPack's no-source-map payload.
 * Linux targets also blank source-map directive comments in the copied
 * JS/CJS/MJS, which the Linux package policy refuses (`contents.source-map`).
 * Other targets keep the copied bytes. Source packages are never written.
 */
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CODE_GRAPH_RUNTIME_MODULES } from '../../packages/core-platform/src/execution-host/daemon-payload.ts';
import { blankSourceMapDirectives } from './source-map-directives.mjs';

/** Whether `path` names a source map file (case-insensitive). */
export function isSourceMapFile(path) {
  return /\.map$/i.test(basename(path));
}

function blankCopiedJavaScript(path) {
  const source = readFileSync(path, 'utf8');
  const blanked = blankSourceMapDirectives(source, path);
  if (blanked === source) return;
  // Replace only the destination copy, including read-only vendor JS, with
  // the original permission bits. Never grant write access to source packages.
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, blanked, { flag: 'wx' });
    chmodSync(temporaryPath, lstatSync(path).mode & 0o7777);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/** Blanks source-map directives in every copied JS/CJS/MJS file below `path`. */
export function blankSourceMapDirectivesInTree(path) {
  const info = lstatSync(path);
  // Never follow a copied link back into a source package. Linux release
  // validation separately refuses links; other staging contracts stay intact.
  if (info.isDirectory()) {
    for (const name of readdirSync(path))
      blankSourceMapDirectivesInTree(join(path, name));
  } else if (info.isFile() && /\.(?:js|cjs|mjs)$/i.test(path)) {
    blankCopiedJavaScript(path);
  }
}

/**
 * Replaces `targetDir`'s `resources/code-graph/` and staged runtime packages
 * with fresh copies from the checkout at `root`, prepared for `target`
 * (`<platform>-<arch>`, or null for a host without a release target).
 */
export function stageCodeGraphRuntime({ root, targetDir, target }) {
  const linuxTarget = target?.startsWith('linux-') ?? false;
  const copyOptions = {
    recursive: true,
    filter: (sourcePath) => !isSourceMapFile(sourcePath),
  };
  const copy = (source, destination) => {
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, copyOptions);
    if (linuxTarget) blankSourceMapDirectivesInTree(destination);
  };
  copy(
    join(root, 'packages', 'desktop-shared', 'resources', 'code-graph'),
    join(targetDir, 'resources', 'code-graph'),
  );
  const nodeModules = join(targetDir, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });
  // The native TypeScript 7 compiler is a build tool, never runtime.
  rmSync(join(nodeModules, '@typescript', 'native'), {
    recursive: true,
    force: true,
  });
  for (const name of CODE_GRAPH_RUNTIME_MODULES)
    copy(join(root, 'node_modules', name), join(nodeModules, name));
}
