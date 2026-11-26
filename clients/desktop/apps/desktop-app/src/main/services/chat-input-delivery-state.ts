import type {
  ChatInputAttempt,
  ChatInputDeliveryEvent,
  ChatInputDeliveryLedger,
  ChatInputDeliveryRow,
} from '@canopy/protocol/remote-control/shell';
import type { ChatSendMessageRequest } from '@canopy/desktop-shared/types';
import {
  inputSettingsKey,
  isInputLedger,
} from '@canopy/desktop-shared/chat-input-delivery';
import { isGeneratedInputRequest } from './chat-input-request-kind';

export type InputLedger = ChatInputDeliveryLedger<ChatSendMessageRequest>;
export type InputRow = ChatInputDeliveryRow<ChatSendMessageRequest>;

export type ChatPickupVerdict = 'accepted' | 'already-accepted' | 'rejected';

export interface InputDeliveryObservation {
  observed: boolean;
  pickup?: ChatPickupVerdict;
}

export type InputHistoryVerdict =
  | { kind: 'found'; attemptId: string }
  | { kind: 'not-found' }
  | { kind: 'unreadable' };

export { inputSettingsKey, isInputLedger };

const SUPERSEDED_PICKUP_REASON =
  'A superseded delivery attempt was picked up. Review the provider transcript before retrying this message.';

interface StringPropertyLocation {
  holder: object;
  key: string;
  value: string;
}

interface InputTextShareAttempt {
  createdAt: number;
  order: number;
  submittedText: StringPropertyLocation | undefined;
  hiddenText: StringPropertyLocation | undefined;
}

interface StringPropertyWrite {
  location: StringPropertyLocation;
  expectedValue: string;
  replacement: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function ownDataValue(target: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function stringPropertyLocation(
  target: object,
  key: string,
): StringPropertyLocation | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (
    !descriptor ||
    !('value' in descriptor) ||
    typeof descriptor.value !== 'string'
  )
    return undefined;
  return { holder: target, key, value: descriptor.value };
}

function hiddenTextLocation(
  payload: unknown,
): StringPropertyLocation | undefined {
  if (!isRecord(payload)) return undefined;
  const context = ownDataValue(payload, 'hiddenContext');
  if (!isRecord(context)) return undefined;
  return stringPropertyLocation(context, 'text');
}

function ownArrayLength(value: object): number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  return descriptor &&
    'value' in descriptor &&
    typeof descriptor.value === 'number'
    ? descriptor.value
    : undefined;
}

function isLaterAttempt(
  candidate: InputTextShareAttempt,
  previous: InputTextShareAttempt,
): boolean {
  return (
    candidate.createdAt > previous.createdAt ||
    (candidate.createdAt === previous.createdAt &&
      candidate.order > previous.order)
  );
}

