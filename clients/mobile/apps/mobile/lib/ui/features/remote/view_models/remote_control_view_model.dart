import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_watcher.dart';
import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_pipeline_chat_follow_up.dart';
import 'package:mobile/data/models/remote_pipeline_content.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_watcher_commands.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/services/attachment_cache.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';
import 'package:mobile/ui/core/chat/view_models/attachment_thumbnail_cache.dart';

import 'background_tray/run_lifetime.dart';
import 'app_advisor_controller.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_draft.dart';
import 'chat_send_coordinator.dart';
import 'composer_overrides_controller.dart';
import 'hydration_coordinator.dart';
import 'overview_refresh_scheduler.dart';
import 'pipeline_dispatcher.dart';
import 'pr_state_tracker.dart';
import 'project_clone_coordinator.dart';
import 'remote_chat_change_notifier.dart';
import 'remote_chat_tabs_controller.dart';
import 'remote_client_engine.dart';
import 'remote_control_state.dart';
import 'remote_file_diff_cache.dart';
import 'remote_overview_sections.dart';
import 'remote_session_controller.dart' show RemoteLinkState;
import 'remote_unsent_sends.dart';
import 'worktree_archive_coordinator.dart';
import 'worktree_activity_load_tracker.dart';
import 'worktree_create_coordinator.dart';
import 'watcher_patch.dart' as watcher_patch;

export 'app_advisor_controller.dart'
    show RemoteAppAdvisorController, RemoteAppAdvisorEntry;
export 'chat_send_coordinator.dart' show kRemoteTurnStartGrace;
export 'hydration_coordinator.dart'
    show kRemoteHydrationRetryWindow, kRemoteHydrationTimeout;
export 'overview_refresh_scheduler.dart'
    show kRemoteDeltaRefreshInterval, kRemoteStateRefreshDebounce;
export 'pipeline_dispatcher.dart'
    show
        RemotePipelineDispatchFailed,
        RemotePipelineDispatchStarted,
        RemotePipelineDispatchState,
        RemotePipelineDispatchSubmitting,
        RemotePipelineFormFailed,
        RemotePipelineFormLoaded,
        RemotePipelineFormLoading,
        RemotePipelineFormState,
        kRemotePipelineDispatchTimeout,
        kRemotePipelineFormTimeout;
export 'pipeline_run_tracker.dart'
    show kRemotePipelineRunTimeout, kRemotePipelineActionTimeout;
export 'composer_overrides_controller.dart'
    show ComposerField, ComposerOverridesController;
export 'pending_chat_attachment_store.dart'
    show kRemotePendingChatAttachmentRetention;
export 'pr_state_tracker.dart' show PrStatePoll, kRemotePrRefreshInterval;
export 'remote_chat_tabs_controller.dart' show RemoteChatTabsController;
export 'remote_chat_change_notifier.dart' show RemoteChatChangeNotifier;
export 'remote_control_state.dart' show PendingChatAttachmentBatch;
export 'remote_session_controller.dart'
    show
        RemoteLinkState,
        kRemoteEventCatchUpMaxHold,
        kRemotePortalEventBatchMaxCount,
        kRemoteReconnectingGrace,
        kRemoteUnreachableAfter;
export 'worktree_archive_coordinator.dart' show kRemoteArchiveRestoreTimeout;
export 'worktree_activity_load_tracker.dart'
    show ChangedFilesLoadPhase, ChangedFilesLoadStatus;
export 'worktree_create_coordinator.dart'
    show
        RemoteWorktreeCreateAttempt,
        RemoteWorktreeCreatePhase,
        kRemoteWorktreeCreateRecoveryInterval,
        kRemoteWorktreeCreateTimeout;

