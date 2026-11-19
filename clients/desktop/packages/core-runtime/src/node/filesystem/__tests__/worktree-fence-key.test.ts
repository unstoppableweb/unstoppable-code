/** CAN-4730 E2-G: one fence key per worktree, whatever form names it, and no raw-id fallback. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  worktreeFenceKey,
  worktreeFenceKeySync,
  type WorktreeRootLookupSync,
} from '../worktree-fence-key';

let scratch: string;
let lookup: WorktreeRootLookupSync;
const UUID = '0b6f7c1e-1d2a-4c51-9b7e-5a1f3c2d4e6f';

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'fence-key-'));
  mkdirSync(join(scratch, 'Work', 'worktrees', 'one'), { recursive: true });
  mkdirSync(join(scratch, 'Work', 'worktrees', 'two'), { recursive: true });
  symlinkSync(join(scratch, 'Work'), join(scratch, 'linked'));
  // Today's id and a UUID alias name the same record, as #9423's references will.
  const roots: Record<string, string> = {
    one: join(scratch, 'Work', 'worktrees', 'one'),
    [UUID]: join(scratch, 'Work', 'worktrees', 'one'),
    two: join(scratch, 'Work', 'worktrees', 'two'),
    'one-linked': join(scratch, 'linked', 'worktrees', 'one'),
    'one-case': join(scratch, 'work', 'WORKTREES', 'one'),
    missing: join(scratch, 'Work', 'worktrees', 'missing'),
  };
  lookup = (workspaceId, worktreeRef): string | undefined =>
    workspaceId === 'workspace' ? roots[worktreeRef] : undefined;
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const caseInsensitive = (): boolean =>
  existsSync(join(scratch, 'WORK', 'worktrees', 'one'));

it("keys one worktree the same under today's id, a UUID, a symlink and, where the volume ignores case, a case variant", async () => {
  const key = worktreeFenceKeySync('workspace', 'one', lookup);
  const refs = [
    'one',
    UUID,
    'one-linked',
    ...(caseInsensitive() ? ['one-case'] : []),
  ];
  for (const ref of refs) {
    expect(worktreeFenceKeySync('workspace', ref, lookup)).toBe(key);
    await expect(worktreeFenceKey('workspace', ref, lookup)).resolves.toBe(key);
  }
});

it('never gives two worktrees the same key', () => {
  expect(worktreeFenceKeySync('workspace', 'one', lookup)).not.toBe(
    worktreeFenceKeySync('workspace', 'two', lookup),
  );
});

it('refuses a reference it cannot resolve, never keying the raw id', async () => {
  const unresolved = {
    payload: {
      kind: 'failed_precondition',
      details: { fence: 'unresolved' },
      retry: { kind: 'never' },
    },
  };
  for (const [workspaceId, ref] of [
    ['workspace', 'unknown'],
    ['other', 'one'],
    ['workspace', 'missing'],
  ] as const) {
    let refusal: unknown;
    try {
      worktreeFenceKeySync(workspaceId, ref, lookup);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject(unresolved);
    await expect(
      worktreeFenceKey(workspaceId, ref, lookup),
    ).rejects.toMatchObject(unresolved);
  }
});