function planRowTextSharing(
  row: Record<string, unknown>,
): StringPropertyWrite[] {
  const payload = ownDataValue(row, 'payload');
  const payloadHiddenText = hiddenTextLocation(payload);
  const attemptsValue = ownDataValue(row, 'attempts');
  if (!isUnknownArray(attemptsValue)) return [];
  const attemptCount = ownArrayLength(attemptsValue);
  if (attemptCount === undefined) return [];

  const attempts: InputTextShareAttempt[] = [];
  for (let index = 0; index < attemptCount; index += 1) {
    const attemptValue = ownDataValue(attemptsValue, String(index));
    if (!isRecord(attemptValue)) continue;
    const createdAt = ownDataValue(attemptValue, 'createdAt');
    if (
      typeof createdAt !== 'number' ||
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0
    )
      continue;
    const snapshot = ownDataValue(attemptValue, 'payloadSnapshot');
    attempts.push({
      createdAt,
      order: index,
      submittedText: stringPropertyLocation(attemptValue, 'submittedText'),
      hiddenText: hiddenTextLocation(snapshot),
    });
  }

  let sourceHiddenText = payloadHiddenText;
  if (!sourceHiddenText) {
    let newestSnapshotText: InputTextShareAttempt | undefined;
    for (const candidate of attempts) {
      if (!candidate.hiddenText) continue;
      if (!newestSnapshotText || isLaterAttempt(candidate, newestSnapshotText))
        newestSnapshotText = candidate;
    }
    sourceHiddenText = newestSnapshotText?.hiddenText;
  }

  const writes: StringPropertyWrite[] = [];
  if (sourceHiddenText) {
    const originalHiddenText = sourceHiddenText.value;
    const requiredPrefix = `${originalHiddenText}\n\n`;
    let newestMatchingParent: InputTextShareAttempt | undefined;
    for (const candidate of attempts) {
      if (!candidate.submittedText?.value.startsWith(requiredPrefix)) continue;
      if (
        !newestMatchingParent ||
        isLaterAttempt(candidate, newestMatchingParent)
      )
        newestMatchingParent = candidate;
    }
    const canonicalHiddenText = newestMatchingParent?.submittedText
      ? newestMatchingParent.submittedText.value.slice(
          0,
          originalHiddenText.length,
        )
      : originalHiddenText;
    const hiddenTextLocations: StringPropertyLocation[] = [];
    if (payloadHiddenText?.value === originalHiddenText)
      hiddenTextLocations.push(payloadHiddenText);
    for (const candidate of attempts) {
      if (candidate.hiddenText?.value === originalHiddenText)
        hiddenTextLocations.push(candidate.hiddenText);
    }
    for (const location of hiddenTextLocations) {
      writes.push({
        location,
        expectedValue: originalHiddenText,
        replacement: canonicalHiddenText,
      });
    }
  }

  const newestBySubmittedText = new Map<string, InputTextShareAttempt>();
  for (const candidate of attempts) {
    const submittedText = candidate.submittedText;
    if (!submittedText) continue;
    const previous = newestBySubmittedText.get(submittedText.value);
    if (!previous || isLaterAttempt(candidate, previous))
      newestBySubmittedText.set(submittedText.value, candidate);
  }
  for (const candidate of attempts) {
    const submittedText = candidate.submittedText;
    if (!submittedText) continue;
    const newest = newestBySubmittedText.get(submittedText.value);
    if (!newest?.submittedText) continue;
    writes.push({
      location: submittedText,
      expectedValue: submittedText.value,
      replacement: newest.submittedText.value,
    });
  }
  return writes;
}

function applyTextShareWrite(write: StringPropertyWrite): void {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      write.location.holder,
      write.location.key,
    );
    if (
      !descriptor ||
      !('value' in descriptor) ||
      descriptor.writable !== true ||
      typeof descriptor.value !== 'string' ||
      descriptor.value !== write.expectedValue
    )
      return;
    Reflect.defineProperty(write.location.holder, write.location.key, {
      ...descriptor,
      value: write.replacement,
    });
  } catch {
    return;
  }
}

/** Share equal hidden-context and submitted strings within each valid ledger row. */
export function shareInputLedgerText(ledger: unknown): void {
  try {
    if (!isInputLedger(ledger)) return;
    const rowsValue = ownDataValue(ledger, 'rows');
    if (!isUnknownArray(rowsValue)) return;
    const rowCount = ownArrayLength(rowsValue);
    if (rowCount === undefined) return;

    const writes: StringPropertyWrite[] = [];
    for (let index = 0; index < rowCount; index += 1) {
      const row = ownDataValue(rowsValue, String(index));
      if (isRecord(row)) writes.push(...planRowTextSharing(row));
    }
    for (const write of writes) applyTextShareWrite(write);
  } catch {
    return;
  }
}

/** Whether a row may use provider history to resolve an unconfirmed send. */
export function isHistoryCandidate(
  row: InputRow,
  liveGeneration?: string,
): boolean {
  if (row.dismissedAt !== undefined || row.payload.managedDelegationDeliveryId)
    return false;
  if (row.state === 'uncertain') return true;
  if (!['sending', 'pending', 'cancelling'].includes(row.state)) return false;

  const currentAttempt = row.attempts.find(
    (attempt) => attempt.id === row.currentAttemptId,
  );
  return (
    liveGeneration === undefined ||
    currentAttempt?.generation !== liveGeneration
  );
}

