/**
 * Canonical Codex speed semantics shared by desktop main, renderer, and CLI.
 *
 * `speed` is the source of truth. The legacy `fastMode` boolean is a
 * compatibility projection written atomically beside it as
 * `fastMode === (speed === 'fast')`; it is never `true` for `ultrafast` and is
 * never independently mutable. Browser-safe: no Node, Electron, or DOM.
 */
import { CODEX_SPEEDS, isCodexSpeed } from '@canopy/protocol/automations';
import type { CodexSpeed } from '@canopy/protocol/automations';
import { codexSpeedFastMode } from '@canopy/protocol/agent-model-config';
import type { AgentModelConfig } from '../execution-types';

export { CODEX_SPEEDS, codexSpeedFastMode, isCodexSpeed };
export type { CodexSpeed };

/** Speed used when neither a selection nor a default records one. */
export const DEFAULT_CODEX_SPEED: CodexSpeed = 'standard';

/** Interpret an explicit legacy boolean command: true → Fast, false → Regular. */
export function codexSpeedFromFastMode(enabled: boolean): CodexSpeed {
  return enabled ? 'fast' : 'standard';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve the speed recorded by ONE selection or default record.
 *
 * Precedence inside the record: a valid `speed`, then a boolean `fastMode`,
 * then each legacy alias in order (for example a tab's
 * `codexFastModeEnabled` or the deprecated `codexFastModeDefaultEnabled`
 * preference). Invalid values are ignored so legacy reads stay safe; command
 * boundaries must reject them before reaching this helper. Returns
 * `undefined` when the record carries no speed information, so callers can
 * fall through to the next record (selected before default).
 */
export function readCodexSpeedRecord(
  record: unknown,
  ...legacyAliases: readonly unknown[]
): CodexSpeed | undefined {
  if (isRecord(record)) {
    if (isCodexSpeed(record.speed)) return record.speed;
    if (typeof record.fastMode === 'boolean') {
      return codexSpeedFromFastMode(record.fastMode);
    }
  }
  for (const alias of legacyAliases) {
    if (typeof alias === 'boolean') return codexSpeedFromFastMode(alias);
  }
  return undefined;
}

/** Return `config` with `speed` and its derived `fastMode` set atomically. */
export function withCodexSpeed(
  config: AgentModelConfig | undefined,
  speed: CodexSpeed,
): AgentModelConfig {
  return { ...config, speed, fastMode: codexSpeedFastMode(speed) };
}

/**
 * Canonical write form of a record: when it carries any speed information,
 * both `speed` and the derived `fastMode` are present. A record without speed
 * information is returned as a shallow copy without either field.
 */
export function canonicalizeAgentModelConfig(
  config: AgentModelConfig,
): AgentModelConfig {
  const speed = readCodexSpeedRecord(config);
  if (speed === undefined) {
    const next: AgentModelConfig = { ...config };
    delete next.speed;
    delete next.fastMode;
    return next;
  }
  return withCodexSpeed(config, speed);
}

/**
 * THE shared explicit-command merge for model-config patches.
 *
 * - An explicit `speed` in the patch wins and derives `fastMode`.
 * - An explicit boolean `fastMode` without `speed` REPLACES the speed
 *   (`true` → Fast, `false` → Regular), including `false` on an Ultra fast
 *   record whose projected boolean is already `false`. There is deliberately
 *   no equality no-op heuristic.
 * - Unrelated patches (thinking, model) preserve the base speed.
 *
 * Snapshot/record hydration is different: an authoritative record replaces the
 * whole config and is read with {@link readCodexSpeedRecord} precedence
 * (speed first), not merged as a command patch.
 */
export function mergeAgentModelConfig(
  base: AgentModelConfig | undefined,
  patch: AgentModelConfig,
): AgentModelConfig {
  const merged: AgentModelConfig = { ...base, ...patch };
  const speed =
    readCodexSpeedRecord({ speed: patch.speed, fastMode: patch.fastMode }) ??
    readCodexSpeedRecord(base);
  if (speed === undefined) {
    delete merged.speed;
    delete merged.fastMode;
    return merged;
  }
  return withCodexSpeed(merged, speed);
}

/** Raised when a session or route cannot honor the exact requested speed. */
export class CodexSpeedUnsupportedError extends Error {
  readonly speed: CodexSpeed;

  constructor(speed: CodexSpeed, message: string) {
    super(message);
    this.name = 'CodexSpeedUnsupportedError';
    this.speed = speed;
  }
}

/** Structural subset of `AgentSession` speed setters. */
export interface CodexSpeedSessionSetters {
  setSpeed?(speed: CodexSpeed): Promise<void>;
  setFastMode?(enabled: boolean): Promise<void>;
  setCodexFastMode?(enabled: boolean): Promise<void>;
}

/**
 * Apply the exact requested speed to a live session before the next turn.
 * Prefers `setSpeed`. The legacy boolean setters are a fallback for Regular
 * and Fast only; Ultra fast is rejected (never downgraded) when the session
 * cannot receive an exact speed. A session with no speed setter at all is a
 * no-op for Regular/Fast, matching the prior optional-setter behavior.
 */
export async function applyAgentSessionCodexSpeed(
  session: CodexSpeedSessionSetters,
  speed: CodexSpeed,
): Promise<void> {
  if (session.setSpeed) {
    await session.setSpeed(speed);
    return;
  }
  if (speed === 'ultrafast') {
    throw new CodexSpeedUnsupportedError(
      speed,
      'This session cannot run Ultra fast. Choose Regular or Fast.',
    );
  }
  if (session.setFastMode) {
    await session.setFastMode(codexSpeedFastMode(speed));
    return;
  }
  if (session.setCodexFastMode) {
    await session.setCodexFastMode(codexSpeedFastMode(speed));
  }
}
