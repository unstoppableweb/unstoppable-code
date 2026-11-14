/**
 * Composer decision logic shared by the shared `ChatComposer` and the web
 * composer today; desktop adopts it in slice 4.
 *
 * These are the pure parts of the portal composer: usage projection,
 * execution-harness resolution, the thinking-chip cycle, and the mobile
 * overflow-menu build. They live here so both hosts (and the shared
 * `ChatComposer`) answer the same questions the same way, and so each one is
 * unit-testable without mounting a composer around a jsdom Slate editor.
 *
 * Extracted from `apps/web`'s `chat-input.tsx` unchanged (web chat parity,
 * slice 3); the composer body itself follows in the next PR.
 */
import type {
  PortalChatAgentProviderType,
  PortalChatUsage,
} from '@canopy/protocol/portal';
import {
  advanceThinkingLevelIn,
  clampThinkingLevelToSupported,
  type AgentExecutionHarness,
  type ModelCatalogThinkingLevel,
} from '@canopy/protocol/models';
import type { ThinkingLevel, ThinkingUiLevel } from '@canopy/protocol/thinking';
import type {
  ChatComposerOverflowMenuItemConfig,
  ModelCatalog,
  ModelCatalogOption,
  UsageIndicatorUsage,
} from '@canopy/ui-shared';
import {
  advanceChatThinkingLevel,
  type ChatThinkingProviderHint,
} from '@canopy/ui-shared/lib';
import { PlanModeIcon, ThinkingIcon } from '@canopy/ui-shared/icons';
import { FastModeIcon } from '@canopy/ui-shared/icons/AppIcons';

/**
 * The default placeholder lives in `@canopy/ui-shared` so the desktop composer,
 * the web composer, and the shared editor all word it from one place. Kept
 * here as a re-export so existing `@canopy/ui-app` imports keep working.
 */
export { defaultChatPlaceholder } from '@canopy/ui-shared/lib';

/**
 * Before the first answer no harness is bound yet, so a Codex model is
 * recognized from the catalog: the meter must not fabricate a 0 / window
 * context row for a harness that never reports context size.
 */
export function resolveUsageIndicatorIsCodex(
  executionHarness: string | undefined,
  availableModels: ModelCatalog | undefined,
  model: string | undefined,
): boolean {
  if (executionHarness !== undefined) return executionHarness === 'codex';
  return (
    availableModels?.find((option) => option.id === model)?.harness === 'codex'
  );
}

/**
 * Shape the projected summary usage for the shared meter. Cumulative counters
 * default to zero; cost, duration, and cache-write stay absent when the
 * runtime never reported them so their rows hide instead of reading `$0`.
 */
export function toUsageIndicatorUsage(
  usage: PortalChatUsage | undefined,
  fallbackContextWindow: number | undefined,
  fallbackModel: string | undefined,
): UsageIndicatorUsage | undefined {
  if (usage === undefined) return undefined;
  const resolvedWindow =
    usage.contextWindow !== undefined && usage.contextWindow > 0
      ? usage.contextWindow
      : (fallbackContextWindow ?? 0);
  // A window with no measured context would read as an empty context; a zero
  // window hides the Context row until the harness reports a size.
  const contextWindow = usage.contextTokens === undefined ? 0 : resolvedWindow;
  return {
    ...(usage.reportedTurnUsage !== undefined
      ? { reportedTurnUsage: usage.reportedTurnUsage }
      : {}),
    contextTokens: usage.contextTokens ?? 0,
    contextWindow,
    ...(usage.totalCostUsd === undefined
      ? {}
      : { totalCostUsd: usage.totalCostUsd }),
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadInputTokens: usage.cacheReadTokens ?? 0,
    ...(usage.cacheWriteTokens === undefined
      ? {}
      : { cacheCreationInputTokens: usage.cacheWriteTokens }),
    ...(usage.durationMs === undefined ? {} : { durationMs: usage.durationMs }),
    numTurns: usage.numTurns ?? 0,
    model: usage.model ?? fallbackModel ?? '',
  };
}

/** Prefer the host-captured execution harness over the model-source provider. */
export function resolvePortalExecutionHarness(
  providerType: ChatThinkingProviderHint,
  capturedHarness: AgentExecutionHarness | undefined,
): ChatThinkingProviderHint {
  return capturedHarness ?? providerType;
}

/**
 * Resolve execution controls from explicit model metadata. A session-captured
 * harness wins; otherwise, once a selected option exists, an unknown harness
 * stays unknown instead of falling back to a stale vendor-derived projection.
 */
export function resolveModelOptionProviderType(
  option: ModelCatalogOption | undefined,
  fallbackProviderType: PortalChatAgentProviderType | undefined,
  capturedHarness?: AgentExecutionHarness,
): PortalChatAgentProviderType | undefined {
  if (capturedHarness !== undefined) return capturedHarness;
  if (option === undefined) return fallbackProviderType;
  const provider = option.harness ?? option.provider;
  return provider === 'claude' ||
    provider === 'codex' ||
    provider === 'ollama' ||
    provider === 'cursor' ||
    provider === 'copilot' ||
    provider === 'opencode' ||
    provider === 'antigravity'
    ? provider
    : undefined;
}

/**
 * The completed text inserted when a command is chosen from the Commands
 * popup. The rule already lives with the `/` typeahead that shares it, so this
 * is the same function rather than a second copy of it.
 */
