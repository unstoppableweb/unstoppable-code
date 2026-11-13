import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  fchmod,
  fstatSync,
  fsync,
  lstatSync,
  openSync,
  rmSync,
  writeFile,
} from 'node:fs';
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  writeFile as writeFileHandle,
} from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  movedOwnedPath,
  isWithin,
  RelocationRefusedError,
  type RelocationTransition,
} from './transition';

import {
  assertRelocationWorkingRoot,
  relocationWorkingPath,
} from './working-root';

/** Worker-host Git execution; the offline core never launches a process. */
export type RelocationGit = (
  cwd: string,
  args: readonly string[],
) => Promise<string>;
export interface RelocationGitCheckout {
  readonly path: string;
  readonly commonDirectory: string;
  readonly head: string;
  readonly branch: string;
  /** sha256:<UTF-8 byte length>:<digest>; legacy journals contain porcelain text. */
  readonly status: string;
}
export interface RelocationBacklink {
  readonly path: string;
  readonly contents: string;
}
export interface RelocationGitPlan {
  readonly checkouts: readonly RelocationGitCheckout[];
  /** Individual-file preimages for B's journal or optional backups; never whole trees. */
  readonly backlinks: readonly RelocationBacklink[];
}

function statusEvidence(status: string): string {
  return `sha256:${Buffer.byteLength(status)}:${createHash('sha256').update(status).digest('hex')}`;
}

async function observe(
  git: RelocationGit,
  path: string,
  ignoredWorktrees: readonly string[] = [],
  reportedMissingPrunable?: Set<string>,
): Promise<RelocationGitCheckout> {
  let entry: string[] | undefined;
  for (const record of (
    await git(path, ['worktree', 'list', '--porcelain', '-z'])
  ).split('\0\0')) {
    const fields = record.split('\0');
    const listed = fields
      .find((field) => field.startsWith('worktree '))
      ?.slice(9);
    if (listed && ignoredWorktrees.some((root) => isWithin(root, listed)))
      continue;
    if (
      sep === '\\' &&
      (await isMissingPrunableGitWorktree(fields, reportedMissingPrunable))
    )
      continue;
    if (
      listed &&
      (sep === '\\'
        ? (await canonicalGitPath(listed, 'symlink-checkout')) === path
        : listed === path)
    )
      entry = fields;
  }
  const head = entry?.find((field) => field.startsWith('HEAD '))?.slice(5);
  const branch = entry?.includes('detached')
    ? 'HEAD'
    : entry?.find((field) => field.startsWith('branch '))?.slice(7);
  // The listing represents unborn HEAD with a zero OID; rev-parse HEAD refuses it.
  if (!head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) || !branch)
    throw new RelocationRefusedError('unreadable-git-checkout', path);
  return {
    path,
    commonDirectory: await canonicalGitPath(
      (
        await git(path, [
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ])
      ).replace(/\r?\n$/, ''),
      'symlink-common-directory',
    ),
    head,
    branch,
    status: statusEvidence(
      await git(path, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]),
    ),
  };
}

/** A missing prunable entry has no checkout or backlink to relocate. */
export async function isMissingPrunableGitWorktree(
  fields: readonly string[],
  reported?: Set<string>,
): Promise<boolean> {
  const path = fields.find((field) => field.startsWith('worktree '))?.slice(9);
  if (
    !path ||
    !fields.some(
      (field) => field === 'prunable' || field.startsWith('prunable '),
    )
  )
    return false;
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error;
    if (!reported?.has(path))
      process.stderr.write(
        `Internal-root migration: skipping absent prunable Git worktree ${JSON.stringify(path)}.\n`,
      );
    reported?.add(path);
    return true;
  }
}

