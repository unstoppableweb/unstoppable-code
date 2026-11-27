import type { CanopyCapabilities } from '@canopy/app-core';
import {
  CLIENT_FEATURE_FLAGS,
  type ClientFeatureFlagKey,
} from '@canopy/protocol/feature-flags';

export interface WebCoreScopeOptions {
  /**
   * The desktop binds cloud chat terminals (CAN-6175 R10): see
   * `cloudTerminalsEnabled`.
   */
  readonly durableTerminals: boolean;
  /**
   * The web core serves a cloud task's cost reads (CAN-6180), from its
   * manifest. It turns on both `costInsights` and the Activity rail's Cost
   * section, so the two are on or off together.
   */
  readonly costInsights?: boolean;
  /**
   * The web core serves a cloud chat's full cost breakdown, as its manifest
   * declares (CAN-6941). It turns on the Session breakdown panel.
   */
  readonly sessionBreakdown?: boolean;
  /**
   * The scope's chats fork whole into a new task (CAN-7007): a listed cowork
   * project's scope, when the web core's manifest serves `core.chat.fork`. A
   * repository project's fork would stay in a worktree this window can't
   * open yet (CAN-6177), so it stays off there.
   */
  readonly taskFork?: boolean;
  /**
   * A cloud chat's delegate cards read their child pages over the web core
   * relay (CAN-7027), as `core.chat.transcript.page` serves them by a
   * delegation target for the chat's owner. Off until it is switched on
   * for review; unset reads as off.
   */
  readonly delegationTranscriptReads?: boolean;
  /**
   * A cloud chat stops its own delegates over the web core relay (CAN-7245):
   * a card's Stop and the drawer's Stop and Stop all, through the shared
   * cloud delegation store. Off until it is switched on for review; unset
   * reads as off.
   */
  readonly delegationStop?: boolean;
  /**
   * A cloud scope serves the Subagents and subagent chat panels from what
   * its chats hold (CAN-7133): each root chat's own delegate cards and
   * transcript, its delegates' pages and their live state. On when the web
   * core's manifest serves both the pages and the delegates' reads and
   * Stops; unset reads as off.
   */
  readonly cloudSubagentPanels?: boolean;
}

/**
 * Whether the desktop runs a cloud chat's terminals as durable shells in its
 * sandbox. They need both flags; with either off, every terminal is local
 * and a cloud scope has none.
 */
