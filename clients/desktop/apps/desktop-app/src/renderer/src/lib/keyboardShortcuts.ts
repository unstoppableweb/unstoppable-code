import {
  CHAT_LABEL,
  CUSTOMIZE_LABEL,
  ORCHESTRATOR_LABEL,
  WORKTREE_LABEL_PLURAL,
  WORKTREE_UNIT_LABEL,
} from '@canopy/protocol';
import type { NavigationPage } from '@/stores/navigationStore';
import {
  hasClosestMethod,
  isMacPlatform,
  isShortcutEvent,
  type ShortcutEventLike,
} from '@canopy/ui-app/find';
import { formatShortcut as formatShortcutHint } from '@canopy/ui-shared/lib/shortcuts';

export type CommandCategory =
  | 'navigation'
  | 'worktrees'
  | 'chat'
  | 'app-advisor'
  | 'settings'
  | 'activity'
  | 'panels';

export type CommandId =
  | 'open-command-palette'
  | 'open-file-search-palette'
  | 'new-task'
  | 'new-worktree'
  | 'new-worktree-current-context'
  | 'new-chat-tab'
  | 'new-terminal-tab'
  | 'new-browser-tab'
  | 'focus-browser-address-bar'
  | 'find-in-surface'
  | 'browser-history-back'
  | 'browser-history-forward'
  | 'app-history-back'
  | 'app-history-forward'
  | 'toggle-sidebar'
  | 'open-workspace-picker'
  | 'open-model-picker'
  | 'cycle-effort-level'
  | 'toggle-dictation'
  | 'open-terminal'
  | 'chat-attachments'
  | 'close-chat-tab'
  | 'open-app-advisor'
  | 'open-app-advisor-quick-prompt'
  | 'open-settings'
  | 'open-shortcuts-settings'
  | 'open-environment-settings'
  | 'open-current-pr'
  | 'open-ledger-panel'
  | 'open-cost-panel'
  | 'open-session-breakdown'
  | 'navigate-overview'
  | 'navigate-worktrees'
  | 'navigate-chat'
  | 'navigate-pipelines'
  | 'navigate-automations'
  | 'navigate-feed'
  | 'navigate-plugins'
  | 'navigate-audit'
  | 'navigate-statistics'
  | 'navigate-usage'
  | 'switch-context-personal'
  | 'switch-context-organization'
  | 'open-organization-page'
  | 'toggle-activity-panel'
  | 'refresh-worktree-status'
  | 'open-worktree-scripts'
  | 'open-worktree-hooks'
  | 'panel-split-right'
  | 'panel-split-down'
  | 'panel-focus-next-group'
  | 'panel-focus-previous-group'
  | 'panel-focus-group-left'
  | 'panel-focus-group-right'
  | 'panel-focus-group-up'
  | 'panel-focus-group-down'
  | 'panel-move-to-next-group'
  | 'panel-toggle-maximize'
  | 'panel-close-group'
  | 'panel-even-sizes'
  | 'panel-select-next-tab'
  | 'panel-select-previous-tab';

export interface CommandDefinition {
  id: CommandId;
  title: string;
  subtitle?: string;
  category: CommandCategory;
  keywords: string[];
  shortcut?: string;
  page?: NavigationPage;
  requiresWorktree?: boolean;
  /**
   * When set with `requiresWorktree`, a selected cowork work entry also
   * satisfies the requirement (the command works on both surfaces).
   */
  allowCoworkSelection?: boolean;
  requiresActiveChatTab?: boolean;
  /** Also requires the active tab to be a conversation, not a file. */
  requiresActiveConversationTab?: boolean;
}

export type WorktreeSettingsTab = 'scripts' | 'hooks' | 'environment';

export interface OpenWorktreeSettingsEventDetail {
  tab: WorktreeSettingsTab;
}

interface SearchableCommandDefinition {
  title: string;
  subtitle?: string;
  category: CommandCategory;
  keywords: string[];
}

export const OPEN_WORKTREE_SETTINGS_EVENT = 'canopy:open-worktree-settings';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural `Node` check, for callers that need to pass a target to
 * `Node.contains()`. Same realm caveat as {@link hasClosestMethod}: nodes from
 * a popped-out panel window are not `instanceof` the main realm's `Node`.
 */
