import type { TurnOutcomeStepDetail } from '@canopy/protocol/remote-control/shell';
import { toolInterruptionDetail } from './ToolCallCard';
import {
  classifyToolDenial,
  stripHookErrorPrefix,
  toolDenialHeading,
} from './tool-denial';

/** The reason for an errored step whose output says nothing readable. */
export const TOOL_ERROR_FALLBACK_REASON = 'Ran into an error';

/** The reason for a blocked step whose output names no known source. */
export const TOOL_BLOCKED_FALLBACK_REASON = 'Blocked by a safety check';

const MAX_REASON_LENGTH = 120;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/**
 * CSI and OSC terminal escape sequences, built without a control literal. An
 * OSC (a hyperlink, say) ends at BEL or at ST (`ESC \`).
 */
const ANSI_ESCAPE = new RegExp(
  `${ESC}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?)`,
  'g',
);

const EXIT_CODE_LINE = /^exit code\b/i;
const EXIT_CODE_ANYWHERE = /\bexit code\b/i;

/** A line with nothing to read: only punctuation or brackets. */
const PUNCTUATION_ONLY = /^[\p{P}\p{S}\s]*$/u;

/**
 * One short line saying what an errored step complained about, for the turn
 * outcome tooltip. Bash results lead with `Exit code N` and put stderr last,
 * so that line is dropped and the last remaining line is taken; other output
 * gives its first line. The result never contains an exit code.
 */
export function summarizeToolError(output: string | undefined): string {
  if (output == null) return TOOL_ERROR_FALLBACK_REASON;
  const lines = stripHookErrorPrefix(output)
    .replace(ANSI_ESCAPE, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');
  const first = lines[0];
  if (first === undefined) return TOOL_ERROR_FALLBACK_REASON;
  const chosen = EXIT_CODE_LINE.test(first) ? lines.slice(1).at(-1) : first;
  if (
    chosen === undefined ||
    EXIT_CODE_ANYWHERE.test(chosen) ||
    PUNCTUATION_ONLY.test(chosen)
  ) {
    return TOOL_ERROR_FALLBACK_REASON;
  }
  // By code point, so truncation never splits an emoji or other astral
  // character into a stray half.
  const characters = Array.from(chosen);
  return characters.length > MAX_REASON_LENGTH
    ? `${characters
        .slice(0, MAX_REASON_LENGTH - 1)
        .join('')
        .trimEnd()}…`
    : chosen;
}

/**
 * The tooltip's reason line for one outcome step: who stopped a blocked
 * call, what an errored one complained about, or why one was interrupted
 * (naming the app only for a known restart).
 */
export function summarizeToolOutcome(
  step: Pick<TurnOutcomeStepDetail, 'outcome' | 'output' | 'interruption'>,
  brandAppName?: string,
): string {
  if (step.outcome === 'interrupted') {
    return step.interruption
      ? toolInterruptionDetail(step.interruption, brandAppName)
      : 'Interrupted';
  }
  if (step.outcome === 'blocked') {
    const denial = step.output == null ? null : classifyToolDenial(step.output);
    return denial ? toolDenialHeading(denial) : TOOL_BLOCKED_FALLBACK_REASON;
  }
  return summarizeToolError(step.output);
}