/** Resolve per-attempt provider-history results without treating gaps as absence. */
export function inputHistoryVerdict(
  row: InputRow,
  results: ReadonlyMap<string, 'found' | 'not-found' | 'unreadable'>,
): InputHistoryVerdict {
  const found = row.attempts.filter(
    (attempt) =>
      attempt.pickedUpAt !== undefined || results.get(attempt.id) === 'found',
  );
  const currentFound = found.find(
    (attempt) => attempt.id === row.currentAttemptId,
  );
  const foundAttempt = currentFound ?? found[0];
  if (foundAttempt) return { kind: 'found', attemptId: foundAttempt.id };

  if (
    row.attempts.length > 0 &&
    row.attempts.every(
      (attempt) =>
        attempt.pickedUpAt === undefined &&
        results.get(attempt.id) === 'not-found',
    )
  )
    return { kind: 'not-found' };

  return { kind: 'unreadable' };
}

/** Apply a fenced provider-history negative to one current, eligible attempt. */
export function resolveInputHistoryNotDelivered(
  ledger: InputLedger,
  rowId: string,
  currentAttemptId: string,
  epoch: number,
  now: number,
  liveGeneration?: string,
): InputLedger {
  if (ledger.epoch !== epoch) return ledger;

  let changed = false;
  const rows = ledger.rows.map((row): InputRow => {
    if (
      row.id !== rowId ||
      row.currentAttemptId !== currentAttemptId ||
      !isHistoryCandidate(row, liveGeneration)
    )
      return row;

    const {
      reason: _reason,
      ordinaryContinuation: _continuation,
      ...rest
    } = row;
    void _reason;
    void _continuation;
    changed = true;
    return {
      ...rest,
      revision: row.revision + 1,
      state: 'cancelled',
      notDelivered: { attemptId: currentAttemptId, at: now },
      ...(isGeneratedInputRequest(row.payload)
        ? { ordinaryContinuation: { attemptId: currentAttemptId, epoch } }
        : {}),
    };
  });
  return changed ? { ...ledger, rows } : ledger;
}

export function observeInputDelivery(
  ledger: InputLedger,
  event: ChatInputDeliveryEvent,
  now: number,
  liveGeneration?: string,
): InputLedger {
  let changed = false;
  const rows = ledger.rows.map((row): InputRow => {
    const index = row.attempts.findIndex(
      (attempt) =>
        attempt.id === event.attemptId &&
        attempt.generation === event.generation &&
        attempt.provider === event.provider,
    );
    if (index < 0) return row;
    const old = row.attempts[index];
    const fields = {
      accepted: 'admittedAt',
      'picked-up': 'pickedUpAt',
      withdrawn: 'withdrawnAt',
      completed: 'completedAt',
      unknown: 'uncertainAt',
    } as const;
    const field = fields[event.phase];
    // After a late acknowledgement revived the row, an unknown is fresh only
    // when it reports something new: a withdrawal requested since (the row is
    // cancelling) or the session ending. A failed withdrawal reports unknown
    // twice, so a delayed copy of the first must not undo the revival.
    const freshUncertainty =
      event.phase === 'unknown' &&
      old.uncertainAt !== undefined &&
      old.admittedAt !== undefined &&
      old.admittedAt > old.uncertainAt &&
      old.pickedUpAt === undefined &&
      (row.state === 'cancelling' ||
        event.failure?.class === 'restart' ||
        old.generation !== liveGeneration);
    if (old[field] !== undefined && !freshUncertainty) return row;
    changed = true;
    const attempt = {
      ...old,
      [field]: now,
      ...(event.phase === 'picked-up' &&
      event.startsTurn &&
      event.turnRootAccepted !== false
        ? { rootUserMessageId: row.id }
        : {}),
      ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}),
      ...(event.itemId ? { itemId: event.itemId } : {}),
    };
    const attempts = [...row.attempts];
    attempts[index] = attempt;
    if (row.currentAttemptId !== event.attemptId) {
      return {
        ...row,
        revision: row.revision + 1,
        attempts,
        ...(event.phase === 'picked-up'
          ? {
              state: 'uncertain' as const,
              reason: SUPERSEDED_PICKUP_REASON,
            }
          : {}),
      };
    }
    if (
      attempts.some(
        (candidate) =>
          candidate.id !== row.currentAttemptId &&
          candidate.pickedUpAt !== undefined,
      )
    ) {
      return {
        ...row,
        revision: row.revision + 1,
        attempts,
        state: 'uncertain',
        reason: SUPERSEDED_PICKUP_REASON,
      };
    }
    // Preserve evidence of pickup even if the root later stops. A conflicting
    // withdrawal is uncertainty, never permission to replay the input.
    const conflict =
      attempt.pickedUpAt !== undefined && attempt.withdrawnAt !== undefined;
    // The provider can take the input after Canopy gave up waiting. Only an
    // acknowledgement from the live generation, strictly after the unknown,
    // proves the input is still deliverable; anything else stays uncertain.
    const lateAdmission =
      attempt.uncertainAt !== undefined &&
      attempt.admittedAt !== undefined &&
      attempt.admittedAt > attempt.uncertainAt &&
      attempt.generation === liveGeneration;
    const state = conflict
      ? 'uncertain'
      : attempt.pickedUpAt !== undefined
        ? 'picked-up'
        : attempt.uncertainAt !== undefined && !lateAdmission
          ? 'uncertain'
          : attempt.withdrawnAt !== undefined
            ? ['editing', 'queued', 'cancelled'].includes(row.state)
              ? row.state
              : 'cancelled'
            : row.state === 'cancelling'
              ? 'cancelling'
              : // Stop or recovery can make a row uncertain without an
                // `uncertainAt`; a later admission must not revive it.
                row.state === 'uncertain' && !lateAdmission
                ? 'uncertain'
                : attempt.admittedAt !== undefined
                  ? 'pending'
                  : row.state;
    // The uncertainty reason no longer describes the row once it resolves.
    const keepReason = row.state !== 'uncertain' || state === 'uncertain';
    const next: InputRow = {
      ...row,
      revision: row.revision + 1,
      attempts,
      state,
    };
    if (!keepReason) delete next.reason;
    return next;
  });
  return changed ? { ...ledger, rows } : ledger;
}

