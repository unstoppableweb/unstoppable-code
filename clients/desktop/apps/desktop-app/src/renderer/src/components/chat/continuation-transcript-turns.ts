import type { TranscriptTurnSummary } from '@canopy/agent-transcript/transcript-storage';
import type { TurnGroup, TurnGroupOrMessage, TurnMessage } from './types';

/**
 * The indexed projection of each tools-loaded continuation, by its group id.
 * Main indexes one turn per prompt and keeps each continuation's own counts,
 * answer and files in it; the continuation pages through its prompt's turn.
 */
export function continuationTranscriptTurns(
  turns: readonly TranscriptTurnSummary[] | undefined,
): Map<string, TranscriptTurnSummary> {
  const byGroupId = new Map<string, TranscriptTurnSummary>();
  for (const turn of turns ?? [])
    for (const [groupId, continuation] of Object.entries(
      turn.continuations ?? {},
    ))
      byGroupId.set(groupId, {
        id: turn.id,
        start: turn.start,
        end: turn.end,
        ...(turn.before === undefined ? {} : { before: turn.before }),
        // Its receipts name the prompt, so the prompt's denials apply.
        ...(turn.deniedToolUseIds === undefined
          ? {}
          : { deniedToolUseIds: turn.deniedToolUseIds }),
        ...continuation,
      });
  return byGroupId;
}

type TurnFiles = NonNullable<TranscriptTurnSummary['files']>;
type TurnFileEvidence = NonNullable<TurnFiles[number]['evidence']>[number];

/** The JSON-encoded message id an indexed file's evidence key starts with. */
export const EVIDENCE_MESSAGE_ID = /^\[("(?:[^"\\]|\\.)*"),/;

/** A prompt span's indexed files, and their evidence by encoded row id. */
export interface SpanTurnFiles {
  readonly files: TranscriptTurnSummary['files'];
  readonly evidenceByRow: ReadonlyMap<string, readonly TurnFileEvidence[]>;
}

/**
 * The indexed files of a prompt's whole span, for a wake split out of it,
 * built once per page of turns: the prompt turn's own and each indexed
 * continuation's (whichever one the index filed the wake's rows under), as
 * one list whose first record carries all their evidence, with that evidence
 * split by the row that showed it, so a group reads only its own rows'.
 */
export function spanTurnFiles(
  turn: TranscriptTurnSummary | undefined,
): SpanTurnFiles | undefined {
  if (turn === undefined) return undefined;
  const files = spanFileList(turn);
  const evidenceByRow = new Map<string, TurnFileEvidence[]>();
  for (const file of files?.find((record) => record.evidence)?.evidence ?? []) {
    const encodedId = EVIDENCE_MESSAGE_ID.exec(file.key)?.[1];
    if (encodedId === undefined) continue;
    const entries = evidenceByRow.get(encodedId);
    if (entries) entries.push(file);
    else evidenceByRow.set(encodedId, [file]);
  }
  return { files, evidenceByRow };
}

function spanFileList(
  turn: TranscriptTurnSummary,
): TranscriptTurnSummary['files'] {
  const lists = [
    turn.files,
    ...Object.values(turn.continuations ?? {}).map(
      (continuation) => continuation.files,
    ),
  ];
  const evidence = lists.flatMap(
    (files) => files?.find((file) => file.evidence)?.evidence ?? [],
  );
  const first = lists.flatMap((files) => files ?? [])[0];
  return first === undefined || evidence.length === 0
    ? turn.files
    : [{ ...first, evidence }];
}

/**
 * Each prompt's last tools-loaded continuation, by prompt id. The prompt's
 * diff covers all its executions on every provider and through a Resume, so
 * it shows once, after the work, on that continuation.
 */
export function continuationDiffOwners(
  items: readonly TurnGroupOrMessage[],
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const item of items) {
    const head = item.kind === 'turn-group' ? item.userMessage.blocks[0] : null;
    if (
      item.kind === 'turn-group' &&
      head?.type === 'wake_boundary' &&
      head.toolsLoaded === true &&
      head.spawningUserMessageId !== undefined
    )
      owners.set(head.spawningUserMessageId, item.userMessage.id);
  }
  return owners;
}

/**
 * The turn a group's diff, Undo and reverted state belong to: its prompt's
 * when it is that prompt's last tools-loaded continuation, else its own.
 */
/** The prompt a tools-loaded continuation's head row continues. */
export function continuationPromptId(head: TurnMessage): string | undefined {
  const block = head.blocks[0];
  return block?.type === 'wake_boundary' && block.toolsLoaded === true
    ? block.spawningUserMessageId
    : undefined;
}

export function promptTurnOwnerId(
  group: TurnGroup,
  owners: ReadonlyMap<string, string>,
): string {
  const promptId = continuationPromptId(group.userMessage);
  return promptId !== undefined && owners.get(promptId) === group.userMessage.id
    ? promptId
    : group.userMessage.id;
}

/**
 * Prompts whose tools-loaded continuation still runs: the prompt's own turn
 * has ended, but its session is live, so it forks from the active session.
 */
export function activeContinuationPromptIds(
  items: readonly TurnGroupOrMessage[],
): Set<string> {
  const prompts = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'turn-group' || item.isComplete) continue;
    const promptId = continuationPromptId(item.userMessage);
    if (promptId !== undefined) prompts.add(promptId);
  }
  return prompts;
}
