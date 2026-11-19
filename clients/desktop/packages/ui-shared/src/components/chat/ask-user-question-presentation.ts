// Pure presentation policy for a transcript AskUserQuestion `tool_use` block.
// Shared by the desktop renderer, the shared `ChatPartView`, and the Portal
// message renderer. Hosts normalize their own result and question-record
// shapes into the inputs below; this module owns record matching and the
// precedence between the result and the record. No stores, IPC, or React.
import type { RemoteControlAskUserQuestionState } from '@canopy/protocol/remote-control/shell';
import {
  answersToDisplay,
  isCodexAskUserToolUseId,
  type AnsweredQuestionDisplay,
} from './AskUserQuestionCard';
import { parseAskUserQuestionAnswers } from './ask-user-question-answers';
import type { ToolCallResult } from './ToolCallCard';

/** The identity a host can read from one question record. */
export interface AskUserQuestionRecordIdentity {
  /** Deterministic correlation id, when the provider supplied one. */
  toolUseId?: string;
  /** The record's ordered question text. */
  questionTexts: readonly string[];
}

/** The identity read from the transcript `tool_use` block. */
export interface AskUserQuestionBlockIdentity {
  toolUseId?: string;
  /** Ordered question text parsed from the block input, when parseable. */
  questionTexts?: readonly string[];
  /**
   * Codex ask-user paths always carry the id of their `tool_use` block, so
   * only an exact id match may attach a record to them.
   */
  requireExactToolUseId: boolean;
}

function sameTexts(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((text, i) => text === right[i])
  );
}

function hasId(id: string | undefined): id is string {
  return typeof id === 'string' && id.length > 0;
}

/**
 * Select the one record that belongs to a transcript `tool_use` block.
 *
 * - An exact `toolUseId` match wins.
 * - Codex blocks (`requireExactToolUseId`) never fall back.
 * - Otherwise only records WITHOUT an id may match, and only by identical
 *   ordered question text. A record with a different id never matches.
 * - Several eligible records are ambiguous: nothing is attached, so a
 *   repeated question can never show another prompt's answer.
 *
 * Hosts pass only the records that can belong to a synchronous tool call;
 * async question records render through their own path.
 */
export function matchAskUserQuestionRecord<TRecord>(
  records: readonly TRecord[],
  identify: (record: TRecord) => AskUserQuestionRecordIdentity,
  block: AskUserQuestionBlockIdentity,
): TRecord | undefined {
  const { toolUseId, questionTexts, requireExactToolUseId } = block;
  if (hasId(toolUseId)) {
    const exact = records.filter(
      (record) => identify(record).toolUseId === toolUseId,
    );
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return undefined;
  }
  if (requireExactToolUseId) return undefined;
  if (!questionTexts || questionTexts.length === 0) return undefined;

  const byText = records.filter((record) => {
    const identity = identify(record);
    return (
      !hasId(identity.toolUseId) &&
      sameTexts(identity.questionTexts, questionTexts)
    );
  });
  return byText.length === 1 ? byText[0] : undefined;
}

/** What the block's `tool_result` says, normalized by the host. */
export type AskUserQuestionResultEvidence =
  | { kind: 'none' }
  | { kind: 'error' }
  /** A non-error result whose text parsed into display-safe answers. */
  | { kind: 'answers'; answers: readonly AnsweredQuestionDisplay[] }
  /** Any other non-error result, including a synthetic `Cancelled`. */
  | { kind: 'other' };

/** The matched record, normalized by the host into exactly one state. */
export type AskUserQuestionRecordState<TRecord> =
  | { kind: 'none' }
  | { kind: 'unanswered'; record: TRecord }
  /** `answers` are display-safe (redacted) and may be empty. */
  | { kind: 'answered'; answers: readonly AnsweredQuestionDisplay[] }
  | { kind: 'dismissed' };

/**
 * How the block renders.
 *
 * - `preparing`: no result and no record yet; the streaming fallback.
 * - `awaiting`: an unanswered record owns the question. Desktop hides the
 *   block (the composer shows the prompt); the Portal renders it inline.
 * - `answered`: the tool row plus the answers block.
 * - `settled`: the tool row alone, with the base label.
 * - `result`: the generic tool row, using the result's own semantics.
 *
 * `answered` and `settled` carry `status: 'success'` when the block has no
 * result, so the tool row cannot infer `pending` and show a spinner.
 */
