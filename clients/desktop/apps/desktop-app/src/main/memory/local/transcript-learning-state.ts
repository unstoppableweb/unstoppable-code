import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { withMemoryWriteLock } from './edit-coordination';
import {
  assertMemoryPathContained,
  writeMemoryFileAtomically,
} from '@canopy/memory-store/memory-files';

export const CHAT_LEARNING_INTERVAL_MS = 6 * 60 * 60_000;
export const CHAT_LEARNING_DAILY_CAP_USD = 1;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const TurnSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  chatId: z.string(),
  userMessageId: z.string(),
  at: z.number().finite(),
  accountId: z.string().nullable(),
  accountBindingVersion: z.literal(1).optional(),
  owner: z
    .object({ organizationId: z.string(), projectId: z.string() })
    .optional(),
});
export type LearningTurn = z.output<typeof TurnSchema>;
export type LearningChatRef = Pick<
  LearningTurn,
  'projectId' | 'worktreeId' | 'chatId'
>;
const StateSchema = z.object({
  version: z.literal(1),
  lastAttemptAt: z.number().finite().optional(),
  lastConsideredChat: TurnSchema.pick({
    projectId: true,
    worktreeId: true,
    chatId: true,
  }).optional(),
  turns: z.array(TurnSchema).max(200),
});
export type LearningState = z.output<typeof StateSchema>;
const BudgetSchema = z.object({
  version: z.literal(1),
  day: z.string(),
  spentUsd: z.number().finite().nonnegative(),
});
const STATE_FILE = 'chat-learning-state.json';

async function readJson(dir: string, name: string): Promise<unknown> {
  await assertMemoryPathContained(dir, join(dir, name));
  try {
    const value: unknown = JSON.parse(await readFile(join(dir, name), 'utf8'));
    return value;
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return undefined;
    throw error; // Corrupt state must not reset throttles or spending.
  }
}
export async function readLearningState(dir: string): Promise<LearningState> {
  const value = await readJson(dir, STATE_FILE);
  return value === undefined
    ? { version: 1, turns: [] }
    : StateSchema.parse(value);
}
export async function updateLearningState(
  dir: string,
  update: (state: LearningState) => void,
): Promise<void> {
  await withMemoryWriteLock(dir, async () => {
    const state = await readLearningState(dir);
    update(state);
    await writeMemoryFileAtomically(
      dir,
      join(dir, STATE_FILE),
      JSON.stringify(state),
    );
  });
}
export async function queueLearningTurn(
  dir: string,
  turn: LearningTurn,
): Promise<void> {
  await updateLearningState(dir, (state) => {
    state.turns = state.turns.filter(
      (entry) =>
        entry.at >= turn.at - RETENTION_MS &&
        (entry.userMessageId !== turn.userMessageId ||
          entry.chatId !== turn.chatId ||
          entry.projectId !== turn.projectId ||
          entry.worktreeId !== turn.worktreeId),
    );
    state.turns.push(turn);
    state.turns = state.turns.slice(-200);
  });
}

/** Reserve the entire daily allowance before dispatch. Unknown/error usage stays spent. */
export async function reserveLearningBudget(
  dir: string,
  now: number,
): Promise<boolean> {
  return withMemoryWriteLock(dir, async () => {
    const day = new Date(now).toISOString().slice(0, 10);
    const value = await readJson(dir, 'budget.json');
    const previous =
      value === undefined ? undefined : BudgetSchema.parse(value);
    if (
      previous &&
      previous.day >= day &&
      previous.spentUsd >= CHAT_LEARNING_DAILY_CAP_USD
    )
      return false;
    // One bounded extraction a day across all scopes. Do not refund unknown usage.
    await writeMemoryFileAtomically(
      dir,
      join(dir, 'budget.json'),
      JSON.stringify({
        version: 1,
        day,
        spentUsd: CHAT_LEARNING_DAILY_CAP_USD,
      }),
    );
    return true;
  });
}