/// Manages state for the Remote tab: the pairing
/// lifecycle and, once connected, the desktop session snapshot, live event
/// stream, and per-chat transcripts.
///
/// A Flutter facade over [RemoteClientEngine], which owns every piece of
/// client state and the routing between its collaborators. This class only
/// forwards the public API and turns engine changes into listener
/// notifications, and it owns the Flutter-bound caches the engine reaches
/// through ports.
///
/// This view model is device/user-scoped (not org-scoped) and is provided
/// outside the org-keyed subtree so it survives organization switches.  It
/// starts [RemoteConnectionStatus.disconnected] with no eager network load;
/// the Workspaces tab kicks off a one-shot [restoreIfIdle] on first build.
final class RemoteControlViewModel extends ChangeNotifier
    with DisposeSafeNotifier {
  RemoteControlViewModel({
    required this.repository,
    this.stateRefreshDebounce = kRemoteStateRefreshDebounce,
    this.hydrationRetryWindow = kRemoteHydrationRetryWindow,
    this.hydrationTimeout = kRemoteHydrationTimeout,
    this.worktreeCreateRecoveryInterval = kRemoteWorktreeCreateRecoveryInterval,
    this.worktreeCreateTimeout = kRemoteWorktreeCreateTimeout,
    this.archiveRestoreTimeout = kRemoteArchiveRestoreTimeout,
    AttachmentCache? attachmentCache,
    RemoteFileDiffCache? fileDiffCache,
    DateTime Function()? clock,
    this.onSuccessfulTurn,
    this._draftStore,
    this.transcriptCache,
  }) : attachmentCache = attachmentCache ?? AttachmentCache(),
       fileDiffCache = fileDiffCache ?? RemoteFileDiffCache(maxEntries: 32),
       _clock = clock ?? DateTime.now;

  final RemoteControlRepository repository;

  /// Called once for each live turn observed completing successfully.
  final void Function(String turnKey)? onSuccessfulTurn;
  final AttachmentCache attachmentCache;

  /// Diffs the user has opened this session, so re-opening a changed file
  /// is instant. Bounded LRU; cleared with the session.
  final RemoteFileDiffCache fileDiffCache;

  /// Thumbnails for images sent from this device, so the transcript previews
  /// them instead of only naming them. Owned here rather than by the chat
  /// screen so a preview survives navigating away and back; cleared with the
  /// session, since the attachment ids it keys on belong to that pairing.
  final AttachmentThumbnailCache attachmentThumbnails =
      AttachmentThumbnailCache();

  /// Injectable for tests; see [kRemoteStateRefreshDebounce].
  final Duration stateRefreshDebounce;

  /// Injectable for tests; see [kRemoteHydrationRetryWindow].
  final Duration hydrationRetryWindow;

  /// Injectable for tests; see [kRemoteHydrationTimeout].
  final Duration hydrationTimeout;

  /// Injectable for tests; see [kRemoteWorktreeCreateRecoveryInterval].
  final Duration worktreeCreateRecoveryInterval;

  /// Injectable for tests; see [kRemoteWorktreeCreateTimeout].
  final Duration worktreeCreateTimeout;

  /// Injectable for tests; see [kRemoteArchiveRestoreTimeout].
  final Duration archiveRestoreTimeout;

  final DateTime Function() _clock;

  /// The account's draft store, where unconfirmed text sends persist.
  final ChatDraftStore? _draftStore;

  /// The account's recent chat tails on this device; see
  /// [RemoteClientEngine.transcriptCache].
  final RemoteTranscriptCache? transcriptCache;

  late final _engine = RemoteClientEngine(
    repository: repository,
    onChanged: notifyListenersSafe,
    orderWorktrees: orderedRemoteWorktrees,
    archiveLedger: attachmentCache,
    restoreSessionCaches: (sessionId) =>
        unawaited(fileDiffCache.restoreSession(sessionId)),
    flushSessionCaches: fileDiffCache.flush,
    clearSessionCaches: () {
      fileDiffCache.clear();
      attachmentThumbnails.clear();
    },
    stateRefreshDebounce: stateRefreshDebounce,
    hydrationRetryWindow: hydrationRetryWindow,
    hydrationTimeout: hydrationTimeout,
    worktreeCreateRecoveryInterval: worktreeCreateRecoveryInterval,
    worktreeCreateTimeout: worktreeCreateTimeout,
    archiveRestoreTimeout: archiveRestoreTimeout,
    clock: _clock,
    onSuccessfulTurn: onSuccessfulTurn,
    unsentStore: _draftStore,
    transcriptCache: transcriptCache,
  );

  /// See [RemoteClientEngine.retainPendingChatAttachments].
  void retainPendingChatAttachments({
    required String commandId,
    required RemoteChatTarget target,
    required List<ChatAttachmentDraft> drafts,
    String? provisionalCreateCommandId,
    bool restoreImmediately = false,
  }) => _engine.retainPendingChatAttachments(
    commandId: commandId,
    target: target,
    drafts: drafts,
    provisionalCreateCommandId: provisionalCreateCommandId,
    restoreImmediately: restoreImmediately,
  );
  String retainSubmittingChatAttachments({
    required RemoteChatTarget target,
    required List<ChatAttachmentDraft> drafts,
  }) => _engine.attachments.retainSubmittingChatAttachments(
    target: target,
    drafts: drafts,
    sessionGeneration: _engine.session.sessionGeneration,
  );
  void markPendingChatAttachmentsForRestore(String commandId) =>
      _engine.attachments.markPendingChatAttachmentsForRestore(commandId);
  List<PendingChatAttachmentBatch> pendingChatAttachmentsFor(
    RemoteChatTarget target,
  ) => _engine.attachments.pendingChatAttachmentsFor(target);
  List<PendingChatAttachmentBatch> pendingChatAttachmentsForWorktree(
    RemoteWorktree worktree,
  ) => _engine.attachments.pendingChatAttachmentsForWorktree(worktree);
  void removePendingChatAttachments(String commandId) =>
      _engine.attachments.removePendingChatAttachments(commandId);

  /// See [RemoteClientEngine.hasRestorableChatAttachments].
  bool hasRestorableChatAttachments({
    required RemoteChatTarget? target,
    RemoteWorktree? worktree,
  }) =>
      _engine.hasRestorableChatAttachments(target: target, worktree: worktree);

  /// See [RemoteClientEngine.takeRestorableChatAttachments].
  List<PendingChatAttachmentBatch> takeRestorableChatAttachments({
    required RemoteChatTarget? target,
    RemoteWorktree? worktree,
  }) =>
      _engine.takeRestorableChatAttachments(target: target, worktree: worktree);

  /// See [RemoteClientEngine.chatTabs].
  RemoteChatTabsController chatTabs({
    required VoidCallback onChanged,
    required void Function(String chatId) onCreateFailed,
    String? initialChatId,
  }) => _engine.chatTabs(
    onChanged: onChanged,
    onCreateFailed: onCreateFailed,
    initialChatId: initialChatId,
  );

  /// The chat tab last shown in [worktree] during this session, if any.
  String? lastViewedChatId(RemoteWorktree worktree) {
    final listed = {
      for (final summary in chatSummariesFor(
        workspaceLocalId: worktree.workspaceLocalId,
        worktreeLocalId: worktree.localId,
      ))
        summary.chatId,
    };
    return _engine.lastViewedChatTabs.chatIdFor(
      remoteWorktreeKeyOf(worktree),
      isListed: listed.contains,
    );
  }

  /// Remembers [chatId] as the tab shown in [worktree], so the worktree
  /// reopens on it. A [pending] new tab is remembered once the desktop
  /// lists it. A screen opened under [sessionGeneration] records nothing
  /// once that session is torn down, so its tab is not carried into the
  /// next one.
  void recordViewedChat(
    RemoteWorktree worktree,
    String chatId, {
    required bool pending,
    required int sessionGeneration,
  }) {
    if (!_engine.session.isSessionCurrent(sessionGeneration)) return;
    _engine.lastViewedChatTabs.record(
      remoteWorktreeKeyOf(worktree),
      chatId,
      pending: pending,
    );
  }

  /// See [RemoteClientEngine.composerOverrides].
  ComposerOverridesController composerOverrides({
    required VoidCallback onChanged,
  }) => _engine.composerOverrides(onChanged: onChanged);

  /// A client-minted id for a flat workspace's first standalone chat.
  String mintStandaloneChatId() =>
      _engine.sends.mintChatId(RemoteChatScope.standalone);

  RemotePrProgressState? prProgressFor(
    String workspaceLocalId,
    String worktreeLocalId,
  ) => _engine.prState.prProgressFor(workspaceLocalId, worktreeLocalId);
  List<RemotePrRepo>? cachedPrReposFor(
    String workspaceLocalId,
    String worktreeLocalId,
  ) => _engine.prState.cachedPrReposFor(workspaceLocalId, worktreeLocalId);
  bool cachedPrBusyFor(String workspaceLocalId, String worktreeLocalId) =>
      _engine.prState.cachedPrBusyFor(workspaceLocalId, worktreeLocalId);
  Future<void> refreshPrState(RemoteWorktree worktree) =>
      _engine.prState.refreshPrState(worktree);

  /// See [PrStateTracker.pollPrState].
  PrStatePoll pollPrState(RemoteWorktree worktree) =>
      _engine.prState.pollPrState(worktree);
  Future<Map<String, dynamic>> runPrAction(
    RemoteWorktree worktree,
    RemotePrAction action, {
    String? repoId,
    RemotePrActionIdentity? identity,
    bool confirmUnresolvedComments = false,
  }) => _engine.prState.runPrAction(
    worktree,
    action,
    repoId: repoId,
    identity: identity,
    confirmUnresolvedComments: confirmUnresolvedComments,
  );
  Future<void> setHooksPaused({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required bool paused,
    String? hookKey,
    bool all = false,
  }) => _engine.prState.setHooksPaused(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
    paused: paused,
    hookKey: hookKey,
    all: all,
  );

  Set<String> chatsNeedingAnswerFor(RemoteWorktree worktree) =>
      _engine.questions.chatsNeedingAnswerFor(worktree);
  bool worktreeNeedsAnswer(RemoteWorktree worktree) =>
      _engine.questions.worktreeNeedsAnswer(worktree);
  List<AskUserQuestionState> pendingQuestionsFor(RemoteChatTarget target) =>
      _engine.questions.pendingQuestionsFor(target);
  Future<void> answerQuestion(
    RemoteWorktreeChatTarget target, {
    required String requestId,
    required List<AskUserQuestionAnswer> answers,
  }) => _engine.questions.answerQuestion(
    target,
    requestId: requestId,
    answers: answers,
  );
  Future<void> dismissQuestion(
    RemoteWorktreeChatTarget target, {
    required String requestId,
  }) => _engine.questions.dismissQuestion(target, requestId: requestId);

  /// Projects this phone asked the desktop to clone, until they appear.
  List<RemoteProjectClone> get projectClones => _engine.projectClones.clones;

  /// See [ProjectCloneCoordinator.addProject].
  Future<String?> addProject(String remoteUrl) =>
      _engine.projectClones.addProject(remoteUrl);

  void dismissProjectClone(int id) => _engine.projectClones.dismiss(id);

  bool canArchiveWorktree(RemoteWorktree worktree) =>
      _engine.archives.canArchiveWorktree(worktree);
  bool isArchivingWorktree(RemoteWorktree worktree) =>
      _engine.archives.isArchivingWorktree(worktree);
  Future<void> archiveWorktree(RemoteWorktree worktree) =>
      _engine.archives.archiveWorktree(worktree);

  /// Whether rows offer per-space notification choices: the server enabled
  /// them for this paired session (CAN-3615).
  bool get canChooseSpaceNotifications =>
      isConnected && connection?.spaceNotificationSettingsEnabled == true;

  /// Current pairing lifecycle state.
  RemoteConnectionStatus get status => _engine.session.status;

  /// Metadata about the paired desktop; non-null only when [isConnected].
  RemoteConnection? get connection => _engine.session.connection;

  /// The most recent session snapshot; non-null once a fetch has succeeded.
  RemoteSessionSnapshot? get snapshot => _engine.store.snapshot;

  /// Non-null when the most recent connect/fetch ended with an error.
  Object? get error => _engine.session.error;

  /// True while a pairing attempt is in flight.
  bool get isConnecting => _engine.session.isConnecting;

  /// True when paired with a desktop.
  bool get isConnected => _engine.session.isConnected;

  /// True while the one-shot session restore probe is in flight.
  bool get isRestoring => _engine.session.isRestoring;

  /// True once a restore probe has definitively found a session or its absence.
  /// An inconclusive probe cannot establish that there is no paired desktop.
  bool get hasProbedSession => _engine.session.hasProbedSession;

  /// See [RemoteSessionController.isRestoreRetrying].
  bool get isRestoreRetrying => _engine.session.isRestoreRetrying;

  /// True when the server reported its cached projection missing/stale and a
  /// fresh desktop snapshot is on its way (`state.refreshing`). While true, an
  /// empty workspace list means "still syncing", not "no workspaces".
  bool get isSyncing => snapshot?.refreshing == true;

  bool isWorktreeChatsLoading({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) => _engine.hydration.isWorktreeChatsLoading(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
  );
  bool isChatTranscriptLoading(RemoteChatTarget target) =>
      _engine.hydration.isChatTranscriptLoading(target);
  String? chatHydrationError(RemoteChatTarget target) =>
      _engine.hydration.chatHydrationError(target);
  void retryChatTranscript(RemoteChatTarget target) =>
      _engine.hydration.retryChatTranscript(target);
  void dismissChatHydrationError(RemoteChatTarget target) =>
      _engine.hydration.dismissChatHydrationError(target);
  void reopenChatTranscript(RemoteChatTarget target) {
    final chat = remoteChatKeyForTarget(target);
    if (chat != null && isConnected) {
      transcriptCache?.openTail(
        chat,
        rows: () => _engine.transcripts.projectedRows(chat),
        authoritative: () => _engine.transcripts.hasAuthoritativeRows(chat),
      );
    }
    _engine.hydration.reopenChatTranscript(target);
  }

  String? foregroundChatError(
    String workspaceLocalId,
    String worktreeLocalId,
  ) => _engine.hydration.foregroundChatError(workspaceLocalId, worktreeLocalId);
  void retryForegroundChat(String workspaceLocalId, String worktreeLocalId) =>
      _engine.hydration.retryForegroundChat(workspaceLocalId, worktreeLocalId);
  void ensureForegroundWorktreeChat({
    required String workspaceLocalId,
    required String worktreeLocalId,
    String? chatId,
  }) => _engine.hydration.ensureForegroundWorktreeChat(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
    chatId: chatId,
  );
  void ensureWorktreeState({
    required String workspaceLocalId,
    required String worktreeLocalId,
    bool refresh = false,
  }) => _engine.hydration.ensureWorktreeState(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
    refresh: refresh,
  );
  void ensurePipelineRuns({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) => _engine.hydration.ensurePipelineRuns(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
  );
  void ensureChatTranscript(RemoteChatTarget target) =>
      _engine.hydration.ensureChatTranscript(target);
  void ensureChatSummariesIndex({bool background = false}) =>
      _engine.hydration.ensureChatSummariesIndex(background: background);
  bool get canSearchChats => _engine.hydration.canSearchChats;
  bool get isChatSummariesLoading => _engine.hydration.isChatSummariesLoading;
  String? get chatSummariesError => _engine.hydration.chatSummariesError;
  void retryChatSummariesIndex() => _engine.hydration.retryChatSummariesIndex();
  RemoteWorktreeActivity worktreeActivityFor(String worktreeLocalId) =>
      _engine.hydration.worktreeActivityFor(worktreeLocalId);

  /// One worktree chat's background processes, filtered by chat, workspace
  /// and worktree as the web Portal filters them (CAN-5253). Empty until the
  /// worktree's activity slices are read.
  List<RemoteBackgroundProcess> backgroundProcessesFor({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String chatId,
  }) {
    final processes = _engine.hydration.backgroundProcesses.processesFor(
      remoteWorktreeKey(workspaceLocalId, worktreeLocalId),
    );
    return processes == null
        ? worktreeActivityFor(worktreeLocalId).backgroundProcessesForChat(
            workspaceLocalId: workspaceLocalId,
            chatId: chatId,
          )
        : [
            for (final process in processes)
              if (process.workspaceLocalId == workspaceLocalId &&
                  process.chatId == chatId)
                process,
          ];
  }

  void ensureBackgroundProcesses({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) => _engine.hydration.ensureBackgroundProcesses(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
  );
  bool get supportsChatWatchers => repository.watchers.supportsChatWatchers;

  /// Worktree IDs can repeat across workspaces, so callers supply both.
  List<RemoteWatcher> watchersForChat(
    String worktreeId,
    String chatId, {
    required String workspaceLocalId,
  }) {
    if (!supportsChatWatchers) return const [];
    return watcher_patch.watchersForChat(
      _engine.hydration.watcherSlices.watchersFor(
        remoteWorktreeKey(workspaceLocalId, worktreeId),
      ),
      projectId: workspaceLocalId,
      worktreeId: worktreeId,
      chatId: chatId,
    );
  }

  /// Completes once the desktop confirms; the row leaves when its removal
  /// delta lands. Throws [RemoteWatcherDeleteException].
  Future<void> deleteWatcher(
    String watcherId, {
    required bool notifySubscriber,
  }) async {
    final sessionId = connection?.sessionId;
    if (sessionId == null) {
      throw const RemoteWatcherDeleteException(
        RemoteWatcherDeleteFailure.forbidden,
        'This paired session has ended.',
      );
    }
    await repository.watchers.deleteWatcher(
      sessionId,
      watcherId,
      notifySubscriber: notifySubscriber,
    );
  }

  Future<void> refreshWorktreeActivity({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) => _engine.hydration.refreshWorktreeActivity(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
  );
  void refreshChangedFiles({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) => _engine.hydration.refreshChangedFiles(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
  );
  void ensureChangedFiles({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) => _engine.hydration.ensureChangedFiles(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
  );
  ChangedFilesLoadStatus changedFilesStatus(String worktreeLocalId) =>
      _engine.hydration.changedFilesStatus(worktreeLocalId);

  void setRemoteVisible(bool visible) =>
      _engine.overviewRefresh.setRemoteVisible(visible);
  VoidCallback beginRemoteRouteVisibility() =>
      _engine.overviewRefresh.beginRemoteRouteVisibility();

  /// Desktop liveness derived server-side from heartbeat age; refreshed by
  /// every event batch. Null until the first batch (or state read) arrives.
  RemotePortalConnectionStatus? get portalConnectionStatus =>
      _engine.session.portalConnectionStatus;

  /// This phone's own event delivery; see [RemoteLinkState].
  RemoteLinkState get linkState => _engine.session.linkState;

  /// Latest asynchronous desktop-command failure, retained until dismissed.
  String? get commandFailureMessage => _engine.commands.failureMessage;

  void clearCommandFailure() => _engine.clearCommandFailure();

  /// Whether the desktop asynchronously rejected [commandId]. Retained for
  /// the paired session so UI-owned optimistic controls can reconcile even
  /// when the failure event races ahead of the submit response.
  bool hasCommandFailed(String? commandId) =>
      _engine.commands.hasFailed(commandId);

  /// Whether the paired desktop reported terminal success for [commandId].
  bool hasCommandCompleted(String? commandId) =>
      _engine.commands.hasCompleted(commandId);

  /// Changes whenever the paired remote session is discarded. UI-owned
  /// optimistic state can use this to avoid carrying a command across a
  /// disconnect and subsequent restore.
  int get sessionGeneration => _engine.session.sessionGeneration;

  int? _trayGeneration;
  BackgroundTrayRunLifetime _trayLifetime = BackgroundTrayRunLifetime();

  /// Seen-live runs belong to this pairing, beyond any mounted chat.
  BackgroundTrayRunLifetime get backgroundTrayRunLifetime {
    if (_trayGeneration != sessionGeneration) {
      _trayGeneration = sessionGeneration;
      _trayLifetime = BackgroundTrayRunLifetime();
    }
    return _trayLifetime;
  }

  /// Workspaces in saved desktop sidebar order, independent of transport order.
  List<RemoteWorkspace> get workspaces => _engine.store.workspaces;

  /// All worktrees across every workspace, in saved sidebar order.
  List<RemoteWorktree> get allWorktrees => _engine.store.allWorktrees;

  /// All standalone (cowork) chats across every workspace.
  List<RemoteStandaloneChat> get allStandaloneChats =>
      _engine.store.allStandaloneChats;

  /// All cached chat summaries across every worktree.
  List<RemoteChatSummary> get allChatSummaries =>
      _engine.store.allChatSummaries;

  Future<void> acknowledgeVisibleChat(
    RemoteChatTarget target,
    String? messageId,
  ) => _engine.readReceipts.acknowledgeVisibleChat(target, messageId);

  /// True when the paired desktop can accept cloud attachments on chat
  /// sends.
  bool get supportsChatAttachments => repository.supportsChatAttachments;
  bool get supportsStandaloneChatCreate =>
      repository.supportsStandaloneChatCreate;

  bool isLoadingOlderMessages(RemoteChatTarget target) =>
      _engine.transcripts.isLoadingOlderMessages(target);
  bool canLoadOlderMessages(RemoteChatTarget target) =>
      _engine.transcripts.canLoadOlderMessages(target);
  Future<void> loadOlderMessages(RemoteChatTarget target) =>
      _engine.transcripts.loadOlderMessages(target);
  bool isStreamingForChat(RemoteChatTarget target) =>
      _engine.transcripts.isStreamingForChat(target);

  /// The transcript for [target]: authoritative messages, then optimistic
  /// sends still awaiting their desktop echo, then not-sent or uncertain rows.
  List<RemoteChatMessage> messagesFor(RemoteChatTarget target) =>
      _engine.messagesFor(target);

  List<RemoteWorktree> worktreesFor(String workspaceLocalId) =>
      _engine.store.worktreesFor(workspaceLocalId);
  List<RemoteStandaloneChat> standaloneChatsFor(String workspaceLocalId) =>
      _engine.store.standaloneChatsFor(workspaceLocalId);
  RemoteStandaloneChat? standaloneChatById(String chatId) =>
      _engine.store.standaloneChatById(chatId);
  RemoteWorktree? worktreeForChatId(String chatId) =>
      _engine.store.worktreeForChatId(chatId);
  List<RemoteStandaloneChat> get unmatchedStandaloneChats =>
      _engine.store.unmatchedStandaloneChats;
  List<RemotePipelineRun> pipelineRunsFor(String worktreeLocalId) =>
      _engine.pipelineRuns.pipelineRunsFor(worktreeLocalId);
  RemotePipelineRun? pipelineRunFor({
    required String worktreeLocalId,
    required String executionId,
  }) => _engine.pipelineRuns.pipelineRunFor(
    worktreeLocalId: worktreeLocalId,
    executionId: executionId,
  );
  bool isPipelineRunPending(String executionId) =>
      _engine.pipelineRuns.isPipelineRunPending(executionId);
  String? pipelineRunError(String executionId) =>
      _engine.pipelineRuns.pipelineRunError(executionId);
  Future<void> requestPipelineRunDetail({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
  }) => _engine.pipelineRuns.requestPipelineRunDetail(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
    executionId: executionId,
  );
  Future<void> requestPipelineStepLog({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required String jobId,
    required String stepId,
  }) => _engine.pipelineRuns.requestPipelineStepLog(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
    executionId: executionId,
    jobId: jobId,
    stepId: stepId,
  );
  RemotePipelineRunAction? pendingPipelineRunAction(String executionId) =>
      _engine.pipelineRuns.pendingPipelineRunAction(executionId);
  String? pipelineRunActionError(String executionId) =>
      _engine.pipelineRuns.pipelineRunActionError(executionId);
  void clearPipelineRunActionError(String executionId) =>
      _engine.pipelineRuns.clearPipelineRunActionError(executionId);
  Future<void> submitPipelineRunAction({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineRunAction action,
  }) => _engine.pipelineRuns.submitPipelineRunAction(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
    executionId: executionId,
    action: action,
  );
  bool get supportsPipelineDispatch => repository.supportsPipelineDispatch;
  bool get supportsPipelineRunChatLinks =>
      repository.supportsPipelineRunChatLinks;
  bool get supportsPipelineChatFollowUp =>
      repository.supportsPipelineChatFollowUp;
  bool isPipelineChatFollowUpPending(String executionId) =>
      _engine.pipelineFollowUps.isPending(executionId);
  String? pipelineChatFollowUpError(String executionId) =>
      _engine.pipelineFollowUps.error(executionId);
  void clearPipelineChatFollowUpError(String executionId) =>
      _engine.pipelineFollowUps.clearError(executionId);
  Future<RemoteWorktreeChatTarget?> startPipelineChatFollowUp(
    RemotePipelineRun run,
    RemotePipelineFollowUpOutput output,
  ) => _engine.pipelineFollowUps.start(run, output);
  bool get supportsPipelineContent => repository.pipelineContent.isSupported;

  /// A step's complete readable output or the run's saved report, read on
  /// demand (CAN-3717). Throws [RemoteControlException] when it can't be read.
  Future<RemotePipelineContentDocument> readPipelineContent({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineContentSource source,
  }) => _engine.pipelineContent.read(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
    executionId: executionId,
    source: source,
  );
  bool get supportsForegroundChat => repository.supportsForegroundChat;

  /// Whether the paired desktop announces Claude and Codex plan usage.
  bool get supportsProviderUsage => repository.providerUsage.isSupported;

  /// The desktop's latest projected plan usage; null until projected.
  PortalProviderUsageProjection? get providerUsage =>
      _engine.providerUsage.projection;
  bool isProviderUsageRefreshing(PortalProviderUsageProvider provider) =>
      _engine.providerUsage.isRefreshing(provider);
  String? providerUsageRefreshFailure(PortalProviderUsageProvider provider) =>
      _engine.providerUsage.refreshFailure(provider);
  Future<void> refreshProviderUsage(PortalProviderUsageProvider provider) =>
      _engine.providerUsage.refresh(provider);

  /// The paired desktop's App Advisor chats (CAN-3989).
  RemoteAppAdvisorController get appAdvisor => _engine.appAdvisor;
  RemotePipelineFormState? pipelineFormState({
    required String worktreeLocalId,
    required String pipelineId,
  }) => _engine.pipelineDispatch.formState(
    worktreeLocalId: worktreeLocalId,
    pipelineId: pipelineId,
  );
  Future<void> loadPipelineForm({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String pipelineId,
  }) => _engine.pipelineDispatch.loadForm(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
    pipelineId: pipelineId,
  );
  RemotePipelineDispatchState? pipelineDispatchState({
    required String worktreeLocalId,
    required String pipelineId,
  }) => _engine.pipelineDispatch.dispatchState(
    worktreeLocalId: worktreeLocalId,
    pipelineId: pipelineId,
  );
  Future<void> dispatchPipeline({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String pipelineId,
    required Map<String, String> inputs,
  }) => _engine.pipelineDispatch.dispatch(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
    pipelineId: pipelineId,
    inputs: inputs,
  );
  void clearPipelineDispatch({
    required String worktreeLocalId,
    required String pipelineId,
  }) => _engine.pipelineDispatch.clearDispatch(
    worktreeLocalId: worktreeLocalId,
    pipelineId: pipelineId,
  );

  List<RemoteChatSummary> chatSummariesFor({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) => _engine.store.chatSummariesFor(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
  );
  List<ModelOption> get projectedModelCatalog =>
      _engine.store.projectedModelCatalog;
  bool get projectedModelCatalogIsAuthoritative =>
      _engine.store.projectedModelCatalogIsAuthoritative;
  ProviderAvailability? get projectedProviderAvailability =>
      _engine.store.projectedProviderAvailability;

  bool get supportsPrActions => repository.supportsPrActions;

  /// See [RemoteSessionController.restoreIfIdle].
  Future<void> restoreIfIdle() => _engine.session.restoreIfIdle();

  /// See [RemoteSessionController.settleWithoutDesktop].
  void settleWithoutDesktop({bool notify = true}) =>
      _engine.session.settleWithoutDesktop(notify: notify);

  /// See [RemoteSessionController.allowDesktop].
  void allowDesktop({bool notify = true}) =>
      _engine.session.allowDesktop(notify: notify);

  /// See [RemoteSessionController.connect].
  Future<void> connect(String pairingCode) =>
      _engine.session.connect(pairingCode);

  /// Tears down the pairing and returns to the disconnected state.
  Future<void> disconnect() => _engine.session.disconnect();

  /// Re-fetches the session snapshot (pull-to-refresh).  No-op unless
  /// currently connected.  Uses the same load-generation guard as [connect].
  Future<bool> refresh() {
    retryChatSummariesIndex();
    return _engine.refresh();
  }

  /// See [ChatSendCoordinator.sendChatMessage].
  Future<RemoteChatSendResult> sendChatMessage(
    RemoteChatTarget target,
    String text, {
    RemoteChatSendOptions? options,
    DraftTarget? clearDraft,
  }) => _engine.sends.sendChatMessage(
    target,
    text,
    options: options,
    clearDraft: clearDraft,
  );

  /// See [ChatSendCoordinator.resend].
  Future<void> resendUnsent(String messageId) =>
      _engine.sends.resend(messageId);

  /// Chat ids in a worktree that hold unconfirmed sends, newest first. Some
  /// may not exist on the desktop yet; see
  /// [RemoteUnsentSends.recordsForWorktree].
  List<String> unsentChatIdsForWorktree(
    String workspaceLocalId,
    String worktreeLocalId,
  ) => _uniqueChatIds(
    _engine.unsent.recordsForWorktree(workspaceLocalId, worktreeLocalId),
  );

  /// Standalone chat ids sent from the flat workspace [projectLocalId] that
  /// hold unconfirmed sends, newest first.
  List<String> unsentStandaloneChatIdsForProject(String projectLocalId) =>
      _uniqueChatIds(
        _engine.unsent.standaloneRecordsForProject(projectLocalId),
      );

  static List<String> _uniqueChatIds(List<RemoteUnsentRecord> records) => [
    ...{for (final record in records) ?record.target.chatId},
  ];

  /// Drops a not-sent or uncertain row without sending it.
  void discardUnsent(String messageId) {
    _engine.unsent.remove(messageId);
    notifyListenersSafe();
  }

  /// See [ChatSendCoordinator.createChatTab].
  Future<String> createChatTab(RemoteWorktreeChatTarget target) =>
      _engine.sends.createChatTab(target);

  Future<void> ensureStandaloneChatCreated(RemoteStandaloneChatTarget target) =>
      _engine.sends.ensureStandaloneChatCreated(target);

  Future<String> submitResponseFork(
    RemoteWorktreeChatTarget target,
    String turnKey, {
    required void Function(Map<String, dynamic>?) onCompleted,
    required void Function(String) onFailed,
  }) => _engine.sends.forkResponse(
    target,
    turnKey,
    onCompleted: onCompleted,
    onFailed: onFailed,
  );

  /// Registers a close command so the screen can reconcile optimistic removal.
  Future<String> closeChatTab(RemoteWorktreeChatTarget target) =>
      _engine.sends.closeChatTab(target);

  /// See [WorktreeCreateCoordinator.isCreatingWorktree].
  bool get isCreatingWorktree => _engine.worktreeCreates.isCreatingWorktree;

  /// See [WorktreeCreateCoordinator.creatingWorktreeWorkspaceId].
  String? get creatingWorktreeWorkspaceId =>
      _engine.worktreeCreates.creatingWorktreeWorkspaceId;

  /// See [WorktreeCreateCoordinator.isWorktreeCreateStillRunning].
  bool get isWorktreeCreateStillRunning =>
      _engine.worktreeCreates.isWorktreeCreateStillRunning;

  /// See [WorktreeCreateCoordinator.worktreeCreatePhase].
  RemoteWorktreeCreatePhase? get worktreeCreatePhase =>
      _engine.worktreeCreates.worktreeCreatePhase;

  /// See [WorktreeCreateCoordinator.createWorktree].
  Future<RemoteWorktree> createWorktree({
    required String workspaceLocalId,
    String? baseWorktreeId,
    bool forkOpenTabs = false,
    RemoteWorktreeCreateAttempt? attempt,
  }) => _engine.worktreeCreates.createWorktree(
    workspaceLocalId: workspaceLocalId,
    baseWorktreeId: baseWorktreeId,
    forkOpenTabs: forkOpenTabs,
    attempt: attempt,
  );

  /// Persists the chat's model without sending a message. Rethrows
  /// [RemoteControlException] so the composer can revert an optimistic flip.
  Future<String> setChatModel(RemoteChatTarget target, String model) =>
      _engine.sends.setChatModel(target, model);

  /// Toggles plan mode on a worktree chat. Rethrows on failure.
  Future<String> setChatPlanMode(
    RemoteWorktreeChatTarget target,
    bool planMode,
  ) => _engine.sends.setChatPlanMode(target, planMode);

  /// Sets the thinking level on a worktree chat. Rethrows on failure.
  Future<String> setChatThinkingLevel(
    RemoteWorktreeChatTarget target,
    String thinkingLevel,
  ) => _engine.sends.setChatThinkingLevel(target, thinkingLevel);

  /// Toggles Codex fast mode on a worktree chat. Rethrows on failure.
  Future<String> setChatFastMode(
    RemoteWorktreeChatTarget target,
    bool fastMode,
  ) => _engine.sends.setChatFastMode(target, fastMode);

  /// Interrupts the chat's active run. Rethrows on failure.
  Future<void> cancelChat(RemoteChatTarget target) =>
      _engine.sends.cancelChat(target);

  /// Stops live event delivery while the app is backgrounded.
  void onAppBackgrounded() => _engine.session.onAppBackgrounded();

  /// Catches up missed activity and restarts live event delivery when the
  /// app returns to the foreground.
  Future<void> onAppForegrounded() => _engine.session.onAppForegrounded();

  /// See [ChatSendCoordinator.isAwaitingAgentTurn].
  bool isAwaitingAgentTurn(RemoteChatTarget target) =>
      _engine.sends.isAwaitingAgentTurn(target);

  /// Notifications for [target]'s chat alone: its transcript, pending sends,
  /// awaiting-turn bridge, questions, summary row, and hydration. The caller
  /// owns the returned notifier and disposes it when the chat is unbound.
  RemoteChatChangeNotifier chatChangesFor(RemoteChatTarget? target) =>
      RemoteChatChangeNotifier(
        source: this,
        read: target == null || remoteChatKeyForTarget(target) == null
            ? null
            : () => _engine.chatRevision(target),
      );

  @override
  void dispose() {
    unawaited(fileDiffCache.flush());
    _engine.dispose();
    attachmentThumbnails.dispose();
    super.dispose();
  }
}