export function isNodeTarget(value: EventTarget | null): value is Node {
  return isRecord(value) && typeof value.nodeType === 'number';
}

function normalizeQueryValue(value: string): string {
  return value.trim().toLowerCase();
}

function matchesCommandQuery(
  command: SearchableCommandDefinition,
  normalizedQuery: string,
): boolean {
  if (normalizedQuery.length === 0) {
    return true;
  }

  const parts = [
    command.title,
    command.subtitle ?? '',
    command.category,
    ...command.keywords,
  ];

  return parts.some((part) =>
    normalizeQueryValue(part).includes(normalizedQuery),
  );
}

/**
 * Names the Windows/Linux alternate tab-cycling chord in a command subtitle
 * (`. Ctrl PageDown also works`). macOS has no alternate, so it adds nothing.
 */
function tabCycleAlternateHint(
  id: 'panel-select-next-tab-alternate' | 'panel-select-previous-tab-alternate',
): string {
  return isMacPlatform() ? '' : `. ${formatShortcutHint(id)} also works`;
}

/**
 * Picks a display string by platform, for a chord that is not in the shared
 * shortcut registry (a user-recorded or reserved accelerator). Bindings the
 * app owns read their keys from `@canopy/ui-shared/lib/shortcuts` instead,
 * so every hint spells them the same way.
 */
export function formatShortcut(mac: string, other: string): string {
  return isMacPlatform() ? mac : other;
}

/**
 * Hold ⌃M to dictate into the composer on screen; a quick tap keeps it
 * listening until the next tap.
 */
export const DICTATION_SHORTCUT_LABEL = formatShortcutHint('toggle-dictation');

/**
 * Control+M on every platform (Control, not ⌘, on macOS, and free on both:
 * ⌘⇧D, the obvious "dictate" letter, already splits panels down, which is
 * Ctrl+Shift+D on Windows). Matched by physical `code` so layouts that move M
 * still bind the same key.
 */
export function isDictationShortcutEvent(event: ShortcutEventLike): boolean {
  return (
    !event.isComposing &&
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.code === 'KeyM'
  );
}

/**
 * Alt-bearing chord matched by physical key `code` rather than `key`
 * (ECW-7984 follow-up: ⌥W workspace picker, ⌥M model picker, ⌥T effort
 * level).
 *
 * `isShortcutEvent` deliberately refuses Option+<letter> — see its comment:
 * on macOS Option composes a special character, so `event.key` arrives as
 * `∑`/`µ`/`†` rather than the letter. `event.code` stays `KeyW`/`KeyM`/`KeyT`
 * on every platform and layout-independent, which makes it the only stable
 * way to bind an Alt+letter chord.
 *
 * `primary` selects the platform's app modifier (Cmd on macOS, Ctrl
 * elsewhere), matching `isShortcutEvent`. Default `false` = a bare-Option
 * chord, which never collides with the Cmd-based app chords or the ⌘⌥ panel
 * bindings. No production chord passes `primary: true` today — it exists so a
 * ⌘⌥ letter chord (the deferred ⌘⌥B right-panel toggle) can be added without
 * rediscovering the composition rule; it is covered by unit tests.
 */
export function isAltCodeShortcutEvent(
  event: ShortcutEventLike,
  code: string,
  opts?: { primary?: boolean; shift?: boolean },
): boolean {
  if (event.isComposing) {
    return false;
  }

  if (!event.altKey || event.code !== code) {
    return false;
  }

  if (event.shiftKey !== (opts?.shift === true)) {
    return false;
  }

  if (opts?.primary !== true) {
    return !event.metaKey && !event.ctrlKey;
  }

  return isMacPlatform()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/**
 * Platform-correct browser-history chord: Cmd+Arrow on macOS, or either
 * Ctrl+Arrow / plain Alt+Arrow on Windows and Linux.
 */
export function isBrowserHistoryShortcutEvent(
  event: ShortcutEventLike,
  key: 'ArrowLeft' | 'ArrowRight',
): boolean {
  if (isShortcutEvent(event, key)) {
    return true;
  }

  return (
    !isMacPlatform() &&
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === key.toLowerCase()
  );
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!hasClosestMethod(target)) {
    return false;
  }

  return (
    target.closest('input, textarea, select, [contenteditable="true"]') !== null
  );
}

