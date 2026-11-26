import { AsyncLocalStorage } from 'node:async_hooks';
import { devNull } from 'node:os';
import { resolve } from 'node:path';
import {
  AMBIGUOUS_FILTER_DRIVER_OVERRIDES,
  archiveGitEnv,
  assertNoExternalTransformingAttributeInTrees,
  refExists,
  resolveTreeId,
  type GitCommandScope,
} from './git-tree-snapshot';

const attributeSourceStorage = new AsyncLocalStorage<
  ReadonlyMap<string, string>
>();

/**
 * CAN-6776: runs `work` so each `git worktree add` that `git.ts`'s `runGit`
 * starts in one of `sources`' repository paths reads `.gitattributes` from
 * that path's tree instead of the checkout. An archive restore uses it so the
 * destination's initial checkout already moves bytes unchanged, and refuses
 * a start point an external attribute would transform. Limited to
 * that subcommand: a timer or status read that inherits the async call chain
 * keeps Git's normal attribute lookup.
 */
export function runWithGitAttributeSources<T>(
  sources: ReadonlyMap<string, string>,
  work: () => T,
): T {
  if (sources.size === 0) return work();
  return attributeSourceStorage.run(
    new Map(
      Array.from(sources, ([repoPath, source]) => [resolve(repoPath), source]),
    ),
    work,
  );
}

function isWorktreeAdd(args: readonly string[]): boolean {
  const index = args.indexOf('worktree');
  return index >= 0 && args[index + 1] === 'add';
}

function scopedAttributeSource(
  cwd: string | undefined,
  args: readonly string[],
): string | undefined {
  const sources = attributeSourceStorage.getStore();
  return sources && cwd !== undefined && isWorktreeAdd(args)
    ? sources.get(resolve(cwd))
    : undefined;
}

const WORKTREE_ADD_VALUE_OPTIONS = new Set(['-b', '-B', '--reason']);
const WORKTREE_ADD_NO_ATTACH_OPTIONS = new Set([
  '-b',
  '-B',
  '-d',
  '--detach',
  '--orphan',
]);

interface WorktreeAddStartPoint {
  /** The branch Git attaches, and checks out, when that exact ref exists. */
  attachRef?: string;
  /** Otherwise the commit-ish Git checks out, by revision lookup. */
  commitish: string;
}

/**
 * What `git worktree add <path> [<commit-ish>]` checks out. Without `-b`,
 * `-B`, `--detach` or `--orphan`, Git attaches `refs/heads/<commit-ish>` when
 * that exact ref exists, even when a same-named tag would win a revision
 * lookup. Without a commit-ish Git starts from HEAD; the desktop always names
 * one.
 */
function worktreeAddStartPoint(args: readonly string[]): WorktreeAddStartPoint {
  const positional: string[] = [];
  let optionsEnded = false;
  let attaches = true;
  for (let index = args.indexOf('worktree') + 2; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) break;
    if (optionsEnded || !arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    if (arg === '--') optionsEnded = true;
    if (WORKTREE_ADD_NO_ATTACH_OPTIONS.has(arg)) attaches = false;
    if (WORKTREE_ADD_VALUE_OPTIONS.has(arg)) index++;
  }
  const commitish = positional[1];
  if (commitish === undefined) return { commitish: 'HEAD' };
  return attaches
    ? { attachRef: `refs/heads/${commitish}`, commitish }
    : { commitish };
}

/**
 * The one state a scoped `worktree add` runs under and its start-point check
 * reads trees and attributes under, so the check covers exactly the paths and
 * attributes the checkout writes. In-tree attributes come from the attribute
 * source, and `core.attributesFile` is ignored: configuration
 * (`includeIf onbranch:`, for one) is the only way the destination's
 * attributes can differ from the reference repository's, and ignoring it,
 * rather than adding the worktree with `--no-checkout`, keeps a
 * branch-specific filter from running before replay refuses it. For the same
 * reason a driver named `unset` or `unspecified`, which an external `-filter`
 * can select, is emptied and made optional. System attributes are skipped
 * with the user file, whose macros or `-filter` could otherwise mask one of
 * them. Both start from `archiveGitEnv`, as every archive read does:
 * replacement objects are off, so a replace ref cannot swap in a tree the
 * check never read, and an inherited repository, object directory or
 * configuration variable cannot point the checkout at state the check did not
 * read.
 */
function scopedCheckoutGit(attributeSource: string): GitCommandScope {
  return {
    config: [
      '-c',
      `core.attributesFile=${devNull}`,
      ...AMBIGUOUS_FILTER_DRIVER_OVERRIDES,
    ],
    env: {
      GIT_ATTR_SOURCE: attributeSource,
      GIT_ATTR_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
    },
  };
}

/**
 * The arguments `runGit` launches `args` with, and the environment it builds
 * from the one it would otherwise use.
 */
export function scopedWorktreeAddLaunch(
  cwd: string | undefined,
  args: string[],
): {
  args: string[];
  env: (launchEnv: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
} {
  const attributeSource = scopedAttributeSource(cwd, args);
  if (attributeSource === undefined)
    return { args, env: (launchEnv) => launchEnv };
  const scope = scopedCheckoutGit(attributeSource);
  return {
    args: [...scope.config, ...args],
    env: (launchEnv) => ({ ...archiveGitEnv(launchEnv), ...scope.env }),
  };
}

async function assertStartPointAttributes(
  repoPath: string,
  startPoint: WorktreeAddStartPoint,
  attributeSource: string,
): Promise<void> {
  const scope = scopedCheckoutGit(attributeSource);
  const checked =
    startPoint.attachRef !== undefined &&
    (await refExists(repoPath, startPoint.attachRef, scope))
      ? startPoint.attachRef
      : startPoint.commitish;
  const tree = await resolveTreeId(repoPath, checked, scope);
  // An unresolvable start point is left to `worktree add` to report.
  if (tree === undefined) return;
  await assertNoExternalTransformingAttributeInTrees(
    repoPath,
    [tree],
    attributeSource,
    scope,
  );
}

/**
 * Before a scoped `worktree add` creates its checkout: refuses, with a typed
 * snapshot refusal, when an attribute from outside the tree, which the
 * attribute source does not override, would transform a start-point path.
 * `undefined`, synchronously, for every other Git command.
 */
export function assertScopedWorktreeAddAttributes(
  cwd: string | undefined,
  args: readonly string[],
): Promise<void> | undefined {
  const attributeSource = scopedAttributeSource(cwd, args);
  if (attributeSource === undefined || cwd === undefined) return undefined;
  return assertStartPointAttributes(
    cwd,
    worktreeAddStartPoint(args),
    attributeSource,
  );
}

/**
 * The same refusal for every start point of a restore, so it comes before the
 * destination is reserved or any sibling checkout exists. `startPoint` may be
 * a resolver, called only for a repository the scope covers. Returns the
 * start point it checked, or `undefined`, as a no-op, outside a scope or for
 * a repository the scope does not cover.
 */
export async function assertScopedStartPointAttributes(
  repoPath: string,
  startPoint: string | (() => Promise<string>),
): Promise<string | undefined> {
  const attributeSource = attributeSourceStorage
    .getStore()
    ?.get(resolve(repoPath));
  if (attributeSource === undefined) return undefined;
  const checked =
    typeof startPoint === 'string' ? startPoint : await startPoint();
  await assertStartPointAttributes(
    repoPath,
    { commitish: checked },
    attributeSource,
  );
  return checked;
}
