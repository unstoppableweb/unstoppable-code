import type { CanopyCapabilities } from './capabilities';

/** Cursor execution stays closed until exact-revision admission is supported. */
export function isCursorPlanExecutionUnavailable(
  plan: { readonly source?: unknown } | null | undefined,
): boolean {
  return plan?.source === 'cursor';
}

export interface ChatWorkflowCapabilities {
  readonly scheduledMessages: boolean;
  readonly planMode: boolean;
  readonly planReview: boolean;
  readonly planImplementation: boolean;
  readonly planPipeline: boolean;
  readonly deferredCapabilities: boolean;
  readonly independentFork: boolean;
  readonly branchedFork: boolean;
}

export type ChatWorkflowTarget =
  | 'worktree'
  | 'cowork'
  | 'app-advisor-entry'
  | 'app-advisor-global'
  | 'pipeline-assistant'
  | 'code-review'
  | 'cloud';

/** Callers resolve omitted stored providers through their canonical defaults first. */
export function deriveChatWorkflowCapabilities(input: {
  readonly resolvedProvider: string | undefined;
  readonly interfaceMode: string | undefined;
  readonly target: ChatWorkflowTarget | undefined;
  readonly capabilities: Pick<
    CanopyCapabilities,
    'automations' | 'worktreeBranching' | 'chatWorkflows'
  > &
    Partial<Pick<CanopyCapabilities, 'pipelines'>>;
}): ChatWorkflowCapabilities {
  const {
    resolvedProvider: provider,
    interfaceMode,
    target,
    capabilities,
  } = input;
  const knownProvider =
    provider === 'claude' ||
    provider === 'codex' ||
    provider === 'ollama' ||
    provider === 'cursor' ||
    provider === 'copilot' ||
    provider === 'opencode' ||
    provider === 'antigravity';
  const knownInterface =
    interfaceMode === 'canopy' ||
    interfaceMode === 'auto' ||
    interfaceMode === 'claude-code';
  const knownTarget =
    target === 'worktree' ||
    target === 'cowork' ||
    target === 'app-advisor-entry' ||
    target === 'app-advisor-global' ||
    target === 'pipeline-assistant' ||
    target === 'code-review' ||
    target === 'cloud';
  const resolved = knownProvider && knownInterface && knownTarget;
  const native = resolved && interfaceMode !== 'claude-code';
  const sessionTarget =
    target === 'worktree' ||
    target === 'cowork' ||
    target === 'app-advisor-entry';
  const existingWorkflows =
    provider === 'claude' || provider === 'codex' || provider === 'ollama';
  const openCodePlans = provider === 'opencode' && target !== 'cloud';
  const antigravityPlans = provider === 'antigravity' && target !== 'cloud';
  const supportedWorkflows =
    existingWorkflows ||
    (provider === 'cursor' && target !== 'cloud') ||
    openCodePlans ||
    antigravityPlans;
  const host = capabilities.chatWorkflows;
  const independentFork =
    native &&
    sessionTarget &&
    host?.independentFork === true &&
    (provider === 'claude' || provider === 'codex');
  return {
    scheduledMessages:
      native &&
      sessionTarget &&
      capabilities.automations === true &&
      (existingWorkflows || provider === 'opencode'),
    planMode: native && host?.planMode === true && supportedWorkflows,
    planReview: native && host?.planReview === true && supportedWorkflows,
    planImplementation:
      native &&
      host?.planReview === true &&
      (existingWorkflows || openCodePlans || antigravityPlans),
    planPipeline:
      native &&
      host?.planReview === true &&
      capabilities.pipelines === 'execute' &&
      (existingWorkflows || openCodePlans || antigravityPlans),
    deferredCapabilities:
      native && host?.deferredCapabilities === true && existingWorkflows,
    independentFork,
    branchedFork:
      independentFork &&
      target === 'worktree' &&
      capabilities.worktreeBranching === true,
  };
}