export { isTerminalTarget } from '@canopy/ui-app/terminal-core';
// Shared with the web shell through the find bar's shortcut router.
export {
  hasClosestMethod,
  isBehindModal,
  isDialogTarget,
  isMacPlatform,
  isShortcutEvent,
  readTargetOwnerDocument,
  type ClosestCapableTarget,
  type ShortcutEventLike,
} from '@canopy/ui-app/find';

/**
 * True when the event target sits inside the in-app browser surface's React
 * chrome (tab strip, address bar, inspector — everything under
 * `BrowserPanelSurface`, which carries `data-browser-surface`). Used by the
 * context-aware shortcut routing (ECW-7984): browser-owned chords (⌘T new
 * browser tab, ⌘L focus address bar, ⌘←/⌘→ history) fire for browser-chrome
 * focus. Keydowns inside the NATIVE page never reach the renderer; the main
 * process routes those (`main/browser/browser-shortcuts.ts`).
 */
export function isBrowserSurfaceTarget(target: EventTarget | null): boolean {
  if (!hasClosestMethod(target)) {
    return false;
  }

  return target.closest('[data-browser-surface]') !== null;
}

export function filterCommandDefinitions<T extends SearchableCommandDefinition>(
  commands: T[],
  query: string,
): T[] {
  const normalizedQuery = normalizeQueryValue(query);
  return commands.filter((command) =>
    matchesCommandQuery(command, normalizedQuery),
  );
}

export function isOpenWorktreeSettingsEventDetail(
  value: unknown,
): value is OpenWorktreeSettingsEventDetail {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.tab === 'scripts' ||
    value.tab === 'hooks' ||
    value.tab === 'environment'
  );
}

export function dispatchOpenWorktreeSettingsEvent(
  tab: WorktreeSettingsTab,
): void {
  const detail: OpenWorktreeSettingsEventDetail = { tab };
  window.dispatchEvent(
    new CustomEvent(OPEN_WORKTREE_SETTINGS_EVENT, { detail }),
  );
}

