import type { ResolvedAgentModelConfig } from '@canopy/desktop-shared/types';
import type { AgentSession } from './types';

const dispatchedModelConfigs = new WeakMap<
  AgentSession,
  { turnId: string; modelConfig: Readonly<ResolvedAgentModelConfig> }
>();

export function captureTypedSteerTurnModelConfig(
  session: AgentSession,
  turnId: string,
  modelConfig: ResolvedAgentModelConfig,
): void {
  dispatchedModelConfigs.set(session, {
    turnId,
    modelConfig: { ...modelConfig },
  });
}

export function readTypedSteerTurnModelConfig(
  session: AgentSession | undefined,
  turnId: string,
): Readonly<ResolvedAgentModelConfig> | undefined {
  if (!session || session.isDisposed?.() === true) return undefined;
  const captured = dispatchedModelConfigs.get(session);
  if (captured?.turnId !== turnId) return undefined;
  if (!session.getAppliedCodexThinkingLevel) return captured.modelConfig;

  const thinkingLevel = session.getAppliedCodexThinkingLevel(turnId);
  return thinkingLevel === undefined
    ? undefined
    : { ...captured.modelConfig, thinkingLevel };
}
