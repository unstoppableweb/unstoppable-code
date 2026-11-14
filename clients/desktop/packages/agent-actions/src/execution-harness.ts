import type { AgentExecutionHarness } from '@canopy/protocol/models';
import { z } from 'zod';

/**
 * Every execution harness an action may name, in registry order. A plain
 * literal tuple so the payload schemas stay representable as JSON Schema; the
 * type checks below keep it equal to the protocol union.
 */
export const AGENT_EXECUTION_HARNESSES = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'opencode',
  'antigravity',
] as const satisfies readonly AgentExecutionHarness[];

type ListedHarness = (typeof AGENT_EXECUTION_HARNESSES)[number];
// A harness added to the protocol union must be listed here as well.
const _everyHarnessListed: Exclude<
  AgentExecutionHarness,
  ListedHarness
> extends never
  ? true
  : never = true;
void _everyHarnessListed;

export function isAgentExecutionHarness(
  value: unknown,
): value is AgentExecutionHarness {
  return (
    typeof value === 'string' &&
    AGENT_EXECUTION_HARNESSES.some((candidate) => candidate === value)
  );
}

/**
 * The optional `executionHarness` an action names for a new chat: the
 * model's own harness or a `harnessChoices` entry from `models.list`.
 */
export const agentExecutionHarnessSchema = z.enum(AGENT_EXECUTION_HARNESSES);