export type AskUserQuestionPresentation<TRecord> =
  | { kind: 'preparing' }
  | { kind: 'awaiting'; record: TRecord }
  | {
      kind: 'answered';
      answers: readonly AnsweredQuestionDisplay[];
      status?: 'success';
    }
  | { kind: 'settled'; status?: 'success' }
  | { kind: 'result' };

function settledStatus(result: AskUserQuestionResultEvidence): {
  status?: 'success';
} {
  return result.kind === 'none' ? { status: 'success' } : {};
}

/**
 * Resolve a transcript AskUserQuestion block from its result and matched
 * record. Precedence:
 *
 * 1. An explicit error result stays an error.
 * 2. Answers parsed from a non-error result win over the record.
 * 3. An answered record settles a missing or other non-error result.
 * 4. A dismissed record settles without a spinner.
 * 5. An unanswered record with no result owns the prompt.
 * 6. Any remaining result renders generically.
 * 7. Otherwise the question is still being prepared, unless its message has
 *    stopped streaming (`live === false`): then it settles. A cloud harness
 *    turn never streams the question's result (the runner hands it back to
 *    the harness), so it would otherwise stay "preparing" forever.
 */
export function resolveAskUserQuestionPresentation<TRecord>(
  result: AskUserQuestionResultEvidence,
  record: AskUserQuestionRecordState<TRecord>,
  live?: boolean,
): AskUserQuestionPresentation<TRecord> {
  if (result.kind === 'error') return { kind: 'result' };
  if (result.kind === 'answers' && result.answers.length > 0) {
    return { kind: 'answered', answers: result.answers };
  }
  if (record.kind === 'answered') {
    const answers = record.answers.filter(
      (answer) =>
        answer.answer.trim().length > 0 ||
        (answer.additional?.trim().length ?? 0) > 0,
    );
    return answers.length > 0
      ? { kind: 'answered', answers, ...settledStatus(result) }
      : { kind: 'settled', ...settledStatus(result) };
  }
  if (record.kind === 'dismissed') {
    return { kind: 'settled', ...settledStatus(result) };
  }
  if (result.kind === 'none') {
    if (record.kind === 'unanswered') {
      return { kind: 'awaiting', record: record.record };
    }
    return live === false
      ? { kind: 'settled', ...settledStatus(result) }
      : { kind: 'preparing' };
  }
  return { kind: 'result' };
}

/** Normalize shared tool results, parsing display-safe answers before projection fallback. */
export function askUserQuestionResultEvidence(
  result: ToolCallResult | null,
  input?: string,
): AskUserQuestionResultEvidence {
  if (result === null) return { kind: 'none' };
  if (result.kind !== 'text') return { kind: 'error' };
  const answers = input
    ? parseAskUserQuestionAnswers(input, result.content)
    : null;
  return answers && answers.length > 0
    ? { kind: 'answers', answers }
    : { kind: 'other' };
}

/**
 * Match and normalize the Portal question projection for a transcript block.
 * The projection carries no dismissed state; dismissed prompts leave it.
 */
export function remoteControlAskUserQuestionRecordState(
  states: readonly RemoteControlAskUserQuestionState[],
  block: {
    toolName?: string;
    toolUseId?: string;
    questionTexts?: readonly string[];
  },
): AskUserQuestionRecordState<RemoteControlAskUserQuestionState> {
  const state = matchAskUserQuestionRecord(
    states,
    (candidate) => ({
      toolUseId: candidate.toolUseId,
      questionTexts: candidate.questions.map((question) => question.question),
    }),
    {
      ...block,
      requireExactToolUseId:
        block.toolName === 'canopy_ask_user_question' ||
        block.toolName === 'request_user_input' ||
        isCodexAskUserToolUseId(block.toolUseId),
    },
  );
  if (!state) return { kind: 'none' };
  return state.answered
    ? {
        kind: 'answered',
        answers: answersToDisplay(state.answers ?? [], state.questions),
      }
    : { kind: 'unanswered', record: state };
}
