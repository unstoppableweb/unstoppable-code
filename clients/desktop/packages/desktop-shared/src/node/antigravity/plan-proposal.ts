import type { SessionUpdate } from '@agentclientprotocol/sdk';

/** The failed plan artifact write's tool result in a plan-mode turn. */
export const ANTIGRAVITY_PLAN_ARTIFACT_MESSAGE =
  "Google's plan file was not written; the plan is shown below for review.";

/** A failed artifact write's tool result outside plan mode. */
export const ANTIGRAVITY_ARTIFACT_NOT_WRITTEN_MESSAGE =
  "Google's artifact file was not written here.";

/**
 * The content of an artifact Gemini hands in as a native `write_file` call:
 * an `edit` tool call whose raw input carries `ArtifactMetadata` and a
 * non-blank `Content`. The path is not consulted; in plan mode the runtime
 * never writes the file, so the call's content is the only copy of the plan.
 */
export function antigravityPlanArtifact(
  update: SessionUpdate,
): { toolCallId: string; content: string } | undefined {
  if (update.sessionUpdate !== 'tool_call' || update.kind !== 'edit')
    return undefined;
  const input: unknown = update.rawInput;
  if (!isRecord(input) || !isRecord(input.ArtifactMetadata)) return undefined;
  if (typeof input.Content !== 'string') return undefined;
  const content = input.Content.trim();
  return content.length === 0
    ? undefined
    : { toolCallId: update.toolCallId, content };
}

/**
 * The plan a finished plan-mode turn proposes for review: the latest ACP plan
 * as a markdown list, else the content of the turn's plan artifact write, else
 * the turn's final response, else nothing. Each ACP `plan` update replaces the
 * whole plan, so only the last one counts.
 *
 * A final response that is a bare question is not a plan and proposes nothing.
 * A bare question has no usable plan entries, no code fence, at most two
 * non-blank lines, no line starting with a list marker (`-`, `*`, `+`, `1.`)
 * or `#`, and a last non-blank line ending in `?`.
 */
export function collectAntigravityPlanProposal(
  updates: readonly SessionUpdate[],
  finalAgentText: string,
  artifactContent?: string,
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
  const artifact = artifactContent?.trim() ?? '';
  if (artifact.length > 0) return artifact;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
