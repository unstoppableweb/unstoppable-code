import type { SessionUpdate } from '@agentclientprotocol/sdk';

/**
 * The plan a finished plan-mode turn proposes for review: the latest ACP plan
 * as a markdown list, else the turn's final response, else nothing. Each ACP
 * `plan` update replaces the whole plan, so only the last one counts.
 *
 * A final response that is a bare question is not a plan and proposes nothing.
 * A bare question has no usable plan entries, no code fence, at most two
 * non-blank lines, no line starting with a list marker (`-`, `*`, `+`, `1.`)
 * or `#`, and a last non-blank line ending in `?`.
 */
export function collectAntigravityPlanProposal(
  updates: readonly SessionUpdate[],
  finalAgentText: string,
): string | null {
  let entries: readonly string[] = [];
  for (const update of updates)
    if (update.sessionUpdate === 'plan')
      entries = update.entries
        // A malformed entry is skipped rather than failing the turn.
        .flatMap((entry) =>
          typeof entry.content === 'string' ? [entry.content.trim()] : [],
        )
        .filter((content) => content.length > 0);
  if (entries.length > 0)
    return entries.map((content) => `- ${content}`).join('\n');
  const text = finalAgentText.trim();
  if (text.length === 0) return null;
  return isBareQuestion(text) ? null : text;
}

function isBareQuestion(text: string): boolean {
  if (text.includes('```')) return false;
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > 2) return false;
  if (lines.some((line) => /^(?:[-*+]|\d+\.|#)/.test(line))) return false;
  return lines[lines.length - 1].endsWith('?');
}
