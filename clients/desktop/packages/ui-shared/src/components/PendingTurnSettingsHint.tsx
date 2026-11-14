import type { JSX } from 'react';
import {
  clampThinkingLevelToDeclared,
  isThinkingLevel,
} from '@canopy/protocol/thinking';
import { Badge } from './Badge';

/**
 * When a live session applies a model or thinking-level change: at once, or
 * only from the next turn it starts. Mirrors the desktop session info and the
 * Portal chat summary; hosts pass their own copy of it.
 */
export interface PendingTurnSettingApplication {
  readonly model: 'live' | 'next_turn';
  readonly thinkingLevel: 'live' | 'next_turn';
}

/** The model and thinking level the running turn applied. */
export interface PendingTurnAppliedSettings {
  readonly model?: string;
  readonly thinkingLevel?: string;
}

/** Which composer settings wait for the next turn. */
export interface PendingTurnSettings {
  readonly model: boolean;
  readonly thinkingLevel: boolean;
}

export interface PendingTurnSettingsInput {
  /** Whether a turn runs in the chat now. Nothing is pending between turns. */
  readonly turnActive: boolean;
  /** The session's declaration; absent for sessions that apply changes live. */
  readonly settingApplication?: PendingTurnSettingApplication;
  /** The running turn's settings; absent until the turn is known. */
  readonly turnSettings?: PendingTurnAppliedSettings;
  /** The composer's current selection. */
  readonly selected: PendingTurnAppliedSettings;
  /**
   * The thinking levels the selected route declares. A session applies a
   * stored level the route lacks as its nearest declared one, so the
   * selection is compared after the same clamp; without the list the raw
   * selection is compared.
   */
  readonly supportedThinkingLevels?: readonly string[];
}

/** The level the session would apply for a selection, given the declared set. */
function appliedThinkingLevel(
  selected: string | undefined,
  supported: readonly string[] | undefined,
): string | undefined {
  if (selected === undefined || supported === undefined) return selected;
  if (supported.includes(selected)) return selected;
  const declared = supported.filter(isThinkingLevel);
  return isThinkingLevel(selected) && declared.length > 0
    ? clampThinkingLevelToDeclared(selected, declared)
    : selected;
}

/**
 * The settings a change made during the running turn leaves pending: a
 * setting the session applies only from the next turn, whose current
 * selection differs from the one the running turn applied. Null when nothing
 * is pending, so callers render no cue. An unknown applied value is never
 * reported as pending.
 */
export function pendingTurnSettings(
  input: PendingTurnSettingsInput,
): PendingTurnSettings | null {
  const {
    turnActive,
    settingApplication,
    turnSettings,
    selected,
    supportedThinkingLevels,
  } = input;
  if (!turnActive || !settingApplication || !turnSettings) return null;
  const pending = (
    application: 'live' | 'next_turn',
    applied: string | undefined,
    current: string | undefined,
  ): boolean =>
    application === 'next_turn' &&
    applied !== undefined &&
    current !== undefined &&
    applied !== current;
  const model = pending(
    settingApplication.model,
    turnSettings.model,
    selected.model,
  );
  const thinkingLevel = pending(
    settingApplication.thinkingLevel,
    turnSettings.thinkingLevel,
    appliedThinkingLevel(selected.thinkingLevel, supportedThinkingLevels),
  );
  return model || thinkingLevel ? { model, thinkingLevel } : null;
}

/** The full sentence behind the terse visible label. */
export function pendingTurnSettingsDescription(
  pending: PendingTurnSettings,
): string {
  return pending.model && pending.thinkingLevel
    ? 'The model and thinking level changes apply to the next message.'
    : pending.model
      ? 'The model change applies to the next message.'
      : 'The thinking level change applies to the next message.';
}

export interface PendingTurnSettingsHintProps {
  /** From {@link pendingTurnSettings}; null renders nothing. */
  readonly pending: PendingTurnSettings | null;
  /** Placement classes only. */
  readonly className?: string;
  readonly 'data-testid'?: string;
}

/**
 * The composer cue that a model or thinking-level change made while a turn
 * runs waits for the next message, on sessions that apply such changes only
 * from their next turn. One `Badge`; it appears only while the running turn
 * still uses the earlier setting and disappears when the turn ends.
 */
export function PendingTurnSettingsHint({
  pending,
  className,
  'data-testid': testId = 'pending-turn-settings-hint',
}: PendingTurnSettingsHintProps): JSX.Element | null {
  if (!pending) return null;
  const description = pendingTurnSettingsDescription(pending);
  return (
    <Badge
      tone="info"
      title={description}
      data-testid={testId}
      {...(className ? { className } : {})}
    >
      {/* Terse on purpose; the visible text is the accessible name and the
          title carries the full sentence, so the name stays in the label. */}
      Applies to next message
    </Badge>
  );
}
