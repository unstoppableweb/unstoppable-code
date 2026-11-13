import type { CanopyCapabilities } from '@canopy/app-core';

/**
 * What a cloud cowork chat scope can do on this desktop (CAN-6175 D4): the
 * same desktop components render it, and these capabilities hide what the
 * web core doesn't serve.
 *
 * Built from an allowlist, never by copying the desktop set and switching
 * features off: a capability the desktop adds later stays off for cloud
 * scopes until a row here serves it. Only capabilities of this window
 * itself carry over (routing, dictation, clipboard, account settings,
 * reference previews over this computer's own connections, and the links
 * from this computer's skills, plugins and MCP servers to a cloud chat's
 * catalog), the thinking level and fast mode, which ride each send within
 * the model's web core catalog, the chat's skills, plugins and MCP
 * servers, chosen from that catalog (R5, CAN-6322), and attachments, which
 * upload to the chat through main's web core connection and ride its send
 * (R6). Everything a
 * local core, local files or a local runtime answers is off: plan and
 * access modes, queue
 * edits, forks, reset to point, closing the task's own chat, scheduled sends
 * (the desktop scheduler can't run a cloud chat), the Claude Code terminal
 * view, context usage, session transfer,
 * Feed, cost, subagents, and "Open in". Rows that serve one of these turn
 * it on here, from the web core manifest where the operation can be
 * unavailable.
 */
function buildWebCoreScopeCapabilities(
  host: CanopyCapabilities,
): CanopyCapabilities {
  return {
    routing: host.routing,
    voice: host.voice,
    settingsScope: host.settingsScope,
    ...(host.imageClipboard === true ? { imageClipboard: true } : {}),
    ...(host.accountOrganizationSettings === true
      ? { accountOrganizationSettings: true }
      : {}),
    ...(host.referencePreviews === true ? { referencePreviews: true } : {}),
    ...(host.cloudCapabilityLinks === true
      ? { cloudCapabilityLinks: true }
      : {}),
    localExecution: false,
    terminalPty: false,
    fileSystemAccess: 'none',
    pipelines: 'read-only',
    overviewNotifications: false,
    nativeWorktreeOpen: false,
    chatWorkflows: {
      planMode: false,
      planReview: false,
      deferredCapabilities: false,
      independentFork: false,
      interruptedTurnResume: false,
    },
    automations: false,
    chatApprovalMode: false,
    chatThinkingLevel: true,
    chatFastMode: true,
    chatTabFork: false,
    chatRootTabLifecycle: false,
    chatPluginSelections: true,
    chatQueueEdits: false,
    chatResetToPoint: false,
    chatAttachments: true,
    chatFileMentions: false,
    chatInterfaceModes: false,
    chatContextUsage: false,
    chatSessionTransfer: false,
    chatTranscriptSearch: false,
    chatReadState: false,
    chatArchives: false,
    ledger: false,
    ledgerLocal: false,
    costInsights: false,
    // Unset would mean "every section the workspace type shows" and "the
    // whole worktree's diff"; a cloud scope implements neither yet.
    activitySectionIds: [],
    wholeWorktreeDiff: false,
  };
}

const cache = new WeakMap<CanopyCapabilities, CanopyCapabilities>();

/**
 * The capabilities of a cloud chat scope shown by a window whose own
 * capabilities are `host`. One object per host set, so callers can compare
 * by identity.
 */
export function webCoreScopeCapabilities(
  host: CanopyCapabilities,
): CanopyCapabilities {
  const cached = cache.get(host);
  if (cached !== undefined) return cached;
  const built = buildWebCoreScopeCapabilities(host);
  cache.set(host, built);
  return built;
}
