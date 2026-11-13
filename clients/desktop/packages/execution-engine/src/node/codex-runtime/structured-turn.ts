import type { HelperUsage } from '@canopy/execution-engine/lib/helper-usage';
import { extractProposedPlan } from '@canopy/execution-engine/codex-plan-mode';
import type { ThreadItem } from './generated/v2/ThreadItem';
import type { ThreadTokenUsage } from './generated/v2/ThreadTokenUsage';

export function helperUsageFromThreadTokenUsage(
  tokenUsage: ThreadTokenUsage | null,
): HelperUsage {
  if (!tokenUsage) {
    return {};
  }
  return {
    inputTokens: tokenUsage.last.inputTokens,
    cacheReadInputTokens: tokenUsage.last.cachedInputTokens,
    outputTokens: tokenUsage.last.outputTokens,
    reasoningOutputTokens: tokenUsage.last.reasoningOutputTokens,
  };
}

export function finalAssistantText(items: ThreadItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === 'agentMessage') {
      return item.text;
    }
  }
  return '';
}

export function proposedPlanText(
  items: ThreadItem[],
  finalText: string,
): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === 'plan') {
      const plan = item.text.trim();
      if (plan.length > 0) {
        return plan;
      }
    }
  }
  return extractProposedPlan(finalText);
}

export function parseStructuredFinalText<T>(finalText: string): T {
  return JSON.parse(finalText) as T;
}
