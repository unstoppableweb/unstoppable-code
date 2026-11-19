/** CAN-4730 E2-G: split locks key a worktree by its resolved root, whatever names it, and cost nothing while none is held. */
import * as fs from 'node:fs';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitLockKeyResolverFor } from '../split-lock-keys';
import {
  acquireSplitLock,
  assertNotSplitLocked,
  getSplitLockedWorktrees,
  isSplitLocked,
  onSplitLockChange,
  releaseSplitLock,
  setSplitLockKeyResolver,
  SplitLockError,
  type SplitLockChangeEvent,
} from '../split-lock-service';

const WORKSPACE = 'workspace';
/** The post-#9423 form: a UUID naming the same worktree record as 'one'. */
const ONE_UUID = '0b6f7c1e-1d2a-4c51-9b7e-5a1f3c2d4e6f';
const GUARDS = [
  'running a hook',
  'running a script',
  'sending a chat message',
] as const;

let scratch: string;
let roots: Record<string, string>;
let lookups: number;
let restore: () => void;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'split-lock-keys-'));
  mkdirSync(join(scratch, 'Work', 'worktrees', 'one'), { recursive: true });
  mkdirSync(join(scratch, 'Work', 'worktrees', 'two'), { recursive: true });
  symlinkSync(join(scratch, 'Work'), join(scratch, 'linked'));
  roots = {
    one: join(scratch, 'Work', 'worktrees', 'one'),
    [ONE_UUID]: join(scratch, 'Work', 'worktrees', 'one'),
    'one-linked': join(scratch, 'linked', 'worktrees', 'one'),
    two: join(scratch, 'Work', 'worktrees', 'two'),
  };
  lookups = 0;
  restore = setSplitLockKeyResolver(
    splitLockKeyResolverFor((workspaceId, worktreeId) => {
      lookups += 1;
      return workspaceId === WORKSPACE ? roots[worktreeId] : undefined;
    }),
  );
});
afterEach(() => {
  for (const held of getSplitLockedWorktrees())
    releaseSplitLock(held.workspaceId, held.worktreeId);
  restore();
  jest.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

function refusal(worktreeId: string, operation: string): unknown {
  try {
    assertNotSplitLocked(WORKSPACE, worktreeId, operation);
    return 'allowed';
  } catch (error) {
    return error;
  }
}

it('locks one worktree under its ID, its UUID and a symlinked path alike, and no other', async () => {
  const events: SplitLockChangeEvent[] = [];
  const unsubscribe = onSplitLockChange((event) => events.push(event));
  await acquireSplitLock(WORKSPACE, 'one');
  for (const worktreeId of ['one', ONE_UUID, 'one-linked']) {
    expect(isSplitLocked(WORKSPACE, worktreeId)).toBe(true);
    expect(refusal(worktreeId, 'updating files')).toBeInstanceOf(
      SplitLockError,
    );
  }
  expect(isSplitLocked(WORKSPACE, 'two')).toBe(false);
  await expect(acquireSplitLock(WORKSPACE, ONE_UUID)).rejects.toThrow(
    'A Split PR workflow is already in progress for this worktree.',
  );
  releaseSplitLock(WORKSPACE, ONE_UUID);
  expect(isSplitLocked(WORKSPACE, 'one')).toBe(false);
  expect(events).toEqual([
    { workspaceId: WORKSPACE, worktreeId: 'one', locked: true },
    { workspaceId: WORKSPACE, worktreeId: 'one', locked: false },
  ]);
  unsubscribe();
});

it('refuses to lock a worktree it cannot resolve, and to lock anything without a resolver', async () => {
  const notFound = "Couldn't find this worktree, so a Split PR can't start.";
  const unresolved = acquireSplitLock(WORKSPACE, 'unknown');
  await expect(unresolved).rejects.toBeInstanceOf(SplitLockError);
  await expect(unresolved).rejects.toHaveProperty('message', notFound);
  restore();
  const unkeyed = acquireSplitLock(WORKSPACE, 'one');
  await expect(unkeyed).rejects.toBeInstanceOf(SplitLockError);
  await expect(unkeyed).rejects.toHaveProperty('message', notFound);
  expect(getSplitLockedWorktrees()).toEqual([]);
});

it('treats a target it cannot resolve as locked while any lock is held', async () => {
  expect(refusal('unknown', 'running a hook')).toBe('allowed');
  await acquireSplitLock(WORKSPACE, 'one');
  expect(refusal('unknown', 'running a hook')).toBeInstanceOf(SplitLockError);
  expect(refusal('two', 'running a hook')).toBe('allowed');
});

it('keeps refusing a locked worktree whose root was renamed under it, under every ID that names it', async () => {
  await acquireSplitLock(WORKSPACE, 'one');
  // In app, a root comes from the data directory and the worktree's IDs
  // (resolveWorktreeCwd), so only an outside rename can move it.
  renameSync(roots.one, join(scratch, 'Work', 'worktrees', 'one-moved'));
  for (const worktreeId of ['one', ONE_UUID, 'one-linked']) {
    expect(isSplitLocked(WORKSPACE, worktreeId)).toBe(true);
    expect(refusal(worktreeId, 'updating files')).toBeInstanceOf(
      SplitLockError,
    );
  }
  expect(refusal('two', 'updating files')).toBe('allowed');
});

it('frees a lock by the IDs it was taken under after its directory vanished', async () => {
  await acquireSplitLock(WORKSPACE, 'one');
  rmSync(roots.one, { recursive: true, force: true });
  releaseSplitLock(WORKSPACE, 'one');
  expect(getSplitLockedWorktrees()).toEqual([]);
  expect(isSplitLocked(WORKSPACE, 'two')).toBe(false);
});

it('makes no lookup or synchronous realpath for hooks, scripts and chat sends while no lock is held', async () => {
  const realpathSync = jest.spyOn(fs.realpathSync, 'native');
  for (const worktreeId of ['one', ONE_UUID, 'two', 'unknown'])
    for (const operation of GUARDS) {
      expect(refusal(worktreeId, operation)).toBe('allowed');
      expect(isSplitLocked(WORKSPACE, worktreeId)).toBe(false);
    }
  releaseSplitLock(WORKSPACE, 'one');
  expect(lookups).toBe(0);
  expect(realpathSync).not.toHaveBeenCalled();
  // The same spy sees the held-lock path, so the zero above is not vacuous.
  await acquireSplitLock(WORKSPACE, 'one');
  expect(realpathSync).not.toHaveBeenCalled();
  expect(refusal('two', 'running a script')).toBe('allowed');
  expect(realpathSync).toHaveBeenCalledTimes(1);
});

it('makes no lookup or synchronous realpath for the lock check, the assert or the release while a lock is held and the target names it by its own IDs', async () => {
  await acquireSplitLock(WORKSPACE, 'one');
  const realpathSync = jest.spyOn(fs.realpathSync, 'native');
  lookups = 0;
  for (const operation of GUARDS) {
    expect(isSplitLocked(WORKSPACE, 'one')).toBe(true);
    expect(refusal('one', operation)).toBeInstanceOf(SplitLockError);
  }
  releaseSplitLock(WORKSPACE, 'one');
  expect(isSplitLocked(WORKSPACE, 'one')).toBe(false);
  expect(lookups).toBe(0);
  expect(realpathSync).not.toHaveBeenCalled();
  // Another form of the same worktree is placed by its key: one call each.
  await acquireSplitLock(WORKSPACE, 'one');
  realpathSync.mockClear();
  expect(isSplitLocked(WORKSPACE, ONE_UUID)).toBe(true);
  expect(realpathSync).toHaveBeenCalledTimes(1);
  releaseSplitLock(WORKSPACE, ONE_UUID);
  expect(realpathSync).toHaveBeenCalledTimes(2);
  expect(getSplitLockedWorktrees()).toEqual([]);
});
