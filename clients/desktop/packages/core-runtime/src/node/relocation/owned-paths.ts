import {
  lstat,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  isWithin,
  movedOwnedPath,
  RelocationRefusedError,
  type RelocationTransition,
} from './transition';

import {
  assertRelocationWorkingRoot,
  relocationWorkingPath,
} from './working-root';

interface CarriedLinks {
  /** Read-only inventory uses source bytes with destination path semantics. */
  readonly source?: boolean;
  /** Only pre-repair proof may project source-root absolute link text. */
  readonly projectSourceTargets?: boolean;
  /** Final checkout roots whose payload link bytes must preserve frozen Git status. */
  readonly preserveSourceTargetsWithin?: readonly string[];
}

function preservesSourceTarget(carried: CarriedLinks, link: string): boolean {
  return !!carried.preserveSourceTargetsWithin?.some((root) =>
    isWithin(root, link),
  );
}

function linkDetail(root: string, path: string, target: string): string {
  return `link ${JSON.stringify(relative(root, path).slice(0, 350))} -> ${JSON.stringify(target.slice(0, 350))}`;
}

function physicalPath(
  transition: RelocationTransition,
  workingRoot: string,
  path: string,
  published: boolean,
  carried?: CarriedLinks,
): string {
  if (carried?.source)
    return isWithin(transition.to.canonicalDataRoot, path)
      ? join(
          transition.from.canonicalDataRoot,
          relative(transition.to.canonicalDataRoot, path),
        )
      : path;
  return published
    ? path
    : relocationWorkingPath(transition, workingRoot, path);
}

interface CarriedLinkProjection {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly preserve: boolean;
}

function projectedLinkText(
  transition: RelocationTransition,
  text: string,
  project: boolean,
): string {
  if (!isAbsolute(text)) return text;
  const source = transition.from.canonicalDataRoot;
  if (
    text !== source &&
    !text.startsWith(`${source}${sep}`) &&
    !isWithin(source, text)
  )
    return text;
  // Normalizing before checking components could hide a symlink/.. traversal.
  if (!project) throw new RelocationRefusedError('stale-owned-link');
  if (resolve(text) !== text)
    throw new RelocationRefusedError('noncanonical-owned-link-target');
  return movedOwnedPath(transition, text);
}

/** Prove carried payload links using virtual destination targets, never external traversal. */
async function isCarriedLink(
  transition: RelocationTransition,
  workingRoot: string,
  link: string,
  text: string,
  published: boolean,
  carried: CarriedLinks,
  onProgress?: (detail: string) => void,
): Promise<boolean> {
  const root = transition.to.canonicalDataRoot;
  if (!isWithin(root, link)) return false;
  let current = dirname(link);
  const projectTarget = (path: string, target: string): string =>
    projectedLinkText(
      transition,
      target,
      !!(carried.source || carried.projectSourceTargets) ||
        preservesSourceTarget(carried, path),
    );
  let pending: (string | { completed: string })[] = [projectTarget(link, text)];
  const active = new Set<string>();
  while (pending.length) {
    const target = pending.shift();
    if (target === undefined) break;
    if (typeof target !== 'string') {
      active.delete(target.completed);
      continue;
    }
    if (isAbsolute(target)) {
      const projected = target;
      if (!projected.startsWith(`${root}${sep}`) && projected !== root) {
        // External absolute pointers are opaque payload, never a traversal grant.
        return pending.every(
          (part) => typeof part !== 'string' || !part || part === '.',
        );
      }
      current = root;
      pending = [
        ...projected.slice(root.length).split(sep === '\\' ? /[\\/]/ : '/'),
        ...pending,
      ];
      continue;
    }
    if (parse(target).root)
      throw new RelocationRefusedError('noncanonical-owned-link-target');
    const parts = target.split(sep === '\\' ? /[\\/]/ : '/');
    if (parts.length > 1) {
      pending = [...parts, ...pending];
      continue;
    }
    if (!target || target === '.') continue;
    current = target === '..' ? dirname(current) : join(current, target);
    if (isWithin(transition.from.canonicalDataRoot, current))
      throw new RelocationRefusedError('stale-owned-link');
    if (!isWithin(root, current)) return false;
    const actual = physicalPath(
      transition,
      workingRoot,
      current,
      published,
      carried,
    );
    const state = await lstat(actual).catch((error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      )
        return null;
      throw error;
    });
    onProgress?.('checked carried link component');
    if (!state) {
      // Dangling links are payload, not repair targets. Still check lexical escapes.
      continue;
    }
    if (state.isSymbolicLink()) {
      // A cycle cannot consume the remaining suffix; carry it without dereferencing.
      if (active.has(current)) return true;
      active.add(current);
      pending.unshift(projectTarget(current, await readlink(actual)), {
        completed: current,
      });
      current = dirname(current);
    }
  }
  return true;
}