/** Run before copying, under B's cold-maintenance proof. No file is changed. */
export async function prepareRelocationGit(
  git: RelocationGit,
  paths: readonly string[],
  options: {
    readonly portableFilesystem?: boolean;
    readonly reportedMissingPrunable?: Set<string>;
    readonly ignoredWorktrees?: readonly string[];
  } = {},
): Promise<RelocationGitPlan> {
  const checkouts: RelocationGitCheckout[] = [];
  const backlinks = new Map<string, string>();
  for (const requestedPath of new Set(paths)) {
    if (options.ignoredWorktrees?.some((root) => isWithin(root, requestedPath)))
      continue;
    const path = await canonicalGitPath(requestedPath, 'symlink-checkout');
    if (checkouts.some((checkout) => checkout.path === path)) continue;
    const dotGit = join(path, '.git');
    const dotGitState = await lstat(dotGit);
    if (
      dotGitState.isSymbolicLink() ||
      (dotGitState.isFile() && dotGitState.nlink !== 1)
    )
      throw new RelocationRefusedError('symlink-git-directory', dotGit);
    const checkout = await observe(
      git,
      path,
      options.ignoredWorktrees,
      options.reportedMissingPrunable,
    );
    if (options.portableFilesystem) {
      const configuration = await git(path, ['config', '--null', '--list']);
      if (
        configuration
          .split('\0')
          .some((record) =>
            ['core.worktree', 'extensions.worktreeconfig'].includes(
              record.split('\n')[0]?.toLowerCase() ?? '',
            ),
          )
      )
        throw new RelocationRefusedError(
          'unsupported-git-worktree-config',
          path,
        );
      for (const unsupported of [
        join(path, '.gitmodules'),
        join(checkout.commonDirectory, 'modules'),
        join(checkout.commonDirectory, 'config.worktree'),
        join(checkout.commonDirectory, 'objects', 'info', 'alternates'),
      ]) {
        if (await present(unsupported))
          throw new RelocationRefusedError(
            'unsupported-git-layout',
            unsupported,
          );
      }
    }
    if (
      options.portableFilesystem &&
      (await git(path, ['ls-files', '--stage', '-z']))
        .split('\0')
        .some((entry) => entry.startsWith('160000 '))
    )
      throw new RelocationRefusedError('unsupported-git-submodule', path);
    checkouts.push(checkout);
    if (dotGitState.isFile()) {
      backlinks.set(dotGit, await readFile(dotGit, 'utf8'));
      const gitDir = await canonicalGitPath(
        (await git(path, ['rev-parse', '--absolute-git-dir'])).replace(
          /\r?\n$/,
          '',
        ),
      );
      if (options.portableFilesystem && gitDir === checkout.commonDirectory)
        throw new RelocationRefusedError(
          'unsupported-separate-git-directory',
          dotGit,
        );
      if (
        options.portableFilesystem &&
        (await present(join(gitDir, 'config.worktree')))
      )
        throw new RelocationRefusedError(
          'unsupported-git-worktree-config',
          path,
        );
      for (const file of ['gitdir', 'commondir']) {
        const target = join(gitDir, file);
        await canonicalGitPath(target, 'symlink-backlink');
        const targetState = await lstat(target);
        if (!targetState.isFile() || targetState.nlink !== 1)
          throw new RelocationRefusedError('symlink-backlink', target);
        backlinks.set(target, await readFile(target, 'utf8'));
      }
    }
  }
  // Every linked checkout must be inventoried, including ones outside the root.
  for (const common of new Set(checkouts.map((row) => row.commonDirectory))) {
    const checkout = checkouts.find((row) => row.commonDirectory === common);
    if (!checkout)
      throw new RelocationRefusedError('missing-git-checkout', common);
    const listed = await git(checkout.path, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ]);
    const represented = new Set(checkouts.map((row) => row.path));
    for (const record of listed.split('\0\0')) {
      const fields = record.split('\0');
      if (
        fields.some(
          (field) =>
            field.startsWith('worktree ') &&
            options.ignoredWorktrees?.some((root) =>
              isWithin(root, field.slice(9)),
            ),
        ) ||
        fields.includes('bare') ||
        (await isMissingPrunableGitWorktree(
          fields,
          options.reportedMissingPrunable,
        ))
      )
        continue;
      for (const field of fields) {
        if (
          field.startsWith('worktree ') &&
          !represented.has(
            sep === '\\'
              ? await canonicalGitPath(field.slice(9), 'symlink-checkout')
              : field.slice(9),
          )
        )
          throw new RelocationRefusedError(
            'uninventoried-git-checkout',
            field.slice(9),
          );
      }
    }
  }
  return {
    checkouts,
    backlinks: [...backlinks].map(([path, contents]) => ({ path, contents })),
  };
}

