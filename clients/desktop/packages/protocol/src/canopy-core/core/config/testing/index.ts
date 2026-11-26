import type { CONFIG_DOCUMENT_REFUSED_KEYS } from '../document';

/**
 * One preferences save and what the save rules make of it (CAN-7935). The
 * pure table and Electron's `preferences:save` both run these cases, so the
 * shared module and the save path it replaced cannot drift apart.
 */
export interface PreferenceSaveRuleCase {
  readonly name: string;
  readonly patch: Readonly<Record<string, unknown>>;
  /** A save that is not refused writes every key it does not drop as sent. */
  readonly outcome:
    | { readonly refused: (typeof CONFIG_DOCUMENT_REFUSED_KEYS)[number] }
    | { readonly dropped: readonly string[] };
}

const pluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [{ marketplaceId: 'acme', pluginName: 'review' }],
};

export const PREFERENCE_SAVE_RULE_CASES: readonly PreferenceSaveRuleCase[] = [
  { name: 'an empty patch', patch: {}, outcome: { dropped: [] } },
  {
    name: 'an ordinary key',
    patch: { navigationMode: 'work' },
    outcome: { dropped: [] },
  },
  {
    name: 'a usage-data toggle',
    patch: { usageData: { errorReports: false } },
    outcome: { dropped: [] },
  },
  {
    name: 'approval defaults',
    patch: { approvalDefaults: {}, navigationMode: 'work' },
    outcome: { refused: 'approvalDefaults' },
  },
  {
    name: 'Claude Mod consent',
    patch: { claudeModAdmissions: {} },
    outcome: { refused: 'claudeModAdmissions' },
  },
  {
    name: 'the Claude Mod kill switch, before the proxy connection',
    patch: { accountProxyConnection: null, claudeModsDisabled: true },
    outcome: { refused: 'claudeModsDisabled' },
  },
  {
    name: 'the account proxy connection',
    patch: { accountProxyConnection: null },
    outcome: { refused: 'accountProxyConnection' },
  },
  {
    name: 'the Copilot account, after approval defaults',
    patch: { copilotAccount: null, approvalDefaults: {} },
    outcome: { refused: 'approvalDefaults' },
  },
  {
    name: 'the Copilot account',
    patch: { copilotAccount: null },
    outcome: { refused: 'copilotAccount' },
  },
  {
    name: 'every always-dropped key beside an ordinary one',
    patch: {
      navigationMode: 'work',
      suggestions: {},
      copilotEnabled: true,
      copilotVaultSelection: null,
      disabledInstalledItems: [],
      parkedCodexPlugins: [],
      pendingInstalledItemUninstalls: [],
      nativeProviderAccounts: {},
      globalApprovalRules: [],
      accountProxyLocalRoutingStrategy: 'balanced',
      terminalSettingsRevision: 9,
    },
    outcome: {
      dropped: [
        'suggestions',
        'copilotEnabled',
        'copilotVaultSelection',
        'disabledInstalledItems',
        'parkedCodexPlugins',
        'pendingInstalledItemUninstalls',
        'nativeProviderAccounts',
        'globalApprovalRules',
        'accountProxyLocalRoutingStrategy',
        'terminalSettingsRevision',
      ],
    },
  },
  {
    name: 'an always-dropped key alone',
    patch: { copilotEnabled: true },
    outcome: { dropped: ['copilotEnabled'] },
  },
  {
    name: 'the one-key Google subscription intent',
    patch: { googleSubscriptionDisconnected: true },
    outcome: { dropped: [] },
  },
  {
    name: 'a one-key Google subscription save that is not a boolean',
    patch: { googleSubscriptionDisconnected: 'yes' },
    outcome: { dropped: ['googleSubscriptionDisconnected'] },
  },
  {
    name: 'the Google subscription beside a client-local key',
    patch: { googleSubscriptionDisconnected: true, sidebarWidth: 300 },
    outcome: { dropped: ['googleSubscriptionDisconnected'] },
  },
  {
    name: 'the Google subscription beside usage data',
    patch: {
      googleSubscriptionDisconnected: false,
      usageData: { errorReports: false },
    },
    outcome: { dropped: ['googleSubscriptionDisconnected'] },
  },
  {
    name: 'the Google subscription beside empty usage data, which still counts',
    patch: { googleSubscriptionDisconnected: true, usageData: {} },
    outcome: { dropped: ['googleSubscriptionDisconnected'] },
  },
  {
    name: 'the one-key suggestions-master intent',
    patch: { repeatTaskAutomationSuggestionsEnabled: false },
    outcome: { dropped: [] },
  },
  {
    name: 'the suggestions master in a wider snapshot',
    patch: {
      repeatTaskAutomationSuggestionsEnabled: false,
      navigationMode: 'work',
    },
    outcome: { dropped: ['repeatTaskAutomationSuggestionsEnabled'] },
  },
  {
    name: 'the two-key terminal settings intent',
    patch: { disabledTerminalShellProfileIds: ['bash'], terminalPresets: [] },
    outcome: { dropped: [] },
  },
  {
    name: 'terminal presets alone',
    patch: { terminalPresets: [] },
    outcome: { dropped: ['terminalPresets'] },
  },
  {
    name: 'terminal presets in a wider snapshot',
    patch: { terminalPresets: [], terminalDrawerHeight: 400 },
    outcome: { dropped: ['terminalPresets'] },
  },
  {
    name: 'the terminal settings intent with the revision',
    patch: {
      disabledTerminalShellProfileIds: [],
      terminalPresets: [],
      terminalSettingsRevision: 5,
    },
    outcome: {
      dropped: [
        'disabledTerminalShellProfileIds',
        'terminalPresets',
        'terminalSettingsRevision',
      ],
    },
  },
  {
    name: 'the one-key global plugin defaults intent',
    patch: { globalPluginSelections: pluginSelections },
    outcome: { dropped: [] },
  },
  {
    name: 'global plugin defaults beside the theme',
    patch: { globalPluginSelections: pluginSelections, theme: 'dark' },
    outcome: { dropped: ['globalPluginSelections'] },
  },
];