export function cloudTerminalsEnabled(
  isEnabled: (key: ClientFeatureFlagKey) => boolean,
): boolean {
  return (
    isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key) &&
    isEnabled(CLIENT_FEATURE_FLAGS.canopyCloudDurableTerminals.key)
  );
}

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
 * catalog, and the servers it lets cloud chats reach), the thinking level
 * and fast mode, which ride each send within the model's web core catalog,
 * the chat's skills, plugins and MCP servers, chosen from that catalog (R5,
 * CAN-6322), and attachments, which upload to the chat through main's web
 * core connection and ride its send (R6). Everything a
 * local core, local files or a local runtime answers is off: plan and
 * access modes, queue
 * edits, forks, reset to point, closing the task's own chat, scheduled sends
 * (the desktop scheduler can't run a cloud chat), the Claude Code terminal
 * view, session transfer,
 * Feed, cost, subagents, and "Open in". Rows that serve one of these turn
 * it on here, from the web core manifest where the operation can be
 * unavailable.
 *
 * Served so far: the sandbox's files, read and written through the web core
 * (CAN-6175 R9), the project's shared workspace files (CAN-7008), its terminals when the desktop binds them (R10), its
 * cost when the web core's manifest serves the cost reads (CAN-6180), and
 * the composer's context usage, folded from each answer's meter, which the
 * web core serves at revision 2 of the chat's transcript and events
 * (CAN-6509, CAN-6755); a chat whose answers carry no meter shows none.
 * A cowork project's chats fork whole into a new task when the web core
 * serves the fork (CAN-7007); the tab fork stays off. Its Subagents and
 * subagent chat panels show what its chats hold when the web core serves
 * their delegates' pages, reads and Stops (CAN-7133).
 * Scripts stay off: a cloud terminal can't run a startup command.
 */
function buildWebCoreScopeCapabilities(
  host: CanopyCapabilities,
  options: WebCoreScopeOptions,
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
    ...(host.cloudReachBack === true ? { cloudReachBack: true } : {}),
    // A project's shared workspace files: added through main's web core
    // connection, removed over the relay (CAN-7008).
    cloudWorkspaceFileWrite: true,
    localExecution: false,
    terminalPty: options.durableTerminals,
    fileSystemAccess: 'read-write',
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
    chatApprovalRespond: true,
    chatModelChange: true,
    chatTabCreation: true,
    chatThinkingLevel: true,
    chatFastMode: true,
    chatTabFork: false,
    ...(options.taskFork === true ? { chatTaskFork: true } : {}),
    chatRootTabLifecycle: false,
    chatPluginSelections: true,
    // Edit and Run now on a queued prompt reach Core with its revision (CAN-6651).
    chatQueueEdits: true,
    chatQueueCancel: true,
    chatResetToPoint: false,
    chatAttachments: true,
    chatFileMentions: false,
    chatInterfaceModes: false,
    // Folded from each answer's revision 2 meter (CAN-6755).
    chatContextUsage: true,
    chatSessionTransfer: false,
    chatTranscriptSearch: true,
    chatReadState: false,
    chatArchives: false,
    // No cloud task has a summary yet (CAN-6573).
    taskSummary: false,
    ledger: false,
    ledgerLocal: false,
    costInsights: options.costInsights === true,
    sessionBreakdown: options.sessionBreakdown === true,
    // A delegate card's child pages, over the web core (CAN-7027). Its
    // bodies and block pages stay off: the web core doesn't serve them here.
    ...(options.delegationTranscriptReads === true
      ? { delegationTranscriptReads: true }
      : {}),
    // Stop and Stop all for the chat's own delegates, over the web core
    // (CAN-7245). Load changes stays off: no retained worktree is here.
    ...(options.delegationStop === true ? { delegationStop: true } : {}),
    ...(options.cloudSubagentPanels === true ? { subagentPanels: true } : {}),
    // Unset would mean "every section the workspace type shows" and "the
    // whole worktree's diff". A cloud scope shows the sections the web core
    // feeds: its agent tasks and background processes, which the web core
    // agent task publisher fills (CAN-6430), the selected chat's
    // attachments (R8d), its project's shared workspace files (CAN-6568),
    // its MCP servers, from the chat's web core catalog (CAN-6608), and its
    // Cost while the web core serves it (CAN-6180). Every other section reads
    // only this computer.
    activitySectionIds: [
      'todo',
      'background-processes',
      'attachments',
      'workspace-files',
      'mcp-servers',
      ...(options.costInsights === true ? ['cost'] : []),
    ],
    wholeWorktreeDiff: false,
  };
}

const cache = new WeakMap<
  CanopyCapabilities,
  Map<string, CanopyCapabilities>
>();

/**
 * The capabilities of a cloud chat scope shown by a window whose own
 * capabilities are `host`. One object per host set and options, so callers
 * can compare by identity.
 */
export function webCoreScopeCapabilities(
  host: CanopyCapabilities,
  options: WebCoreScopeOptions = { durableTerminals: false },
): CanopyCapabilities {
  let entry = cache.get(host);
  if (entry === undefined) {
    entry = new Map();
    cache.set(host, entry);
  }
  const key = `${String(options.durableTerminals)}:${String(options.costInsights === true)}:${String(options.sessionBreakdown === true)}:${String(options.taskFork === true)}:${String(options.delegationTranscriptReads === true)}:${String(options.delegationStop === true)}:${String(options.cloudSubagentPanels === true)}`;
  let capabilities = entry.get(key);
  if (capabilities === undefined) {
    capabilities = buildWebCoreScopeCapabilities(host, options);
    entry.set(key, capabilities);
  }
  return capabilities;
}