/** A failed write leaves a complete preimage; a failed publish is safe to resume. */
async function replaceBacklink(image: RelocationBacklink): Promise<void> {
  const temp = join(
    dirname(image.path),
    `.${basename(image.path)}.relocation-${randomUUID()}.tmp`,
  );
  // CopyFile preserves Windows attributes (notably Git's hidden .git files).
  // CREATE_ALWAYS cannot overwrite hidden files; update only the private temp.
  const windows = sep === '\\';
  const mode = (await lstat(image.path)).mode & 0o777;
  // Establish ownership without yielding: even a lost open completion must clean up.
  if (windows) copyFileSync(image.path, temp, constants.COPYFILE_EXCL);
  const fd = windows ? undefined : openSync(temp, 'wx', 0o600);
  try {
    const identity =
      fd === undefined
        ? lstatSync(temp, { bigint: true })
        : fstatSync(fd, { bigint: true });
    const cleanupOnExit = (): void => {
      const current = lstatSync(temp, { bigint: true, throwIfNoEntry: false });
      // A completed rename may have lost its callback; the path could be reused.
      if (current?.dev === identity.dev && current.ino === identity.ino)
        rmSync(temp, { force: true });
    };
    process.once('exit', cleanupOnExit);
    try {
      if (fd === undefined) {
        const handle = await open(temp, 'r+');
        try {
          const opened = await handle.stat({ bigint: true });
          if (opened.dev !== identity.dev || opened.ino !== identity.ino)
            throw new RelocationRefusedError('git-backlink-temp-changed', temp);
          await writeFileHandle(handle, image.contents);
          await handle.truncate(Buffer.byteLength(image.contents));
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else {
        // Keep the exclusive descriptor: a writable parent permits path substitution.
        await promisify(writeFile)(fd, image.contents);
        await promisify(fchmod)(fd, mode);
        await promisify(fsync)(fd);
      }
      const current = lstatSync(temp, { bigint: true, throwIfNoEntry: false });
      if (current?.dev !== identity.dev || current.ino !== identity.ino)
        throw new RelocationRefusedError('git-backlink-temp-changed', temp);
      await rename(temp, image.path);
    } finally {
      try {
        cleanupOnExit();
      } finally {
        process.removeListener('exit', cleanupOnExit);
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Repair only inventoried backlink files; Git repair would persist staging paths. */
export async function repairRelocationGit(
  transition: RelocationTransition,
  plan: RelocationGitPlan,
  workingRoot: string,
  replace: (image: RelocationBacklink) => Promise<void> = replaceBacklink,
): Promise<void> {
  await assertRelocationWorkingRoot(transition, workingRoot);
  const writes: RelocationBacklink[] = [];
  const expected: RelocationBacklink[] = [];
  const postimages = await projectRelocationBacklinks(transition, plan);
  for (const [index, image] of plan.backlinks.entries()) {
    const postimage = postimages[index];
    if (!postimage)
      throw new RelocationRefusedError('missing-git-postimage', image.path);
    const finalPath = postimage.path;
    const contents = postimage.contents;
    const path = relocationWorkingPath(transition, workingRoot, finalPath);
    await canonicalGitPath(path, 'symlink-backlink');
    if (!(await lstat(path)).isFile())
      throw new RelocationRefusedError('symlink-backlink', path);
    const current = await readFile(path, 'utf8');
    if (current !== image.contents && current !== contents)
      throw new RelocationRefusedError('git-backlink-changed', path);
    expected.push({ path, contents });
    if (current !== contents) {
      if (isWithin(transition.from.canonicalDataRoot, path))
        throw new RelocationRefusedError('source-git-backlink', path);
      writes.push({ path, contents });
    }
  }
  for (const image of writes) await replace(image);
  for (const image of expected) {
    if ((await readFile(image.path, 'utf8')) !== image.contents)
      throw new RelocationRefusedError('git-verification-failed', image.path);
  }
}

/** Frozen final-path postimages, shared by repair and read-only verification. */
export async function projectRelocationBacklinks(
  transition: RelocationTransition,
  plan: RelocationGitPlan,
  /** Recovery projects frozen images even when a checkout/admin target was pruned. */
  allowMissingTargets = false,
): Promise<readonly RelocationBacklink[]> {
  const expected: RelocationBacklink[] = [];
  for (const image of plan.backlinks) {
    const isCheckout = plan.checkouts.some(
      (row) => join(row.path, '.git') === image.path,
    );
    const name = basename(image.path);
    if (!isCheckout && name !== 'gitdir' && name !== 'commondir')
      throw new RelocationRefusedError('unrecognized-git-backlink', image.path);
    const prefix = isCheckout ? 'gitdir: ' : '';
    if (!image.contents.startsWith(prefix))
      throw new RelocationRefusedError('unreadable-git-backlink', image.path);
    const text = image.contents.slice(prefix.length).replace(/\r?\n$/, '');
    if (!text || text.includes('\0'))
      throw new RelocationRefusedError('unreadable-git-backlink', image.path);
    const resolvedTarget = resolveGitBacklink(dirname(image.path), text);
    const target =
      sep === '\\'
        ? await canonicalGitPath(
            resolvedTarget,
            'symlink-git-directory',
            allowMissingTargets,
          )
        : resolvedTarget;
    if (
      (name === 'gitdir' &&
        !isCheckout &&
        !plan.checkouts.some((row) => join(row.path, '.git') === target)) ||
      (name === 'commondir' &&
        !plan.checkouts.some((row) => row.commonDirectory === target))
    )
      throw new RelocationRefusedError('unproven-git-backlink', image.path);
    const finalPath = movedOwnedPath(transition, image.path);
    const finalTarget = movedOwnedPath(transition, target);
    const contents =
      finalPath === image.path && finalTarget === target
        ? image.contents
        : `${prefix}${gitBacklinkText(dirname(finalPath), finalTarget, isAbsolute(text))}\n`;
    expected.push({ path: finalPath, contents });
  }
  return expected;
}

/** No optional index writes: the trusted worker's Git port disables optional locks. */
export async function qualifyRelocationGit(
  git: RelocationGit,
  transition: RelocationTransition,
  plan: RelocationGitPlan,
  options: {
    readonly portableFilesystem?: boolean;
    readonly ignoredWorktrees?: readonly string[];
  } = {},
): Promise<void> {
  const expected = plan.checkouts.map((row) => ({
    ...row,
    // Normalize only for comparison: rewriting old plans breaks sidecar fingerprints.
    status: /^sha256:\d+:[a-f0-9]{64}$/.test(row.status)
      ? row.status
      : statusEvidence(row.status),
    path: movedOwnedPath(transition, row.path),
    commonDirectory: movedOwnedPath(transition, row.commonDirectory),
  }));
  const actual = await prepareRelocationGit(
    git,
    expected.map((row) => row.path),
    options,
  );
  if (JSON.stringify(actual.checkouts) !== JSON.stringify(expected))
    throw new RelocationRefusedError('published-git-state-changed');
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return false;
    throw error;
  }
}

function resolveGitBacklink(parent: string, text: string): string {
  // Drive-relative and device namespace names are not Git-owned path evidence.
  if (sep === '\\' && (/^[A-Za-z]:(?![\\/])/.test(text) || /^[\\/]/.test(text)))
    throw new RelocationRefusedError('noncanonical-git-backlink', parent);
  return resolve(parent, text);
}

/** Git accepts an absolute cross-drive target when relative() cannot express it. */
export function gitBacklinkText(
  parent: string,
  target: string,
  absolute: boolean,
): string {
  const value = absolute ? target : relative(parent, target);
  return sep === '\\' ? value.replace(/\\/g, '/') : value;
}

async function canonicalGitPath(
  path: string,
  reason = 'symlink-git-directory',
  allowMissing = false,
): Promise<string> {
  if (sep === '\\') {
    // Git's separators, case and 8.3 names are spellings, not link evidence.
    if (
      path.includes('\0') ||
      !/^(?:[A-Za-z]:[\\/]|[\\/]{2}(?![?.][\\/])[^\\/]+[\\/]+[^\\/])/.test(path)
    )
      throw new TypeError(
        `Git paths must be fully qualified: ${JSON.stringify(path)}`,
      );
    try {
      for (let component = resolve(path); ; component = dirname(component)) {
        if ((await lstat(component)).isSymbolicLink())
          throw new RelocationRefusedError(reason, path);
        if (dirname(component) === component) break;
      }
      return await realpath(path);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        if (allowMissing && dirname(path) !== path)
          return join(
            await canonicalGitPath(dirname(path), reason, true),
            basename(path),
          );
        throw new RelocationRefusedError(reason, path);
      }
      throw error;
    }
  }
  const canonical = await realpath(path);
  if (canonical !== path) throw new RelocationRefusedError(reason, path);
  return canonical;
}