export function restoreInputLedger(
  ledger: InputLedger,
  liveGeneration?: string,
): InputLedger {
  let changed = false;
  const rows = ledger.rows.map((row): InputRow => {
    const attempt = row.attempts.find((a) => a.id === row.currentAttemptId);
    if (
      !attempt ||
      attempt.generation === liveGeneration ||
      !['sending', 'pending', 'cancelling'].includes(row.state)
    )
      return row;
    changed = true;
    if (row.state === 'cancelling' && row.queueIntent) {
      return {
        ...row,
        revision: row.revision + 1,
        state: 'cancelled',
        reason:
          'Move to queued was interrupted after the provider session ended. Retry Queue to finish the requested move.',
      };
    }
    return {
      ...row,
      revision: row.revision + 1,
      state: 'uncertain',
      reason:
        'The provider session ended before delivery was confirmed. This message will not be resent automatically.',
    };
  });
  return changed ? { ...ledger, rows } : ledger;
}

export function settleInputExecution(
  ledger: InputLedger,
  rootUserMessageId: string | undefined,
  status: string,
  now: number,
  onlyUnsettled = false,
): InputLedger {
  if (!rootUserMessageId) return ledger;
  let turnOutcome: NonNullable<ChatInputAttempt['turnOutcome']>;
  switch (status) {
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'interrupted':
      turnOutcome = status;
      break;
    default:
      return ledger;
  }
  let changed = false;
  const rows = ledger.rows.map((row) => {
    let rowChanged = false;
    const attempts = row.attempts.map((attempt) => {
      if (
        attempt.rootUserMessageId !== rootUserMessageId ||
        attempt.pickedUpAt === undefined ||
        (onlyUnsettled && attempt.turnSettledAt !== undefined) ||
        attempt.turnOutcome === turnOutcome
      )
        return attempt;
      changed = rowChanged = true;
      return {
        ...attempt,
        turnOutcome,
        turnSettledAt: now,
      };
    });
    return rowChanged ? { ...row, revision: row.revision + 1, attempts } : row;
  });
  return changed ? { ...ledger, rows } : ledger;
}