async function checkedLinkTarget(
  transition: RelocationTransition,
  workingRoot: string,
  link: string,
  text: string,
  paths: ReadonlySet<string>,
  prefixes: ReadonlySet<string>,
  published: boolean,
  carried?: CarriedLinks,
  onProgress?: (detail: string) => void,
): Promise<string | undefined> {
  if (
    carried &&
    (await isCarriedLink(
      transition,
      workingRoot,
      link,
      text,
      published,
      carried,
      onProgress,
    ))
  )
    return undefined;
  const root = parse(text).root;
  if (root && !isAbsolute(text))
    throw new RelocationRefusedError('noncanonical-owned-link-target');
  const parts = text.slice(root.length).split(sep === '\\' ? /[\\/]/ : '/');
  let target = isAbsolute(text) ? root : dirname(link);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === '' || part === '.') continue;
    target = part === '..' ? dirname(target) : join(target, part);
    if (isWithin(transition.from.canonicalDataRoot, target))
      throw new RelocationRefusedError('stale-owned-link');
    if (!prefixes.has(target))
      throw new RelocationRefusedError('unproven-owned-link-target');
    if (index !== parts.length - 1 && part !== '..') {
      // Check before consuming ..: lexical normalization can hide a link traversal.
      const actual = physicalPath(
        transition,
        workingRoot,
        target,
        published,
        carried,
      );
      const state = await lstat(actual);
      onProgress?.('checked owned link parent');
      if (state.isSymbolicLink())
        throw new RelocationRefusedError('symlink-owned-parent');
      if (!state.isDirectory())
        throw new RelocationRefusedError('nondirectory-owned-parent');
      if ((await realpath(actual)) !== actual)
        throw new RelocationRefusedError('noncanonical-owned-path');
    }
  }
  if (!paths.has(target))
    throw new RelocationRefusedError('unproven-owned-link-target');
  return target;
}

