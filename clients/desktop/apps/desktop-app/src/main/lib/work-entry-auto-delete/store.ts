import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { WorkEntryAutoDeleteArm } from '@canopy/protocol/work-entry-auto-delete';
import { writeFileAtomically } from '../atomic-file';
import { getWorkspaceWorkEntryAutoDeleteFilePath } from '../paths';
import { isErrnoException, isRecord } from '../type-guards';

const armSchema = z.object({
  targetId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  targetKind: z.enum(['worktree', 'work-entry']),
  mode: z.enum(['delete', 'archive']),
  teardown: z.enum(['error', 'force']),
  unmergedLocalBranchDelete: z.enum(['ask', 'error', 'force']),
  state: z.enum(['armed', 'awaiting-branch-confirmation']),
  armedAt: z.string().datetime(),
  armedBy: z.object({
    chatId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    projectId: z.string().min(1).optional(),
    worktreeId: z.string().min(1).optional(),
  }),
  identity: z.object({
    createdAt: z.string().datetime(),
    branchName: z.string().optional(),
  }),
  confirmationId: z.uuid().optional(),
  forceBranchPins: z
    .array(z.object({ repoId: z.string(), branchName: z.string().nullable() }))
    .optional(),
  branchConfirmation: z
    .array(z.object({ repoId: z.string(), branchName: z.string().nullable() }))
    .optional(),
  unmergedBranches: z.array(z.string()).optional(),
  branchAnswer: z.enum(['delete-branch', 'keep-branch']).optional(),
});

export async function readArms(
  workspaceId: string,
): Promise<WorkEntryAutoDeleteArm[]> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(
        getWorkspaceWorkEntryAutoDeleteFilePath(workspaceId),
        'utf8',
      ),
    );
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (isErrnoException(error) && error.code === 'ENOENT')
    )
      return [];
    throw error;
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.arms))
    return [];
  const arms = new Map<string, WorkEntryAutoDeleteArm>();
  for (const item of value.arms) {
    const parsed = armSchema.safeParse(item);
    if (parsed.success) arms.set(parsed.data.targetId, parsed.data);
  }
  return [...arms.values()];
}

export async function writeArms(
  workspaceId: string,
  arms: readonly WorkEntryAutoDeleteArm[],
): Promise<void> {
  const path = getWorkspaceWorkEntryAutoDeleteFilePath(workspaceId);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomically(
    path,
    `${JSON.stringify({ version: 1, arms }, null, 2)}\n`,
  );
}

let tail: Promise<unknown> = Promise.resolve();
/** All mutations and evaluations share this writer, including removal admission. */
export function withArmWriter<T>(run: () => Promise<T>): Promise<T> {
  const next = tail.then(run, run);
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