export const COMMAND_DEFINITIONS: CommandDefinition[] = [
  {
    id: 'open-command-palette',
    title: 'Open command palette',
    category: 'navigation',
    keywords: ['command', 'palette', 'search', 'commands'],
    shortcut: formatShortcutHint('open-command-palette'),
  },
  {
    id: 'open-file-search-palette',
    title: 'Find file',
    subtitle: `Search files in the current ${WORKTREE_UNIT_LABEL.toLowerCase()} and open in a file tab`,
    category: 'navigation',
    keywords: ['file', 'find', 'search', 'open', 'goto', 'fuzzy'],
    shortcut: formatShortcutHint('open-file-search-palette'),
    requiresWorktree: true,
    allowCoworkSelection: true,
  },
  {
    id: 'new-task',
    title: 'New task',
    subtitle: 'Open the home surface to start a new task',
    category: 'worktrees',
    keywords: ['new', 'task', 'home', 'start', 'compose'],
    shortcut: formatShortcutHint('new-task'),
  },
  {
    id: 'new-worktree',
    title: `New ${WORKTREE_UNIT_LABEL}`,
    subtitle: `Create a ${WORKTREE_UNIT_LABEL.toLowerCase()} in the current project or choose one`,
    category: 'worktrees',
    keywords: ['new', 'worktree', 'workspace', 'branch', 'create'],
  },
  {
    id: 'new-worktree-current-context',
    title: `New ${WORKTREE_UNIT_LABEL} in current project`,
    subtitle: 'Create from the selected project',
    category: 'worktrees',
    keywords: ['new', 'worktree', 'workspace', 'current', 'selected'],
    requiresWorktree: true,
  },
  {
    id: 'new-chat-tab',
    title: 'New tab',
    subtitle: `Open a new tab in the focused surface (chat by default) of the selected ${WORKTREE_UNIT_LABEL.toLowerCase()}`,
    category: 'chat',
    keywords: ['new', 'chat', 'tab', 'conversation'],
    shortcut: formatShortcutHint('new-chat-tab'),
    requiresWorktree: true,
  },
  {
    id: 'new-terminal-tab',
    title: 'New terminal tab',
    subtitle: `${formatShortcutHint('new-terminal-tab')} while the terminal surface is focused`,
    category: 'panels',
    keywords: ['new', 'terminal', 'tab', 'shell'],
    shortcut: formatShortcutHint('new-terminal-tab'),
  },
  {
    id: 'new-browser-tab',
    title: 'New browser tab',
    subtitle: `${formatShortcutHint('new-browser-tab')} while the browser is focused — selects the tab and focuses its address bar`,
    category: 'panels',
    keywords: ['new', 'browser', 'tab', 'web'],
    shortcut: formatShortcutHint('new-browser-tab'),
  },
  {
    id: 'focus-browser-address-bar',
    title: 'Focus browser address bar',
    subtitle: `${formatShortcutHint('focus-browser-address-bar')} while the browser is focused`,
    category: 'panels',
    keywords: ['browser', 'address', 'url', 'bar', 'focus', 'location'],
    shortcut: formatShortcutHint('focus-browser-address-bar'),
  },
  {
    id: 'find-in-surface',
    title: 'Find in chat, browser, file, or terminal',
    subtitle: `${formatShortcutHint('find-in-surface')} while a chat, browser, file, or terminal is focused`,
    category: 'panels',
    keywords: [
      'find',
      'search',
      'chat',
      'browser',
      'page',
      'file',
      'text',
      'terminal',
    ],
    shortcut: formatShortcutHint('find-in-surface'),
  },
  {
    id: 'browser-history-back',
    title: 'Browser back',
    subtitle: 'Navigate the active browser tab back in its own history',
    category: 'panels',
    keywords: ['browser', 'back', 'history', 'navigate'],
    shortcut: formatShortcutHint('browser-history-back'),
  },
  {
    id: 'browser-history-forward',
    title: 'Browser forward',
    subtitle: 'Navigate the active browser tab forward in its own history',
    category: 'panels',
    keywords: ['browser', 'forward', 'history', 'navigate'],
    shortcut: formatShortcutHint('browser-history-forward'),
  },
  {
    id: 'app-history-back',
    title: 'Back',
    subtitle: 'Go back in app navigation history',
    category: 'navigation',
    keywords: ['back', 'history', 'navigate', 'previous'],
    shortcut: formatShortcutHint('app-history-back'),
  },
  {
    id: 'app-history-forward',
    title: 'Forward',
    subtitle: 'Go forward in app navigation history',
    category: 'navigation',
    keywords: ['forward', 'history', 'navigate', 'next'],
    shortcut: formatShortcutHint('app-history-forward'),
  },
  {
    id: 'toggle-sidebar',
    title: 'Toggle sidebar',
    subtitle: 'Show or hide the left navigation sidebar',
    category: 'panels',
    keywords: ['sidebar', 'navbar', 'navigation', 'toggle', 'hide', 'show'],
    shortcut: formatShortcutHint('toggle-sidebar'),
  },
  {
    id: 'open-workspace-picker',
    title: 'Open project picker',
    subtitle: 'Choose the project for the task you are describing',
    category: 'navigation',
    keywords: ['workspace', 'picker', 'selector', 'project', 'repo'],
    shortcut: formatShortcutHint('open-workspace-picker'),
  },
  {
    id: 'open-model-picker',
    title: 'Open model picker',
    subtitle: 'Choose the model for the active composer',
    category: 'chat',
    keywords: ['model', 'picker', 'selector', 'provider', 'claude', 'codex'],
    shortcut: formatShortcutHint('open-model-picker'),
  },
  {
    id: 'cycle-effort-level',
    title: 'Cycle effort level',
    subtitle: 'Step the active composer through its effort levels',
    category: 'chat',
    keywords: ['effort', 'thinking', 'reasoning', 'level', 'toggle', 'cycle'],
    shortcut: formatShortcutHint('cycle-effort-level'),
  },
  {
    id: 'toggle-dictation',
    title: 'Dictate',
    subtitle: 'Hold to dictate into the active composer; tap to keep listening',
    category: 'chat',
    keywords: ['voice', 'dictation', 'dictate', 'microphone', 'speech'],
    shortcut: DICTATION_SHORTCUT_LABEL,
  },
  {
    id: 'open-terminal',
    title: 'Open terminal',
    subtitle: `Show the terminal panel for the selected ${WORKTREE_UNIT_LABEL.toLowerCase()} (spawns one when empty)`,
    category: 'panels',
    keywords: ['terminal', 'open', 'shell', 'console', 'toggle'],
    shortcut: formatShortcutHint('open-terminal'),
  },
  {
    id: 'chat-attachments',
    title: 'Add attachments',
    subtitle: `Open the ${CHAT_LABEL.toLowerCase()} composer's file picker`,
    category: 'chat',
    keywords: ['attachment', 'attach', 'file', 'upload', 'image'],
    shortcut: formatShortcutHint('chat-attachments'),
  },
  {
    id: 'close-chat-tab',
    title: 'Close tab',
    category: 'chat',
    keywords: ['close', 'chat', 'tab'],
    shortcut: formatShortcutHint('close-chat-tab'),
    requiresWorktree: true,
    requiresActiveChatTab: true,
  },
  {
    id: 'open-app-advisor',
    title: `Open ${ORCHESTRATOR_LABEL}`,
    category: 'app-advisor',
    keywords: ['app', 'advisor', 'orchestrator', 'assistant', 'open'],
    shortcut: formatShortcutHint('open-app-advisor'),
  },
  {
    id: 'open-app-advisor-quick-prompt',
    title: `${ORCHESTRATOR_LABEL} quick prompt`,
    subtitle: `Send a prompt to a new ${ORCHESTRATOR_LABEL} chat`,
    category: 'app-advisor',
    keywords: [
      'app',
      'advisor',
      'orchestrator',
      'assistant',
      'prompt',
      'quick',
      'chat',
    ],
    shortcut: formatShortcutHint('open-app-advisor-quick-prompt'),
  },
  {
    id: 'open-settings',
    title: 'Open settings',
    category: 'settings',
    keywords: ['settings', 'preferences', 'config'],
    shortcut: formatShortcutHint('open-settings'),
  },
  {
    id: 'open-shortcuts-settings',
    title: 'Keyboard shortcuts',
    subtitle: 'Open settings to the shortcuts page',
    category: 'settings',
    keywords: ['keyboard', 'shortcuts', 'keys', 'settings'],
    shortcut: formatShortcutHint('open-shortcuts-settings'),
  },
  {
    id: 'open-environment-settings',
    title: 'Open Environments settings',
    category: 'settings',
    keywords: ['environments', 'env', 'variables', 'runtime', 'secrets'],
  },
  {
    id: 'open-current-pr',
    title: 'Open pull request',
    subtitle: `Open the pull request for the selected ${WORKTREE_UNIT_LABEL.toLowerCase()} in the browser`,
    category: 'activity',
    keywords: ['pr', 'pull', 'request', 'open', 'github', 'browser'],
    shortcut: formatShortcutHint('open-current-pr'),
    requiresWorktree: true,
  },
  {
    id: 'open-ledger-panel',
    title: 'Open Feed panel',
    subtitle: `Show what agents recorded for the selected ${WORKTREE_UNIT_LABEL.toLowerCase()}`,
    category: 'panels',
    keywords: [
      'feed',
      'ledger',
      'agent ledger',
      'entries',
      'decisions',
      'tasks',
      'record',
    ],
    requiresWorktree: true,
    allowCoworkSelection: true,
  },
  {
    id: 'open-cost-panel',
    title: 'Open Cost panel',
    subtitle: `Show observed cost for the selected ${WORKTREE_UNIT_LABEL.toLowerCase()}`,
    category: 'panels',
    keywords: ['cost', 'observed cost', 'spending', 'panel'],
    requiresWorktree: true,
    allowCoworkSelection: true,
  },
  {
    id: 'open-session-breakdown',
    title: 'Open Session breakdown',
    subtitle: "Open the active chat's cost, context and activity",
    category: 'panels',
    keywords: ['session', 'breakdown', 'cost', 'context', 'activity'],
    requiresWorktree: true,
    allowCoworkSelection: true,
    requiresActiveChatTab: true,
    requiresActiveConversationTab: true,
  },
  {
    id: 'navigate-overview',
    title: 'Open Overview',
    category: 'navigation',
    keywords: ['overview', 'home', 'dashboard'],
    shortcut: formatShortcutHint('navigate-overview'),
    page: 'overview',
  },
  {
    id: 'navigate-worktrees',
    title: `Open ${WORKTREE_LABEL_PLURAL}`,
    category: 'navigation',
    keywords: ['worktrees', 'workspace', 'main'],
    shortcut: formatShortcutHint('navigate-worktrees'),
    page: 'main',
  },
  {
    id: 'navigate-chat',
    title: `Open ${CHAT_LABEL}`,
    category: 'navigation',
    keywords: ['chat', 'standalone', 'conversation'],
    shortcut: formatShortcutHint('navigate-chat'),
    page: 'chat',
  },
  {
    id: 'navigate-pipelines',
    title: 'Open Workflows: Library',
    category: 'navigation',
    keywords: [
      'workflows',
      'library',
      'pipelines',
      'pipeline',
      'automations',
      'automation',
    ],
    shortcut: formatShortcutHint('navigate-pipelines'),
    page: 'workflows-library',
  },
  {
    id: 'navigate-automations',
    title: 'Open Workflows',
    category: 'navigation',
    keywords: [
      'workflows',
      'automations',
      'automation',
      'pipelines',
      'triggered',
      'schedule',
      'scheduled',
      'calendar',
      'cron',
      'watchers',
      'runs',
    ],
    shortcut: formatShortcutHint('navigate-automations'),
    page: 'workflows',
  },
  {
    id: 'navigate-feed',
    title: 'Go to Feed',
    category: 'navigation',
    keywords: ['feed', 'ledger', 'entries', 'activity', 'teammates', 'devices'],
    page: 'feed',
  },
  {
    id: 'navigate-plugins',
    title: `Open ${CUSTOMIZE_LABEL}`,
    category: 'navigation',
    keywords: [
      'customize',
      'marketplace',
      'plugins',
      'collections',
      'bundles',
      'skills',
      'mcp',
      'pipelines',
      'automations',
    ],
    shortcut: formatShortcutHint('navigate-plugins'),
    page: 'plugins',
  },
  {
    id: 'navigate-audit',
    title: 'Open Audit trail',
    category: 'navigation',
    keywords: ['audit', 'trail', 'observability'],
    shortcut: formatShortcutHint('navigate-audit'),
    page: 'audit',
  },
  {
    id: 'navigate-statistics',
    title: 'Open Statistics',
    category: 'navigation',
    keywords: ['statistics', 'stats', 'tokens', 'activity', 'metrics'],
    shortcut: formatShortcutHint('navigate-statistics'),
    page: 'statistics',
  },
  {
    id: 'navigate-usage',
    title: 'Open Usage',
    category: 'navigation',
    keywords: ['usage', 'subscription', 'limits', 'cost'],
    shortcut: formatShortcutHint('navigate-usage'),
    page: 'usage',
  },
  {
    id: 'toggle-activity-panel',
    title: 'Toggle activity panel',
    category: 'activity',
    keywords: ['activity', 'panel', 'sidebar', 'toggle', 'right'],
  },
  {
    id: 'refresh-worktree-status',
    title: `Refresh ${WORKTREE_UNIT_LABEL} Status`,
    category: 'activity',
    keywords: ['refresh', 'worktree', 'status', 'diff'],
  },
  {
    id: 'open-worktree-scripts',
    title: `Open ${WORKTREE_UNIT_LABEL} Scripts`,
    category: 'activity',
    keywords: ['scripts', 'worktree', 'settings', 'commands'],
    requiresWorktree: true,
  },
  {
    id: 'open-worktree-hooks',
    title: `Open ${WORKTREE_UNIT_LABEL} Hooks`,
    category: 'activity',
    keywords: ['hooks', 'worktree', 'settings', 'automation'],
    requiresWorktree: true,
  },
  // Panel-grid operations (doc 12 §1). All dispatch through the panel layout
  // store against the ACTIVE group of the selected worktree's layout; the run
  // implementations and availability predicates live in
  // `lib/panels/commands.ts` (one definition, consumed by the palette and the
  // global shortcuts).
  {
    id: 'panel-split-right',
    title: 'Split panel right',
    subtitle: 'Split the active panel group to the right',
    category: 'panels',
    keywords: ['panel', 'split', 'right', 'group', 'layout', 'grid'],
    shortcut: formatShortcutHint('panel-split-right'),
    requiresWorktree: true,
  },
  {
    id: 'panel-split-down',
    title: 'Split panel down',
    subtitle: 'Split the active panel group downward',
    category: 'panels',
    keywords: ['panel', 'split', 'down', 'group', 'layout', 'grid'],
    shortcut: formatShortcutHint('panel-split-down'),
    requiresWorktree: true,
  },
  {
    id: 'panel-focus-next-group',
    title: 'Focus next panel group',
    category: 'panels',
    keywords: ['panel', 'focus', 'next', 'group', 'cycle'],
    shortcut: formatShortcutHint('panel-focus-next-group'),
    requiresWorktree: true,
  },
  {
    id: 'panel-focus-previous-group',
    title: 'Focus previous panel group',
    category: 'panels',
    keywords: ['panel', 'focus', 'previous', 'group', 'cycle'],
    shortcut: formatShortcutHint('panel-focus-previous-group'),
    requiresWorktree: true,
  },
  {
    id: 'panel-focus-group-left',
    title: 'Focus panel group left',
    category: 'panels',
    keywords: ['panel', 'focus', 'left', 'group', 'direction'],
    shortcut: formatShortcutHint('panel-focus-group-left'),
    requiresWorktree: true,
  },
  {
    id: 'panel-focus-group-right',
    title: 'Focus panel group right',
    category: 'panels',
    keywords: ['panel', 'focus', 'right', 'group', 'direction'],
    shortcut: formatShortcutHint('panel-focus-group-right'),
    requiresWorktree: true,
  },
  {
    id: 'panel-focus-group-up',
    title: 'Focus panel group up',
    category: 'panels',
    keywords: ['panel', 'focus', 'up', 'above', 'group', 'direction'],
    shortcut: formatShortcutHint('panel-focus-group-up'),
    requiresWorktree: true,
  },
  {
    id: 'panel-focus-group-down',
    title: 'Focus panel group down',
    category: 'panels',
    keywords: ['panel', 'focus', 'down', 'below', 'group', 'direction'],
    shortcut: formatShortcutHint('panel-focus-group-down'),
    requiresWorktree: true,
  },
  {
    id: 'panel-move-to-next-group',
    title: 'Move panel to next group',
    subtitle: 'Move the active panel into the next panel group',
    category: 'panels',
    keywords: ['panel', 'move', 'next', 'group', 'tab'],
    shortcut: formatShortcutHint('panel-move-to-next-group'),
    requiresWorktree: true,
  },
  {
    id: 'panel-toggle-maximize',
    title: 'Toggle maximized panel group',
    subtitle: 'Maximize or restore the active panel group',
    category: 'panels',
    keywords: ['panel', 'maximize', 'restore', 'group', 'toggle', 'zoom'],
    shortcut: formatShortcutHint('panel-toggle-maximize'),
    requiresWorktree: true,
  },
  {
    id: 'panel-close-group',
    title: 'Close panel group',
    subtitle: 'Close the active panel group and its tabs',
    category: 'panels',
    keywords: ['panel', 'close', 'group', 'remove'],
    shortcut: formatShortcutHint('panel-close-group'),
    requiresWorktree: true,
  },
  {
    id: 'panel-even-sizes',
    title: 'Even panel group sizes',
    subtitle: 'Distribute sizes evenly across all panel groups',
    category: 'panels',
    keywords: ['panel', 'even', 'sizes', 'distribute', 'arrange', 'group'],
    shortcut: formatShortcutHint('panel-even-sizes'),
    requiresWorktree: true,
  },
  {
    id: 'panel-select-next-tab',
    title: 'Select next tab',
    subtitle: `Switch to the next tab in the active panel group, wrapping at the end${tabCycleAlternateHint('panel-select-next-tab-alternate')}`,
    category: 'panels',
    keywords: [
      'tab',
      'next',
      'previous',
      'switch',
      'cycle',
      'chat',
      'panel',
      'group',
    ],
    shortcut: formatShortcutHint('panel-select-next-tab'),
    requiresWorktree: true,
  },
  {
    id: 'panel-select-previous-tab',
    title: 'Select previous tab',
    subtitle: `Switch to the previous tab in the active panel group, wrapping at the start${tabCycleAlternateHint('panel-select-previous-tab-alternate')}`,
    category: 'panels',
    keywords: [
      'tab',
      'next',
      'previous',
      'switch',
      'cycle',
      'chat',
      'panel',
      'group',
    ],
    shortcut: formatShortcutHint('panel-select-previous-tab'),
    requiresWorktree: true,
  },
];