/** Read inventoried paths; carried payload links grant no metadata repair authority. */
async function inspectOwnedPaths(
  transition: RelocationTransition,
  ownedPaths: readonly string[],
  workingRoot: string,
  published = false,
  carried?: CarriedLinks,
  onProgress?: (detail: string) => void,
): Promise<readonly CarriedLinkProjection[]> {
  const root = transition.to.canonicalDataRoot;
  if (carried?.source) {
    if (
      workingRoot !== transition.from.canonicalDataRoot ||
      !(await lstat(workingRoot)).isDirectory() ||
      (await realpath(workingRoot)) !== workingRoot
    )
      throw new RelocationRefusedError('noncanonical-source-root');
  } else if (published) {
    if (
      workingRoot !== root ||
      !(await lstat(root)).isDirectory() ||
      (await realpath(root)) !== root
    )
      throw new RelocationRefusedError('noncanonical-published-root');
  } else await assertRelocationWorkingRoot(transition, workingRoot);
  const paths = new Set(
    ownedPaths.map((path) => movedOwnedPath(transition, path)),
  );
  let entries = 0;
  const visit = async (path: string): Promise<void> => {
    const actual = physicalPath(
      transition,
      workingRoot,
      path,
      published,
      carried,
    );
    const state = await lstat(actual);
    onProgress?.(`scanned ${++entries} relocated entries`);
    if (state.isSymbolicLink()) {
      paths.add(path);
    } else if (state.isDirectory()) {
      if ((await realpath(actual)) !== actual)
        throw new RelocationRefusedError('noncanonical-owned-path');
      for (const entry of await readdir(actual, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink())
          await visit(join(path, entry.name));
        else onProgress?.(`scanned ${++entries} relocated entries`);
      }
    }
  };
  // Enumerate link payload only, including opaque folders and legacy frozen plans.
  // This does not grant Git discovery or W5 metadata ownership.
  if (carried) await visit(root);
  const prefixes = new Set<string>();
  for (const path of paths) {
    let current = path;
    while (!prefixes.has(current)) {
      prefixes.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const projections: CarriedLinkProjection[] = [];
  const links = new Map<string, string>();
  const linkTexts = new Map<string, string>();
  for (const path of paths) {
    if (path === root) continue;
    const base = isWithin(root, path) ? root : parse(path).root;
    const parts = relative(base, path).split(sep);
    let current = base;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      const actual = physicalPath(
        transition,
        workingRoot,
        current,
        published,
        carried,
      );
      const state = await lstat(actual).catch((error: unknown) => {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return null;
        throw error;
      });
      onProgress?.('checked relocated owner path');
      // Archived owner paths may already be absent.
      if (!state) {
        if ((await realpath(dirname(actual))) !== dirname(actual))
          throw new RelocationRefusedError('noncanonical-owned-path');
        break;
      }
      if (state.isSymbolicLink()) {
        if ((await realpath(dirname(actual))) !== dirname(actual))
          throw new RelocationRefusedError('noncanonical-owned-path');
        const text = await readlink(actual);
        linkTexts.set(current, text);
        try {
          const target = await checkedLinkTarget(
            transition,
            workingRoot,
            current,
            text,
            paths,
            prefixes,
            published,
            carried,
            onProgress,
          );
          if (index !== parts.length - 1)
            throw new RelocationRefusedError('symlink-owned-parent');
          if (target !== undefined) links.set(path, target);
          if (carried && isWithin(root, current)) {
            const preserve = preservesSourceTarget(carried, current);
            const after = projectedLinkText(
              transition,
              text,
              !!(carried.source || carried.projectSourceTargets) || preserve,
            );
            if (after !== text)
              projections.push({ path: actual, before: text, after, preserve });
          }
        } catch (error) {
          throw new RelocationRefusedError(
            error instanceof RelocationRefusedError
              ? error.reason
              : 'unreadable-owned-link-target',
            linkDetail(root, current, text),
          );
        }
      } else if (index !== parts.length - 1 && !state.isDirectory()) {
        throw new RelocationRefusedError('nondirectory-owned-parent');
      } else if (
        index === parts.length - 1 &&
        (await realpath(actual)) !== actual
      ) {
        throw new RelocationRefusedError('noncanonical-owned-path');
      }
    }
  }
  const checked = new Set<string>();
  for (const path of links.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = path;
    while (current !== undefined && !checked.has(current)) {
      if (seen.has(current))
        throw new RelocationRefusedError(
          'cyclic-owned-link',
          linkDetail(root, current, linkTexts.get(current) ?? ''),
        );
      seen.add(current);
      current = links.get(current);
    }
    for (const path of seen) checked.add(path);
  }
  return projections;
}

/** Read-only proof; source inventory models the pending destination-only projection. */
export async function assertRelocationOwnedPathsSafe(
  transition: RelocationTransition,
  ownedPaths: readonly string[],
  workingRoot: string,
  published = false,
  carried?: CarriedLinks,
  onProgress?: (detail: string) => void,
): Promise<void> {
  await inspectOwnedPaths(
    transition,
    ownedPaths,
    workingRoot,
    published,
    carried,
    onProgress,
  );
}

/** Repair only private-copy link objects, after proving every link and owner parent. */
export async function repairRelocationCarriedLinks(
  transition: RelocationTransition,
  ownedPaths: readonly string[],
  workingRoot: string,
  preserveSourceTargetsWithin: readonly string[] = [],
  onProgress?: (detail: string) => void,
): Promise<void> {
  const projections = await inspectOwnedPaths(
    transition,
    ownedPaths,
    workingRoot,
    false,
    {
      projectSourceTargets: true,
      preserveSourceTargetsWithin,
    },
    onProgress,
  );
  let preserved = 0;
  for (const image of projections) {
    if ((await readlink(image.path)) !== image.before)
      throw new RelocationRefusedError(
        'changed-owned-link',
        linkDetail(workingRoot, image.path, image.before),
      );
    onProgress?.('revalidated carried link');
    if (image.preserve) {
      if (preserved++ < 20)
        process.stderr.write(
          `Internal-root migration: retaining checkout absolute link to the retained source root: ${linkDetail(workingRoot, image.path, image.before)}.\n`,
        );
      continue;
    }
    const temporary = join(
      dirname(image.path),
      `.relocation-link-${randomUUID()}`,
    );
    let created = false;
    try {
      await symlink(image.after, temporary);
      created = true;
      await rename(temporary, image.path);
      onProgress?.('repaired carried link');
      created = false;
    } finally {
      if (created) await rm(temporary, { force: true });
    }
  }
  if (preserved > 20)
    process.stderr.write(
      `Internal-root migration: ${preserved - 20} additional checkout absolute links retain source-root targets.\n`,
    );
}
