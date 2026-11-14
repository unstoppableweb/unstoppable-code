import {
  getProviderForModel,
  isTerminalBackedInterfaceMode,
  modelConfigForProviderSupportsFastMode,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';

/** The providers `core.chat.update`'s `chat.set_model` accepts. */
const CORE_CHAT_MODEL_PROVIDERS = new Set<string>([
  'claude',
  'codex',
  'ollama',
  'cursor',
  'opencode',
  'antigravity',
]);

/** A model, thinking, plan or speed change a client asks for. */
export type ChatSettingsChange =
  | { kind: 'model'; model: string }
  | { kind: 'thinking' }
  | { kind: 'plan'; planMode: boolean }
  | { kind: 'fast' };

/** Why a change cannot run behind `core.chat.update` alone. */
export type ChatSettingsGuard =
  | 'model_with_window'
  | 'unsupported_provider'
  | 'file_tab'
  | 'read_only'
  | 'pending_plan'
  | 'no_fast_mode'
  | 'visible_terminal';

export type ChatSettingsRoute =
  | { route: 'core' }
  | { route: 'window'; guard: ChatSettingsGuard };

/**
 * Whether a settings change runs through `core.chat.update` (CAN-4110 D7) or
 * needs the window, which keeps the chat's live state: a model change while
 * a window is open, a tab the window refuses, plan mode turning off over a
 * pending plan exit, a speed on a provider without one, or a visible Claude
 * terminal that relaunches at once. With no tab the core answers not_found.
 */
export function chatSettingsRoute(
  change: ChatSettingsChange,
  tab: PersistedChatTab | undefined,
  windowOpen: boolean,
): ChatSettingsRoute {
  if (change.kind === 'model') {
    if (windowOpen) return { route: 'window', guard: 'model_with_window' };
    const provider = getProviderForModel(change.model);
    if (!provider || !CORE_CHAT_MODEL_PROVIDERS.has(provider))
      return { route: 'window', guard: 'unsupported_provider' };
  }
  if (!tab) return { route: 'core' };
  if (tab.kind === 'file') return { route: 'window', guard: 'file_tab' };
  if (tab.readOnly === true) return { route: 'window', guard: 'read_only' };
  if (
    change.kind === 'plan' &&
    !change.planMode &&
    (tab.pendingPlanExit !== undefined ||
      tab.pendingPlanExitRequestId !== undefined ||
      (Boolean(tab.trackedPlanId) && tab.trackedPlanReviewStatus === 'pending'))
  )
    return { route: 'window', guard: 'pending_plan' };
  const provider =
    tab.providerType ??
    (tab.model ? getProviderForModel(tab.model) : undefined);
  if (
    change.kind === 'fast' &&
    (!provider || !modelConfigForProviderSupportsFastMode(provider))
  )
    return { route: 'window', guard: 'no_fast_mode' };
  if (
    windowOpen &&
    isTerminalBackedInterfaceMode(tab.interfaceMode) &&
    provider === 'claude'
  )
    return { route: 'window', guard: 'visible_terminal' };
  return { route: 'core' };
}
