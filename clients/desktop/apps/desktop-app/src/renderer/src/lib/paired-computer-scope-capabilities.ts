import type { CanopyCapabilities } from '@canopy/app-core';

export interface PairedComputerScopeOptions {
  /** Whether the paired computer announced the `composer` one-window capability. */
  readonly composer?: boolean;
  /** Whether the paired computer announced the `send` one-window capability. */
  readonly send?: boolean;
}

/**
 * Allowlist-only capability set for a paired computer's chat scope in
 * one-window mode (CAN-7767).
 *
 * Built from an allowlist rather than copying desktop capabilities: any
 * capability added to desktop later stays off for paired computers until
 * explicitly enabled here.
 *
 * Supported in CAN-7767:
 * - Transcript read & live streaming, text-only send, exact Stop
 * - Read-only paired model list and read-only approval mode (`composer`)
 * - Read-only pending approval requests and ask-user prompts
 *
 * Deferred (explicitly `false` so UI hides them rather than calling local IPC):
 * - New Chat / tab lifecycle / rename (`CAN-7907`)
 * - Queue edit, steer, Run now, reorder, cancel (`CAN-7877`)
 * - Model / thinking / fast-mode / approval-mode / plugin settings (`CAN-7868`)
 * - Answering approvals & questions (`CAN-7865`)
 * - Mark read / unread (`CAN-7866`)
 * - Plan mode, attachments, file mentions, files, terminal, browser, etc.
 */
function buildPairedComputerScopeCapabilities(
  host: CanopyCapabilities,
  options: PairedComputerScopeOptions,
): CanopyCapabilities {
  return {
    routing: host.routing,
    voice: host.voice,
    settingsScope: host.settingsScope,
    ...(host.accountOrganizationSettings === true
      ? { accountOrganizationSettings: true }
      : {}),
    localExecution: false,
    terminalPty: false,
    fileSystemAccess: 'none',
    pipelines: 'read-only',
    overviewNotifications: false,
    nativeWorktreeOpen: false,
    inAppBrowserPanel: false,
    automations: false,
    chatWorkflows: {
      planMode: false,
      planReview: false,
      deferredCapabilities: false,
      independentFork: false,
      interruptedTurnResume: false,
    },
    chatApprovalMode: false,
    ...(options.composer === true ? { chatApprovalModeReadOnly: true } : {}),
    chatApprovalRespond: false,
    chatModelChange: false,
    chatSend: options.send === true,
    chatTabCreation: false,
    chatThinkingLevel: false,
    chatFastMode: false,
    chatTabFork: false,
    chatTaskFork: false,
    chatRootTabLifecycle: false,
    chatPluginSelections: false,
    chatQueueEdits: false,
    chatQueueCancel: false,
    chatResetToPoint: false,
    chatAttachments: false,
    chatFileMentions: false,
    chatInterfaceModes: false,
    chatContextUsage: false,
    chatSessionTransfer: false,
    chatTranscriptSearch: false,
    chatReadState: false,
    chatArchives: false,
    taskSummary: false,
    ledger: false,
    ledgerLocal: false,
    chatVisuals: false,
    costInsights: false,
    sessionBreakdown: false,
    activitySectionIds: [],
    wholeWorktreeDiff: false,
  };
}

const cache = new WeakMap<
  CanopyCapabilities,
  Map<string, CanopyCapabilities>
>();

export function pairedComputerScopeCapabilities(
  host: CanopyCapabilities,
  options: PairedComputerScopeOptions = {},
): CanopyCapabilities {
  const key = `${options.composer === true}:${options.send === true}`;
  let byKey = cache.get(host);
  if (!byKey) {
    byKey = new Map();
    cache.set(host, byKey);
  }
  const cached = byKey.get(key);
  if (cached) return cached;
  const built = buildPairedComputerScopeCapabilities(host, options);
  byKey.set(key, built);
  return built;
}