export { getSlashCommandInsertText } from '@canopy/ui-rich/plugins';

/**
 * Resolve the composer's thinking chip from the active model's projected
 * efforts (CAN-2441).
 *
 * - `display` is what the chip shows: a stored level the model does not
 *   support is clamped down to the nearest supported tier rather than
 *   vanishing.
 * - `next` is where the next press lands.
 *
 * With no projected levels (`supportedLevels` absent/empty — an older desktop,
 * or a model missing from the catalog) both fall back to the provider-level
 * cycle and the historical Codex `max → xhigh` display clamp.
 *
 * Exported so this is unit-testable without mounting the composer.
 */
export function resolveComposerThinking({
  current,
  executionHarness,
  supportedLevels,
}: {
  current: ThinkingUiLevel;
  executionHarness: ChatThinkingProviderHint;
  supportedLevels?: readonly ModelCatalogThinkingLevel[];
}): { display: ThinkingUiLevel; next: ThinkingUiLevel } {
  if (supportedLevels && supportedLevels.length > 0) {
    return {
      display: clampThinkingLevelToSupported(current, supportedLevels),
      next: advanceThinkingLevelIn(current, supportedLevels),
    };
  }
  const codexMaxClamped =
    executionHarness === 'codex' && current === 'max' ? 'xhigh' : current;
  return {
    display: codexMaxClamped,
    // The provider-fallback cycle has a home in ui-shared; this branch is the
    // legacy-host case it was written for.
    next: advanceChatThinkingLevel(codexMaxClamped, executionHarness),
  };
}

export interface ComposerOverflowMenuArgs {
  canUsePlanMode: boolean;
  supportsFastMode: boolean;
  effectivePlanMode: boolean;
  effectiveFastMode: boolean;
  displayThinkingLevel: ThinkingLevel;
  thinkingDefaultSelected?: boolean;
  thinkingLabel: string;
  commandsDisabled?: boolean;
  thinkingSupported?: boolean;
  onTogglePlan: () => void;
  onToggleFast: () => void;
  onCycleThinking: () => void;
}

/**
 * Build the mobile composer `⋯` overflow-menu items (CAN-1229) from the same
 * controlled state that drives the desktop inline chips. Availability gating
 * mirrors the chips exactly: plan mode only when `canUsePlanMode`, fast mode
 * only when the provider supports it (`supportsFastMode`, Codex), thinking
 * only when `thinkingSupported`. Plan/fast are toggles (`closeOnSelect`);
 * thinking is a cycler that
 * keeps the menu open so the advancing level stays visible. Exported so the
 * gating/state-label logic is unit-testable without mounting the composer.
 */
export function buildComposerOverflowMenuItems({
  canUsePlanMode,
  supportsFastMode,
  effectivePlanMode,
  effectiveFastMode,
  displayThinkingLevel,
  thinkingDefaultSelected = false,
  thinkingLabel,
  commandsDisabled = false,
  thinkingSupported = true,
  onTogglePlan,
  onToggleFast,
  onCycleThinking,
}: ComposerOverflowMenuArgs): ChatComposerOverflowMenuItemConfig[] {
  const items: ChatComposerOverflowMenuItemConfig[] = [];
  if (canUsePlanMode) {
    items.push({
      key: 'plan',
      icon: <PlanModeIcon size="sm" active={effectivePlanMode} />,
      label: 'Plan mode',
      stateLabel: effectivePlanMode ? 'On' : 'Off',
      active: effectivePlanMode,
      onSelect: onTogglePlan,
      closeOnSelect: true,
      ariaLabel: `Plan mode ${effectivePlanMode ? 'on' : 'off'}; tap to toggle`,
      dataTestId: 'portal-chat-overflow-plan',
    });
  }
  if (supportsFastMode) {
    items.push({
      key: 'fast',
      icon: <FastModeIcon size="sm" active={effectiveFastMode} />,
      label: 'Fast mode',
      stateLabel: effectiveFastMode ? 'On' : 'Off',
      active: effectiveFastMode,
      onSelect: onToggleFast,
      closeOnSelect: true,
      ariaLabel: `Fast mode ${effectiveFastMode ? 'on' : 'off'}; tap to toggle`,
      dataTestId: 'portal-chat-overflow-fast',
    });
  }
  if (thinkingSupported) {
    const stateLabel = thinkingDefaultSelected
      ? 'Default'
      : displayThinkingLevel === 'off'
        ? 'None'
        : thinkingLabel;
    items.push({
      key: 'thinking',
      icon: <ThinkingIcon aria-hidden="true" />,
      label: 'Thinking',
      stateLabel,
      active: !thinkingDefaultSelected && displayThinkingLevel !== 'off',
      // Multi-state cycler, not a binary toggle — a `menuitem` avoids the
      // misleading binary `aria-checked` a `menuitemcheckbox` would announce.
      role: 'menuitem',
      onSelect: (): void => {
        if (commandsDisabled) return;
        onCycleThinking();
      },
      closeOnSelect: false,
      ariaLabel: `Thinking level ${thinkingDefaultSelected ? 'default' : displayThinkingLevel}; tap to cycle`,
      dataTestId: 'portal-chat-overflow-thinking',
    });
  }
  return items;
}
