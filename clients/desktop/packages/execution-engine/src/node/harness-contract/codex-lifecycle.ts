import type { ServerNotification } from '../codex-runtime/generated/ServerNotification';
import type { ServerRequest } from '../codex-runtime/generated/ServerRequest';
import type { CollabAgentTool } from '../codex-runtime/generated/v2/CollabAgentTool';
import type { SubAgentActivityKind } from '../codex-runtime/generated/v2/SubAgentActivityKind';
import type { ThreadActiveFlag } from '../codex-runtime/generated/v2/ThreadActiveFlag';
import type { ThreadItem } from '../codex-runtime/generated/v2/ThreadItem';
import type { ThreadStatus } from '../codex-runtime/generated/v2/ThreadStatus';
import type { TurnStatus } from '../codex-runtime/generated/v2/TurnStatus';
import type { LifecycleRole } from '@canopy/execution-engine/node/harness-contract/lifecycle-role';

export const CODEX_LIFECYCLE = {
  notificationMethods: {
    // These are the protocol's authoritative turn boundary notifications.
    'turn/started': 'turn start',
    'turn/completed': 'turn end',
    // Thread, auth, configuration, approval, and connection changes describe session state.
    'thread/started': 'session state',
    'thread/status/changed': 'session state',
    'thread/archived': 'session state',
    'thread/deleted': 'session state',
    'thread/unarchived': 'session state',
    'thread/closed': 'session state',
    'thread/reverted': 'session state',
    'skills/changed': 'session state',
    'thread/name/updated': 'session state',
    'thread/readState/changed': 'session state',
    'thread/section/changed': 'session state',
    'thread/attachment/updated': 'session state',
    'thread/goal/updated': 'session state',
    'thread/goal/cleared': 'session state',
    'thread/queue/changed': 'session state',
    'project/changed': 'session state',
    'thread/project/updated': 'session state',
    'thread/environment/connected': 'session state',
    'thread/environment/disconnected': 'session state',
    'thread/settings/updated': 'session state',
    'thread/tokenUsage/updated': 'session state',
    'item/autoApprovalReview/started': 'session state',
    'item/autoApprovalReview/completed': 'session state',
    'autoApprovalReview/strictReviewRequired': 'session state',
    'mcpServer/oauthLogin/completed': 'session state',
    'mcpServer/startupStatus/updated': 'session state',
    'account/updated': 'session state',
    'account/gatewayOAuth/changed': 'session state',
    'account/rateLimits/updated': 'session state',
    'app/list/updated': 'session state',
    'remoteControl/status/changed': 'session state',
    'model/rerouted': 'session state',
    'model/verification': 'session state',
    'modelProvider/authRecoveryStarted': 'session state',
    'modelProvider/authRecoveryCompleted': 'session state',
    'thread/compacted': 'session state',
    'thread/realtime/started': 'session state',
    'thread/realtime/closed': 'session state',
    'windowsSandbox/setupCompleted': 'session state',
    'account/login/completed': 'session state',
    // Other notifications are content, progress, diagnostics, or streaming snapshots.
    error: 'informational',
    'hook/started': 'informational',
    'hook/completed': 'informational',
    'turn/diff/updated': 'informational',
    'turn/plan/updated': 'informational',
    'thread/prediction/updated': 'informational',
    'item/started': 'informational',
    'item/completed': 'informational',
    'rawResponseItem/completed': 'informational',
    'rawResponse/completed': 'informational',
    'item/agentMessage/delta': 'informational',
    'item/plan/delta': 'informational',
    'command/exec/outputDelta': 'informational',
    'process/outputDelta': 'informational',
    'process/exited': 'informational',
    'item/commandExecution/outputDelta': 'informational',
    'item/commandExecution/terminalInteraction': 'informational',
    'item/fileChange/outputDelta': 'informational',
    'item/fileChange/patchUpdated': 'informational',
    'serverRequest/resolved': 'informational',
    'item/mcpToolCall/progress': 'informational',
    'mcpServer/event/stream/notification': 'informational',
    'externalAgentConfig/import/progress': 'informational',
    'externalAgentConfig/import/completed': 'informational',
    'fs/changed': 'informational',
    'item/reasoning/summaryTextDelta': 'informational',
    'item/reasoning/summaryPartAdded': 'informational',
    'item/reasoning/textDelta': 'informational',
    warning: 'informational',
    guardianWarning: 'informational',
    deprecationNotice: 'informational',
    configWarning: 'informational',
    'fuzzyFileSearch/sessionUpdated': 'informational',
    'fuzzyFileSearch/sessionCompleted': 'informational',
    'thread/realtime/itemAdded': 'informational',
    'thread/realtime/item/started': 'informational',
    'thread/realtime/item/transcript/delta': 'informational',
    'thread/realtime/item/completed': 'informational',
    'thread/realtime/transcript/delta': 'informational',
    'thread/realtime/transcript/done': 'informational',
    'thread/realtime/outputAudio/delta': 'informational',
    'thread/realtime/sdp': 'informational',
    'thread/realtime/error': 'informational',
    'windows/worldWritableWarning': 'informational',
    'turn/moderationMetadata': 'informational',
    'model/safetyBuffering/updated': 'informational',
  } satisfies Record<ServerNotification['method'], LifecycleRole>,

  requestMethods: {
    // Approval and user-input requests pause the current turn until session input arrives.
    'item/commandExecution/requestApproval': 'session state',
    'item/fileChange/requestApproval': 'session state',
    'item/tool/requestUserInput': 'session state',
    'mcpServer/elicitation/request': 'session state',
    'item/permissions/requestApproval': 'session state',
    applyPatchApproval: 'session state',
    execCommandApproval: 'session state',
    'account/chatgptAuthTokens/refresh': 'session state',
    // These client capability calls do not define turn or session boundaries.
    'item/tool/call': 'informational',
    'attestation/generate': 'informational',
    'currentTime/read': 'informational',
  } satisfies Record<ServerRequest['method'], LifecycleRole>,

  itemTypes: {
    // Thread items are content and tool snapshots; turn boundaries come from turn notifications.
    userMessage: 'informational',
    hookPrompt: 'informational',
    agentMessage: 'informational',
    functionCallOutput: 'informational',
    plan: 'informational',
    reasoning: 'informational',
    commandExecution: 'informational',
    fileChange: 'informational',
    mcpToolCall: 'informational',
    dynamicToolCall: 'informational',
    webSearch: 'informational',
    imageView: 'informational',
    sleep: 'informational',
    imageGeneration: 'informational',
    // Collaboration items and activity are children of the current agent turn.
    collabAgentToolCall: 'child',
    subAgentActivity: 'child',
    // Review mode and context compaction change thread-local session state.
    enteredReviewMode: 'session state',
    exitedReviewMode: 'session state',
    contextCompaction: 'session state',
  } satisfies Record<ThreadItem['type'], LifecycleRole>,

  threadStatuses: {
    // Each status describes whether a thread is loaded, idle, active, or in error.
    notLoaded: 'session state',
    idle: 'session state',
    systemError: 'session state',
    active: 'session state',
  } satisfies Record<ThreadStatus['type'], LifecycleRole>,

  turnStatuses: {
    // In-progress opens the turn; completed, interrupted, and failed are terminal outcomes.
    inProgress: 'turn start',
    completed: 'turn end',
    interrupted: 'turn end',
    failed: 'turn end',
  } satisfies Record<TurnStatus, LifecycleRole>,

  threadActiveFlags: {
    // Both flags indicate that a thread is paused for an approval or user answer.
    waitingOnApproval: 'session state',
    waitingOnUserInput: 'session state',
  } satisfies Record<ThreadActiveFlag, LifecycleRole>,

  collabAgentTools: {
    // Every collaboration tool operates on a child agent or its communication lifecycle.
    spawnAgent: 'child',
    sendInput: 'child',
    resumeAgent: 'child',
    wait: 'child',
    closeAgent: 'child',
    sendMessage: 'child',
    followupTask: 'child',
    interruptAgent: 'child',
    listAgents: 'child',
  } satisfies Record<CollabAgentTool, LifecycleRole>,

  subAgentActivityKinds: {
    // These events are lifecycle updates for a nested sub-agent.
    started: 'child',
    interacted: 'child',
    interrupted: 'child',
    completed: 'child',
  } satisfies Record<SubAgentActivityKind, LifecycleRole>,
} as const;
