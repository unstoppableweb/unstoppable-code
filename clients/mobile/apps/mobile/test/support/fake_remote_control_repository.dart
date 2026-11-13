import 'dart:async';
import 'dart:typed_data';
import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_cached_chat_tail.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_file_diff.dart';
import 'package:mobile/data/models/remote_file.dart';
import 'package:mobile/data/models/remote_pipeline_chat_follow_up.dart';
import 'package:mobile/data/models/remote_pipeline_content.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/protocol/generated/portal_command_status.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_pipeline_content_commands.dart';
import 'package:mobile/data/repositories/remote_app_advisor_commands.dart';
import 'package:mobile/data/repositories/remote_composer_commands.dart';
import 'package:mobile/data/repositories/remote_response_commands.dart';
import 'package:mobile/data/repositories/remote_project_commands.dart';
import 'package:mobile/data/repositories/remote_provider_usage_commands.dart';
import 'package:mobile/data/repositories/remote_watcher_commands.dart';
import 'package:mobile/data/repositories/mock_remote_watchers.dart';

/// Base test double for [RemoteControlRepository]: every member has a benign
/// default so per-test fakes override only the behavior under test instead of
/// re-implementing the whole interface each time it grows.
base class FakeRemoteControlRepository implements RemoteControlRepository {
  @override
  late final responseCommands = RemoteResponseCommands(
    submit: ({required type, required target, required payload}) async =>
        const RemotePortalCommandResult(commandId: 'fork-response'),
  );

  bool supportsWatchers = false;
  final watcherDeletes =
      <({String sessionId, String watcherId, bool notifySubscriber})>[];
  Object? watcherDeleteError;

  @override
  late final watchers = RemoteWatcherCommands(
    hasCapability: (capability) =>
        capability == 'chat_watchers' && supportsWatchers,
    events: events,
    submit: (sessionId, {required type, required payload}) async {
      watcherDeletes.add((
        sessionId: sessionId,
        watcherId: payload['watcherId'] as String,
        notifySubscriber: payload['notifySubscriber'] as bool,
      ));
      if (watcherDeleteError case final error?) throw error;
      return const RemotePortalCommandResult(
        commandId: 'delete-watcher',
        result: {'ok': true},
      );
    },
  );

  /// Event sink tests can push batches through; [events] exposes its stream.
  final StreamController<RemotePortalEventBatch> eventsController =
      StreamController.broadcast();

  /// Delivery liveness tests can push through; [eventsLive] exposes it.
  final StreamController<bool> eventsLiveController =
      StreamController.broadcast();

  @override
  Stream<bool> get eventsLive => eventsLiveController.stream;

  /// When true, [resumeEvents] reports delivery live at once, the way the
  /// server's stream primer does. Link-state tests turn it off to drive
  /// [eventsLiveController] themselves.
  bool autoLive = true;

  int resumeEventsCalls = 0;
  int pauseEventsCalls = 0;
  int discardEventCursorCalls = 0;
  int disconnectCalls = 0;
  int clearLocalSessionCalls = 0;
  int snapshotFetches = 0;
  @override
  bool supportsForegroundChat = false;
  int requestWorktreeStateCalls = 0;
  int requestChatTranscriptCalls = 0;

  /// Recorded [requestChatTranscript] targets, in call order.
  final List<RemoteChatTarget> requestChatTranscriptTargets = [];
  int _commandSeq = 0;

  /// When set, [fetchSnapshot] returns this instead of the empty default —
  /// lets tests drive `refreshing`/workspace content without a subclass.
  RemoteSessionSnapshot Function()? snapshotBuilder;

  @override
  bool canArchiveWorktrees = true;
  final List<({String workspaceLocalId, String worktreeLocalId})> archiveCalls =
      [];
  Object? archiveError;

  @override
  Future<String> archiveWorktree({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    archiveCalls.add((
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
    ));
    if (archiveError case final error?) throw error;
    return 'archive-${archiveCalls.length}';
  }

  @override
  Stream<RemotePortalEventBatch> get events => eventsController.stream;

  @override
  Future<RemoteConnection?> restoreSession() async => null;

  /// When set, [refreshSessionMetadata] answers with this instead of
  /// [restoreSession], so a test can replace the paired desktop's heartbeat
  /// and capability metadata without changing the pairing.
  RemoteConnection? Function()? sessionMetadataBuilder;

  @override
  Future<RemoteConnection?> refreshSessionMetadata() async {
    final builder = sessionMetadataBuilder;
    return builder == null ? restoreSession() : builder();
  }

  /// Derived from [restoreSession] so a subclass that overrides only the
  /// restore keeps a consistent probe. Mirrors the HTTP repository, which maps
  /// a read it could not complete to [RemoteSessionProbeOutcome.unknown]
  /// rather than to "gone"; override this directly to drive that case.
  @override
  Future<RemoteSessionProbe> probeSession() async {
    final RemoteConnection? connection;
    try {
      connection = await restoreSession();
    } catch (_) {
      return (outcome: RemoteSessionProbeOutcome.unknown, connection: null);
    }
    return connection == null
        ? (outcome: RemoteSessionProbeOutcome.gone, connection: null)
        : (
            outcome: RemoteSessionProbeOutcome.renderable,
            connection: connection,
          );
  }

  /// Desktop liveness [connect] reports; null means the server sent none.
  RemotePortalConnectionStatus? connectedStatus;

  /// The server's per-space notification gate [connect] reports.
  bool spaceNotificationSettingsEnabled = false;

  /// Server pairing session [connect] reports; null means none.
  String? connectedSessionId;

  @override
  Future<RemoteConnection> connect(String pairingCode) async =>
      RemoteConnection(
        deviceLabel: 'Test Desktop',
        pairedAt: DateTime(2026),
        connectionStatus: connectedStatus,
        spaceNotificationSettingsEnabled: spaceNotificationSettingsEnabled,
        sessionId: connectedSessionId,
      );

  @override
  Future<void> disconnect() async {
    disconnectCalls += 1;
  }

  @override
  void clearLocalSession() {
    clearLocalSessionCalls += 1;
  }

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() async {
    snapshotFetches += 1;
    return snapshotBuilder?.call() ??
        const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [],
          standaloneChats: [],
        );
  }

  @override
  void resumeEvents() {
    resumeEventsCalls += 1;
    if (autoLive) eventsLiveController.add(true);
  }

  @override
  void pauseEvents() {
    pauseEventsCalls += 1;
  }

  @override
  void discardEventCursor() {
    discardEventCursorCalls += 1;
  }

  /// Slices returned by [fetchWorktreeStateSlices], keyed by worktree id.
  Map<String, Map<String, dynamic>> worktreeStateSlices = {};
  bool worktreeStateSlicesRefreshing = false;
  int fetchWorktreeStateSlicesCalls = 0;

  /// The next this many slice reads throw, after [worktreeStateSlicesGate].
  int worktreeStateSlicesFailures = 0;

  /// Holds a slice read's reply (fixed when the read starts) until completed.
  Completer<void>? worktreeStateSlicesGate;

  @override
  Future<({Map<String, dynamic> slices, bool refreshing})>
  fetchWorktreeStateSlices({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    fetchWorktreeStateSlicesCalls += 1;
    final fails = worktreeStateSlicesFailures > 0;
    if (fails) worktreeStateSlicesFailures -= 1;
    final result = (
      slices: worktreeStateSlices[worktreeLocalId] ?? const {},
      refreshing: worktreeStateSlicesRefreshing,
    );
    await worktreeStateSlicesGate?.future;
    if (fails) throw const RemoteControlException('slices read failed');
    return result;
  }

  /// Slices returned by [fetchWorktreePipelineSlices], keyed by worktree id.
  Map<String, Map<String, dynamic>> worktreePipelineSlices = {};
  bool worktreePipelineSlicesRefreshing = false;
  int fetchWorktreePipelineSlicesCalls = 0;

  /// The next this many pipeline reads throw.
  int worktreePipelineSlicesFailures = 0;

  /// Holds a pipeline read's reply (fixed when the read starts) until
  /// completed.
  Completer<void>? worktreePipelineSlicesGate;

  @override
  Future<({Map<String, dynamic> slices, bool refreshing})>
  fetchWorktreePipelineSlices({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    fetchWorktreePipelineSlicesCalls += 1;
    if (worktreePipelineSlicesFailures > 0) {
      worktreePipelineSlicesFailures -= 1;
      throw const RemoteControlException('pipelines read failed');
    }
    final result = (
      slices: worktreePipelineSlices[worktreeLocalId] ?? const {},
      refreshing: worktreePipelineSlicesRefreshing,
    );
    await worktreePipelineSlicesGate?.future;
    return result;
  }

  @override
  Future<void> requestWorktreeState({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    requestWorktreeStateCalls += 1;
  }

  List<RemoteChatMessage> cachedChatMessages = const [];
  int cachedChatFetches = 0;
  int? cachedChatCursor;
  bool cachedChatStale = true;
  bool cachedChatHasSeed = false;
  List<String>? cachedChatOrder;

  @override
  Future<RemoteCachedChatTail> fetchCachedChatTail(
    RemoteChatTarget target,
  ) async {
    final messages = await fetchCachedChatMessages(target);
    return RemoteCachedChatTail(
      messages: messages,
      eventCursor: cachedChatCursor,
      stale: cachedChatStale,
      coverage: cachedChatHasSeed
          ? RemoteChatTailCoverage(
              snapshotCursor: 1,
              orderedMessageIds:
                  cachedChatOrder ??
                  [for (final row in messages) row.messageId],
            )
          : null,
    );
  }

  @override
  Future<List<RemoteChatMessage>> fetchCachedChatMessages(
    RemoteChatTarget target,
  ) async {
    cachedChatFetches++;
    return cachedChatMessages;
  }

  /// When set, answers [requestChatTranscript] with its command id.
  Future<String?> Function(RemoteChatTarget target)?
  requestChatTranscriptHandler;

  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) async {
    requestChatTranscriptCalls += 1;
    requestChatTranscriptTargets.add(target);
    return requestChatTranscriptHandler?.call(target);
  }

  /// Recorded [sendChatMessage] arguments, in call order.
  final List<
    ({RemoteChatTarget target, String text, RemoteChatSendOptions? options})
  >
  sendChatMessageCalls = [];

  /// When set, [sendChatMessage] defers to this instead of succeeding —
  /// throw from it to exercise a failed send.
  Future<RemoteChatSendResult> Function()? sendChatMessageHandler;

  @override
  Future<RemoteChatSendResult> sendChatMessage(
    RemoteChatTarget target,
    String text, {
    RemoteChatSendOptions? options,
  }) async {
    sendChatMessageCalls.add((target: target, text: text, options: options));
    final handler = sendChatMessageHandler;
    if (handler != null) return handler();
    final chatId = switch (target) {
      RemoteWorktreeChatTarget(:final chatId) => chatId ?? 'fake-chat',
      RemoteStandaloneChatTarget(:final chatId) => chatId,
    };
    return RemoteChatSendResult(commandId: 'fake-cmd', chatId: chatId);
  }

  @override
  bool supportsChatAttachments = false;

  @override
  bool supportsStandaloneChatCreate = false;

  final List<({String filename, String mediaType, int size})> uploadCalls = [];
  final List<String> deleteAttachmentCalls = [];
  Future<ChatAttachmentRef> Function(String filename)? uploadHandler;

  @override
  Future<ChatAttachmentRef> uploadChatAttachment({
    required String filename,
    required String mediaType,
    required Uint8List bytes,
  }) async {
    uploadCalls.add((
      filename: filename,
      mediaType: mediaType,
      size: bytes.length,
    ));
    final handler = uploadHandler;
    if (handler != null) return handler(filename);
    return ChatAttachmentRef(
      attachmentId: 'fake-${uploadCalls.length}',
      filename: filename,
      mediaType: mediaType,
      size: bytes.length,
      contentSha256: 'a' * 64,
      storageKind: 'blob',
      source: '/fake',
    );
  }

  @override
  Future<void> deleteChatAttachment(String attachmentId) async {
    deleteAttachmentCalls.add(attachmentId);
  }

  @override
  bool supportsPrActions = false;
  @override
  bool supportsPrStatusPush = false;

  RemotePrActionRunner? prActionRunner;
  RemotePortalCommandResult? prCommandResponse;

  @override
  Future<RemotePortalCommandResult> runPrAction({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required RemotePrAction action,
    String? repoId,
    RemotePrActionIdentity? identity,
    bool confirmUnresolvedComments = false,
  }) async =>
      prCommandResponse ??
      RemotePortalCommandResult(
        commandId: '',
        result:
            await prActionRunner?.call(
              action,
              repoId: repoId,
              identity: identity,
              confirmUnresolvedComments: confirmUnresolvedComments,
            ) ??
            {'repos': [], 'busy': false},
      );

  @override
  bool supportsChatMarkRead = false;
  Future<String> Function(RemoteChatTarget, String?)? markReadHandler;
  final List<({RemoteChatTarget target, String? lastMessageId})> markReadCalls =
      [];

  @override
  Future<String> markChatRead(
    RemoteChatTarget target,
    String? lastMessageId,
  ) async {
    markReadCalls.add((target: target, lastMessageId: lastMessageId));
    return markReadHandler?.call(target, lastMessageId) ??
        'read-${++_commandSeq}';
  }

  RemoteChatTarget? lastSetModelTarget;
  String? lastSetModel;
  final List<RemoteWorktreeChatTarget> setAutoModelTargets = [];
  Future<String> Function()? setAutoModelHandler;
  bool? lastSetPlanMode;
  final List<RemoteWorktreeChatTarget> setPlanModeTargets = [];
  Future<String> Function(bool)? setPlanModeHandler;
  String? lastSetThinkingLevel;
  final List<RemoteWorktreeChatTarget> setThinkingLevelTargets = [];

  /// When set, answers each `set_thinking_level` submission instead.
  Future<String> Function(String thinkingLevel)? setThinkingLevelHandler;
  bool? lastSetFastMode;

  /// Command ids handed back from [setChatFastMode], in call order.
  final List<String> setFastModeCommandIds = [];
  RemoteChatTarget? lastCancelTarget;
  final List<RemoteWorktreeChatTarget> createChatTabTargets = [];

  /// Command ids handed back from [createChatTab], in call order. Tests that
  /// simulate an asynchronous desktop rejection need the real id: the shared
  /// `_commandSeq` also serves read acknowledgements, so the first created tab
  /// is not reliably `fake-cmd-1`.
  final List<String> createChatTabCommandIds = [];

  final List<RemoteWorktreeChatTarget> closeChatTabTargets = [];

  /// Command ids handed back from [closeChatTab], in call order. See
  /// [createChatTabCommandIds] for why tests must not assume `fake-cmd-1`.
  final List<String> closeChatTabCommandIds = [];
  RemoteControlException? closeChatTabError;
  Future<void> Function()? beforeCloseChatTab;

  @override
  Future<String> closeChatTab(RemoteWorktreeChatTarget target) async {
    closeChatTabTargets.add(target);
    if (closeChatTabError case final error?) throw error;
    await beforeCloseChatTab?.call();
    final commandId = 'fake-cmd-${++_commandSeq}';
    closeChatTabCommandIds.add(commandId);
    return commandId;
  }

  /// Runs after [createChatTab] mints its command id and before it returns,
  /// so a test can deliver the command's terminal event first.
  Future<void> Function()? beforeCreateChatTabReturns;

  @override
  Future<String> createChatTab(RemoteWorktreeChatTarget target) async {
    createChatTabTargets.add(target);
    final commandId = 'fake-cmd-${++_commandSeq}';
    createChatTabCommandIds.add(commandId);
    await beforeCreateChatTabReturns?.call();
    return commandId;
  }

  @override
  Future<String> createStandaloneChat(
    RemoteStandaloneChatTarget target,
  ) async => 'fake-cmd-${++_commandSeq}';

  @override
  Future<String> setChatModel(RemoteChatTarget target, String model) async {
    lastSetModelTarget = target;
    lastSetModel = model;
    return 'fake-cmd-${++_commandSeq}';
  }

  @override
  Future<String> setChatAutoModel(RemoteWorktreeChatTarget target) async {
    setAutoModelTargets.add(target);
    if (setAutoModelHandler != null) return setAutoModelHandler!();
    return 'fake-cmd-${++_commandSeq}';
  }

  @override
  Future<String> setChatPlanMode(
    RemoteWorktreeChatTarget target,
    bool planMode,
  ) async {
    lastSetPlanMode = planMode;
    setPlanModeTargets.add(target);
    if (setPlanModeHandler != null) return setPlanModeHandler!(planMode);
    return 'fake-cmd-${++_commandSeq}';
  }

  @override
  Future<String> setChatThinkingLevel(
    RemoteWorktreeChatTarget target,
    String thinkingLevel,
  ) async {
    lastSetThinkingLevel = thinkingLevel;
    setThinkingLevelTargets.add(target);
    if (setThinkingLevelHandler case final handler?) {
      return handler(thinkingLevel);
    }
    return 'fake-cmd-${++_commandSeq}';
  }

  @override
  Future<String> setChatFastMode(
    RemoteWorktreeChatTarget target,
    bool fastMode,
  ) async {
    lastSetFastMode = fastMode;
    final commandId = 'fake-cmd-${++_commandSeq}';
    setFastModeCommandIds.add(commandId);
    return commandId;
  }

  /// Every `set_plugin_selections` submission, in order.
  final List<({RemoteChatTarget target, Map<String, Object?> selections})>
  pluginSelectionCalls = [];

  /// When set, answers each `set_plugin_selections` submission instead.
  Future<String> Function(Map<String, Object?> selections)?
  setPluginSelectionsHandler;

  @override
  Future<String> setChatPluginSelections(
    RemoteChatTarget target,
    Map<String, Object?> selections,
  ) async {
    pluginSelectionCalls.add((target: target, selections: selections));
    if (setPluginSelectionsHandler case final handler?) {
      return handler(selections);
    }
    return 'fake-cmd-${++_commandSeq}';
  }

  @override
  Future<String> cancelChat(RemoteChatTarget target) async {
    lastCancelTarget = target;
    return 'fake-cmd-${++_commandSeq}';
  }

  String? lastAnswerRequestId;
  List<AskUserQuestionAnswer>? lastAnswerAnswers;
  String? lastDismissRequestId;

  @override
  Future<String> answerChatQuestion(
    RemoteWorktreeChatTarget target, {
    required String requestId,
    required List<AskUserQuestionAnswer> answers,
  }) async {
    lastAnswerRequestId = requestId;
    lastAnswerAnswers = answers;
    return 'fake-cmd-${++_commandSeq}';
  }

  @override
  Future<String> dismissChatQuestion(
    RemoteWorktreeChatTarget target, {
    required String requestId,
  }) async {
    lastDismissRequestId = requestId;
    return 'fake-cmd-${++_commandSeq}';
  }

  String? lastHooksPausedHookKey;
  bool? lastHooksPausedValue;
  bool? lastHooksPausedAll;

  @override
  Future<String> setHooksPaused({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required bool paused,
    String? hookKey,
    bool all = false,
  }) async {
    lastHooksPausedHookKey = hookKey;
    lastHooksPausedValue = paused;
    lastHooksPausedAll = all;
    return 'fake-cmd-${++_commandSeq}';
  }

  @override
  Future<RemoteFileContents> readFile(RemoteFileRequest request) async =>
      const RemoteFileContents(
        contents: '',
        truncated: false,
        unsupported: false,
      );

  @override
  Future<RemoteFileLink?> resolveLink({
    required String projectId,
    required String worktreeId,
    required String href,
  }) async => null;

  @override
  Future<RemoteFileAsset> readAsset(RemoteFileRequest request) async =>
      RemoteFileAsset(
        bytes: Uint8List(0),
        filename: 'image.png',
        mediaType: 'image/png',
        version: 'fake',
      );

  /// Recorded [readFileDiff] arguments, in call order.
  final List<
    ({
      String workspaceLocalId,
      String worktreeLocalId,
      String path,
      RemoteDiffSource source,
      String? repoId,
    })
  >
  readFileDiffCalls = [];

  /// When set, [readFileDiff] defers to this; defaults to an empty patch.
  Future<RemoteFileDiff> Function(String path, RemoteDiffSource source)?
  readFileDiffHandler;

  @override
  Future<RemoteFileDiff> readFileDiff({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String path,
    required RemoteDiffSource source,
    String? repoId,
  }) async {
    readFileDiffCalls.add((
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      path: path,
      source: source,
      repoId: repoId,
    ));
    final handler = readFileDiffHandler;
    if (handler != null) return handler(path, source);
    return RemoteFileDiff(filePath: path, patch: '');
  }

  final List<
    ({String workspaceLocalId, String worktreeLocalId, String executionId})
  >
  pipelineExecutionRequests = [];
  final List<
    ({
      String workspaceLocalId,
      String worktreeLocalId,
      String executionId,
      String jobId,
      String stepId,
    })
  >
  pipelineStepLogRequests = [];
  Object? pipelineExecutionError;

  @override
  Future<String> requestPipelineExecution({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
  }) async {
    pipelineExecutionRequests.add((
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      executionId: executionId,
    ));
    if (pipelineExecutionError case final error?) throw error;
    return 'pipeline-execution-${pipelineExecutionRequests.length}';
  }

  @override
  Future<String> requestPipelineStepLog({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required String jobId,
    required String stepId,
  }) async {
    pipelineStepLogRequests.add((
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      executionId: executionId,
      jobId: jobId,
      stepId: stepId,
    ));
    return 'pipeline-log-${pipelineStepLogRequests.length}';
  }

  final List<
    ({
      String workspaceLocalId,
      String worktreeLocalId,
      String executionId,
      RemotePipelineRunAction action,
    })
  >
  pipelineRunActions = [];
  Object? pipelineRunActionError;

  @override
  Future<String> submitPipelineRunAction({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineRunAction action,
  }) async {
    pipelineRunActions.add((
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      executionId: executionId,
      action: action,
    ));
    if (pipelineRunActionError case final error?) throw error;
    return 'pipeline-action-${pipelineRunActions.length}';
  }

  @override
  bool supportsPipelineDispatch = true;

  /// Whether the session announces the `provider_usage` capability.
  bool supportsProviderUsage = false;

  /// Providers whose usage refresh was submitted, in order.
  final List<PortalProviderUsageProvider> providerUsageRefreshes = [];
  Object? providerUsageRefreshError;

  /// When set, a usage refresh waits on it before acknowledging.
  Completer<void>? providerUsageRefreshGate;

  @override
  late final providerUsage = RemoteProviderUsageCommands(
    hasCapability: (capability) =>
        capability == 'provider_usage' && supportsProviderUsage,
    submit: ({required type, required payload}) async {
      providerUsageRefreshes.add(
        PortalProviderUsageProvider.fromWire(payload['provider'] as String),
      );
      await providerUsageRefreshGate?.future;
      if (providerUsageRefreshError case final error?) throw error;
      return 'usage-refresh-${providerUsageRefreshes.length}';
    },
  );

  /// Payloads of the project clone commands submitted, in call order.
  final List<({String type, Map<String, dynamic> payload})> createProjectCalls =
      [];

  /// Answers a clone submit; defaults to a pending command `clone-<n>`.
  Future<RemotePortalCommandResult> Function(String remoteUrl)?
  createProjectHandler;

  /// Command ids whose status was read, in call order.
  final List<String> commandStatusReads = [];

  /// Answers a status read; defaults to a delivered command.
  Future<BrowserPortalCommandStatusResponse> Function(String commandId)?
  commandStatusHandler;

  @override
  late final projects = RemoteProjectCommands(
    submit: ({required type, required payload}) async {
      createProjectCalls.add((type: type, payload: payload));
      final handler = createProjectHandler;
      if (handler != null) return handler(payload['remoteUrl'] as String);
      return RemotePortalCommandResult(
        commandId: 'clone-${createProjectCalls.length}',
      );
    },
    readStatus: (commandId) async {
      commandStatusReads.add(commandId);
      final handler = commandStatusHandler;
      if (handler != null) return handler(commandId);
      return BrowserPortalCommandStatusResponse(
        commandId: commandId,
        status: BrowserPortalCommandStatus.delivered,
      );
    },
  );

  /// Whether the session announces the `app_advisor` capability.
  bool supportsAppAdvisor = false;

  /// Every App Advisor command submitted, as `{type, ...payload}`.
  final List<Map<String, dynamic>> appAdvisorCommands = [];

  /// Thrown by the next App Advisor command when set, then cleared.
  Object? appAdvisorError;

  /// The desktop's App Advisor settings answer; null simulates a server wait
  /// that timed out, so the answer must arrive as a command event.
  Map<String, dynamic>? appAdvisorSettings = const {};

  /// How many App Advisor settings reads were made.
  int appAdvisorSettingsReads = 0;

  Completer<void>? appAdvisorSettingsGate;
  Completer<void>? appAdvisorSubmitGate;

  @override
  late final appAdvisor = RemoteAppAdvisorCommands(
    hasCapability: (capability) =>
        capability == 'app_advisor' && supportsAppAdvisor,
    submit: ({required type, required payload}) async {
      appAdvisorCommands.add({'type': type, ...payload});
      if (appAdvisorError case final error?) {
        appAdvisorError = null;
        throw error;
      }
      final commandId = 'advisor-${appAdvisorCommands.length}';
      await appAdvisorSubmitGate?.future;
      return commandId;
    },
    request: ({required type, required payload, target}) async {
      if (type == 'portal.app_advisor.settings.get') {
        appAdvisorSettingsReads++;
        final commandId = 'settings-$appAdvisorSettingsReads';
        final settings = appAdvisorSettings;
        await appAdvisorSettingsGate?.future;
        return RemotePortalCommandResult(
          commandId: commandId,
          result: settings,
        );
      }
      appAdvisorCommands.add({'type': type, ...payload, 'target': ?target});
      if (appAdvisorError case final error?) {
        appAdvisorError = null;
        throw error;
      }
      return RemotePortalCommandResult(
        commandId: 'advisor-${appAdvisorCommands.length}',
      );
    },
  );

  /// Rows `portal.editor.list_slash_commands` answers with. Null answers
  /// without a result, like an older desktop that does not reply in time.
  List<Map<String, dynamic>>? slashCommands = const [];

  /// Thrown by the slash-command request when set.
  Object? slashCommandsError;

  /// When set, the slash-command request waits on it before answering.
  Completer<void>? slashCommandsGate;

  /// Payloads of every slash-command request, in order.
  final List<Map<String, dynamic>> slashCommandCalls = [];

  /// The `list_plugin_catalog` answer; null answers no result.
  Map<String, dynamic>? pluginCatalog;

  /// Payloads of every plugin catalog request, in order.
  final List<Map<String, dynamic>> pluginCatalogCalls = [];

  /// The paired desktop's `invocable_inventory` capability (CAN-3925).
  bool supportsInvocableInventory = false;

  /// Rows `portal.editor.list_invocables` answers with. Null answers
  /// without a result.
  List<Map<String, dynamic>>? invocables = const [];

  /// Every `list_invocables` and `resolve_invocable` request, in order.
  final List<Map<String, dynamic>> invocableCalls = [];

  /// When set, answers each `list_invocables` request instead of the
  /// default, which returns [invocables].
  Future<RemotePortalCommandResult> Function(Map<String, dynamic> payload)?
  listInvocablesHandler;

  /// When set, answers each `resolve_invocable` request instead of the
  /// default, which returns the listed row's insert text.
  Future<RemotePortalCommandResult> Function(Map<String, dynamic> payload)?
  resolveInvocableHandler;

  Future<RemotePortalCommandResult> _answerInvocables(
    String type,
    Map<String, String> target,
    Map<String, dynamic> payload,
  ) async {
    invocableCalls.add({'type': type, 'target': target, 'payload': payload});
    final commandId = 'invocables-${invocableCalls.length}';
    if (type == 'portal.editor.list_invocables') {
      if (listInvocablesHandler case final handler?) return handler(payload);
      final rows = invocables;
      return RemotePortalCommandResult(
        commandId: commandId,
        result: rows == null
            ? null
            : {'commands': rows, 'stale': false, 'rebuilding': false},
      );
    }
    if (resolveInvocableHandler case final handler?) return handler(payload);
    final row = invocables?.firstWhere(
      (row) => row['entryId'] == payload['entryId'],
    );
    return RemotePortalCommandResult(
      commandId: commandId,
      result: {
        'insertText': row?['insertText'] ?? '/${row?['name']} ',
        'invocationKey': '${row?['name']}',
      },
    );
  }

  @override
  late final composerCommands = RemoteComposerCommands(
    sessionId: () => 'fake-session',
    supportsInvocableInventory: () => supportsInvocableInventory,
    submit: ({required type, required target, required payload}) async {
      if (type == 'portal.chat.list_plugin_catalog') {
        pluginCatalogCalls.add({'target': target, ...payload});
        return RemotePortalCommandResult(
          commandId: 'catalog-${pluginCatalogCalls.length}',
          result: pluginCatalog,
        );
      }
      if (type == 'portal.editor.list_invocables' ||
          type == 'portal.editor.resolve_invocable') {
        return _answerInvocables(type, target, payload);
      }
      slashCommandCalls.add({'type': type, 'target': target, ...payload});
      await slashCommandsGate?.future;
      if (slashCommandsError case final error?) throw error;
      final rows = slashCommands;
      return RemotePortalCommandResult(
        commandId: 'slash-${slashCommandCalls.length}',
        result: rows == null ? null : {'commands': rows},
      );
    },
  );

  @override
  bool supportsPipelineRunChatLinks = true;

  @override
  bool supportsPipelineChatFollowUp = true;

  /// Every follow-up preparation, in call order.
  final List<
    ({
      String workspaceLocalId,
      String worktreeLocalId,
      String executionId,
      RemotePipelineFollowUpOutput output,
    })
  >
  followUpPrepareCalls = [];

  /// The receiving chat the default preparation names; null asks the client
  /// to create one.
  String? followUpChatId;

  /// When set, preparation defers to this instead of answering inline.
  Future<RemotePortalCommandResult> Function()? followUpPrepareHandler;

  @override
  Future<RemotePortalCommandResult> preparePipelineChatFollowUp({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineFollowUpOutput output,
  }) async {
    followUpPrepareCalls.add((
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      executionId: executionId,
      output: output,
    ));
    final handler = followUpPrepareHandler;
    if (handler != null) return handler();
    return RemotePortalCommandResult(
      commandId: 'follow-up-${followUpPrepareCalls.length}',
      result: followUpPreparationJson(
        workspaceLocalId: workspaceLocalId,
        worktreeLocalId: worktreeLocalId,
        executionId: executionId,
        output: output,
        chatId: followUpChatId,
      ),
    );
  }

  /// Off by default, as on a desktop before CAN-3717: the run viewer then
  /// shows the streamed step tail.
  bool supportsPipelineContent = false;

  /// Every content page read, in call order.
  final List<
    ({
      String executionId,
      Map<String, Object> source,
      int offset,
      String? revision,
    })
  >
  contentReadCalls = [];

  /// The documents the desktop serves, by source kind ('report', or
  /// `step_output:jobId:stepId`). A missing source reads as empty text.
  final Map<String, RemotePipelineContentDocument> contentDocuments = {};

  /// Most characters the default answer puts in one page.
  int contentPageSize = 1 << 20;

  /// When set, a content read defers to this instead of answering inline.
  Future<RemotePortalCommandResult> Function(int offset)? contentReadHandler;

  @override
  late final pipelineContent = RemotePipelineContentCommands(
    hasCapability: (_) => supportsPipelineContent,
    request: ({required type, required payload, target}) =>
        readPipelineContentPage(
          workspaceLocalId: payload['projectId'] as String,
          worktreeLocalId: payload['worktreeId'] as String,
          executionId: payload['executionId'] as String,
          source: switch (payload['source']) {
            {
              'kind': 'step_output',
              'jobId': String jobId,
              'stepId': String stepId,
            } =>
              RemotePipelineStepOutputSource(jobId: jobId, stepId: stepId),
            {'kind': 'report'} => const RemotePipelineReportSource(),
            _ => throw StateError('Unexpected pipeline content source'),
          },
          offset: payload['offset'] as int? ?? 0,
          revision: payload['revision'] as String?,
        ),
  );

  Future<RemotePortalCommandResult> readPipelineContentPage({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineContentSource source,
    int offset = 0,
    String? revision,
  }) async {
    contentReadCalls.add((
      executionId: executionId,
      source: source.toJson(),
      offset: offset,
      revision: revision,
    ));
    final handler = contentReadHandler;
    if (handler != null) return handler(offset);
    final key = switch (source) {
      RemotePipelineStepOutputSource(:final jobId, :final stepId) =>
        'step_output:$jobId:$stepId',
      RemotePipelineReportSource() => 'report',
    };
    final document =
        contentDocuments[key] ??
        const RemotePipelineContentDocument(
          format: RemotePipelineContentFormat.text,
          text: '',
        );
    return RemotePortalCommandResult(
      commandId: 'content-${contentReadCalls.length}',
      result: pipelineContentPageJson(
        document,
        offset: offset,
        pageSize: contentPageSize,
      ),
    );
  }

  final List<
    ({String workspaceLocalId, String worktreeLocalId, String pipelineId})
  >
  pipelineFormRequests = [];

  /// Returned inline as the small-RPC result; null simulates a server wait
  /// that timed out, so the answer must arrive as a command event.
  Map<String, dynamic>? pipelineFormResult = const {
    'definition': {'name': 'Pipeline'},
  };
  Object? pipelineFormError;

  /// When set, [requestPipelineDispatchForm] waits on it before answering, so
  /// tests can hold a form load in flight.
  Completer<void>? pipelineFormGate;

  @override
  Future<RemotePortalCommandResult> requestPipelineDispatchForm({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String pipelineId,
  }) async {
    pipelineFormRequests.add((
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      pipelineId: pipelineId,
    ));
    await pipelineFormGate?.future;
    if (pipelineFormError case final error?) throw error;
    return RemotePortalCommandResult(
      commandId: 'pipeline-get-${pipelineFormRequests.length}',
      result: pipelineFormResult,
    );
  }

  final List<
    ({
      String workspaceLocalId,
      String worktreeLocalId,
      String pipelineId,
      Map<String, String> inputs,
    })
  >
  pipelineDispatches = [];
  Object? pipelineDispatchError;

  /// When set, [dispatchPipeline] waits on it, so tests can hold a dispatch
  /// in flight.
  Completer<String>? pipelineDispatchGate;

  @override
  Future<String> dispatchPipeline({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String pipelineId,
    required Map<String, String> inputs,
  }) async {
    pipelineDispatches.add((
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      pipelineId: pipelineId,
      inputs: inputs,
    ));
    if (pipelineDispatchGate case final gate?) return gate.future;
    if (pipelineDispatchError case final error?) throw error;
    return 'pipeline-run-${pipelineDispatches.length}';
  }

  int requestOverviewStateCalls = 0;
  Future<void> Function()? requestOverviewStateHandler;
  bool requestOverviewStateCompleted = true;

  @override
  Future<bool> requestOverviewState() async {
    requestOverviewStateCalls += 1;
    await requestOverviewStateHandler?.call();
    return requestOverviewStateCompleted;
  }

  /// Settable desktop capability flag; defaults to an older desktop.
  @override
  bool supportsWorktreeChatSummariesScope = false;

  /// Recorded [fetchChatHistory] arguments, in call order.
  final List<({RemoteChatTarget target, String? before, int? limitTurns})>
  fetchChatHistoryCalls = [];

  /// When set, [fetchChatHistory] defers to this; defaults to an empty,
  /// exhausted history.
  Future<RemoteChatHistoryChunk> Function(String? before)?
  fetchChatHistoryHandler;

  @override
  Future<RemoteChatHistoryChunk> fetchChatHistory(
    RemoteChatTarget target, {
    String? before,
    int? limitTurns,
  }) async {
    fetchChatHistoryCalls.add((
      target: target,
      before: before,
      limitTurns: limitTurns,
    ));
    final handler = fetchChatHistoryHandler;
    if (handler != null) return handler(before);
    return const RemoteChatHistoryChunk(messages: [], nextCursor: null);
  }

  int requestWorktreeChatSummariesStateCalls = 0;
  Future<void> Function()? requestWorktreeChatSummariesHandler;

  @override
  Future<void> requestWorktreeChatSummariesState() async {
    requestWorktreeChatSummariesStateCalls += 1;
    await requestWorktreeChatSummariesHandler?.call();
  }

  /// Recorded [createWorktree] arguments, in call order.
  final List<
    ({
      String workspaceLocalId,
      List<String> existingWorktreeIds,
      String? baseWorktreeId,
      bool forkOpenTabs,
    })
  >
  createWorktreeCalls = [];

  /// Overrides [createWorktree]'s outcome; defaults to a completed create
  /// echoing a fresh worktree id. Throw from here to exercise failure paths,
  /// or return a pending result (no `worktreeLocalId`) for the timeout path.
  Future<RemoteWorktreeCreateResult> Function()? createWorktreeHandler;

  @override
  Future<RemoteWorktreeCreateResult> createWorktree({
    required String workspaceLocalId,
    List<String> existingWorktreeIds = const [],
    String? baseWorktreeId,
    bool forkOpenTabs = false,
  }) async {
    createWorktreeCalls.add((
      workspaceLocalId: workspaceLocalId,
      existingWorktreeIds: existingWorktreeIds,
      baseWorktreeId: baseWorktreeId,
      forkOpenTabs: forkOpenTabs,
    ));
    final handler = createWorktreeHandler;
    if (handler != null) return handler();
    return RemoteWorktreeCreateResult(
      commandId: 'fake-cmd-${++_commandSeq}',
      worktreeLocalId: 'wt-created-${createWorktreeCalls.length}',
    );
  }
}

/// A desktop's `portal.pipeline.chat_follow_up.prepare` result. Paths are
/// invented.
Map<String, dynamic> followUpPreparationJson({
  required String workspaceLocalId,
  required String worktreeLocalId,
  required String executionId,
  required RemotePipelineFollowUpOutput output,
  String? chatId,
}) => {
  'executionId': executionId,
  'projectId': workspaceLocalId,
  'worktreeId': worktreeLocalId,
  'output': output.name,
  'prompt': output == RemotePipelineFollowUpOutput.plan
      ? 'Review this plan: /plans/invoice-rounding.md'
      : 'Review this report: /runs/exec-1/report.md',
  'chatId': ?chatId,
};

/// A desktop's `portal.pipeline.content.read` page of [document].
Map<String, dynamic> pipelineContentPageJson(
  RemotePipelineContentDocument document, {
  int offset = 0,
  int pageSize = 1 << 20,
  String revision = 'r1',
}) {
  final end = (offset + pageSize).clamp(0, document.text.length);
  return {
    'format': document.format.name,
    'content': document.text.substring(offset, end),
    'offset': offset,
    'nextOffset': end,
    'length': document.text.length,
    'revision': revision,
  };
}

/// A `background_process` row (`PortalBackgroundProcessEntity`), as worktree
/// state reads and state deltas carry it. Ids and text are invented.
Map<String, dynamic> backgroundProcessJson({
  required String localId,
  String workspaceLocalId = 'ws-1',
  String worktreeLocalId = 'wt-1',
  String chatId = 'chat-1',
  String kind = 'bash',
  String status = 'running',
  String description = 'pnpm test',
  int startedAt = 1000,
  int updatedAt = 2000,
  bool canStop = true,
  String? taskId,
  String? summary,
  String? lastDescription,
}) => {
  'localId': localId,
  'workspaceLocalId': workspaceLocalId,
  'worktreeLocalId': worktreeLocalId,
  'chatId': chatId,
  'toolUseId': 'tool-$localId',
  'taskId': ?taskId,
  'kind': kind,
  'description': description,
  'status': status,
  'startedAt': startedAt,
  'updatedAt': updatedAt,
  'summary': ?summary,
  'lastDescription': ?lastDescription,
  'canStop': canStop,
};

/// The `portal.state.delta` envelope entity for [row].
Map<String, dynamic> backgroundProcessEntityJson(Map<String, dynamic> row) => {
  'entityType': 'background_process',
  'localId': row['localId'],
  'parentLocalId': '${row['workspaceLocalId']}:${row['worktreeLocalId']}',
  'payload': row,
};

Map<String, dynamic> watcherJson({
  String id = 'watch-pr',
  String projectId = 'ws-1',
  String worktreeId = 'wt-1',
  String chatId = 'chat-1',
  String trigger = 'github_pull_requests_changed',
  String status = 'active',
  String createdAt = '2026-10-27T12:00:00.000Z',
}) => {
  ...watcherFixtures(
    projectId: projectId,
    worktreeId: worktreeId,
    chatId: chatId,
  ).first,
  'id': id,
  'trigger': trigger,
  'status': status,
  'createdAt': createdAt,
};

Map<String, dynamic> watcherEntityJson(Map<String, dynamic> row) => {
  'entityType': 'watcher',
  'localId': row['id'],
  'parentLocalId': '${row['projectId']}:${row['worktreeId']}',
  'payload': row,
};

/// PR, workflow-run, wakeup and delivery-failed Portal projections.
List<Map<String, dynamic>> watcherFixtures({
  String projectId = 'ws-1',
  String worktreeId = 'wt-1',
  String chatId = 'chat-1',
}) => mockRemoteWatchers(
  projectId: projectId,
  worktreeId: worktreeId,
  chatId: chatId,
);
