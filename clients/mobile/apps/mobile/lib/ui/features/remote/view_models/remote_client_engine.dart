import 'dart:async';

import 'package:mobile/data/models/transcript_list.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/data/services/remote_control_api_service.dart'
    show RemotePortalCommandResult;
import 'package:mobile/services/attachment_archive_ledger.dart';
import 'package:mobile/data/models/turn_outcome.dart';

import 'app_advisor_controller.dart';
import 'background_process_patch.dart';
import 'watcher_patch.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_draft.dart';
import 'chat_send_coordinator.dart';
import 'chat_transcript_store.dart';
import 'composer_overrides_controller.dart';
import 'hydration_coordinator.dart';
import 'last_viewed_chat_tabs.dart';
import 'overview_refresh_scheduler.dart';
import 'owned_command_registry.dart';
import 'pipeline_chat_follow_up_coordinator.dart';
import 'pipeline_content_reader.dart';
import 'pipeline_dispatcher.dart';
import 'pipeline_run_tracker.dart';
import 'pending_chat_attachment_store.dart';
import 'pending_question_tracker.dart';
import 'pr_state_tracker.dart';
import 'project_clone_coordinator.dart';
import 'provider_usage_tracker.dart';
import 'read_receipt_tracker.dart';
import 'remote_chat_revision.dart';
import 'remote_chat_tabs_controller.dart';
import 'remote_control_state.dart';
import 'remote_session_controller.dart';
import 'remote_session_store.dart';
import 'remote_shell_reducer.dart' show backgroundProcessWorktrees;
import 'remote_unsent_sends.dart';
import 'worktree_archive_coordinator.dart';
import 'worktree_create_coordinator.dart';

/// The Flutter-independent Remote Control client: composes the collaborators
/// that own client state, routes portal events and reducer effects between
/// them, and orchestrates their reset and disposal.
///
/// Platform work reaches the engine through ports: [repository] for the
/// network, [archiveLedger], [transcriptCache], and the session-cache
/// callbacks for storage, and the clock, timer, and message-id factories for
/// scheduling and identity.
/// Every visible change is reported once through [onChanged]; the Flutter
/// facade adapts it to widget notifications.
final class RemoteClientEngine {
  RemoteClientEngine({
    required this.repository,
    required this.onChanged,
    required this.orderWorktrees,
    required this.archiveLedger,
    required this.restoreSessionCaches,
    required this.clearSessionCaches,
    this.flushSessionCaches,
    this.stateRefreshDebounce = kRemoteStateRefreshDebounce,
    this.hydrationRetryWindow = kRemoteHydrationRetryWindow,
    this.hydrationTimeout = kRemoteHydrationTimeout,
    this.worktreeCreateRecoveryInterval = kRemoteWorktreeCreateRecoveryInterval,
    this.worktreeCreateTimeout = kRemoteWorktreeCreateTimeout,
    this.archiveRestoreTimeout = kRemoteArchiveRestoreTimeout,
    DateTime Function()? clock,
    RemoteTimerFactory? timer,
    this.messageId,
    this.chatId,
    this.onSuccessfulTurn,
    this.unsentStore,
    this.transcriptCache,
  }) : _clock = clock ?? DateTime.now,
       _timer = timer ?? Timer.new;

  final RemoteControlRepository repository;
  final void Function(String turnKey)? onSuccessfulTurn;

  /// Called once per visible change, never after [dispose].
  final void Function() onChanged;

  /// Sorts worktrees into saved sidebar order; supplied by the host so
  /// locale-aware collation stays out of the engine.
  final RemoteWorktreeOrder orderWorktrees;
  final AttachmentArchiveLedger archiveLedger;

  /// Scopes session-keyed caches to a newly paired session id, or to none.
  final void Function(String? sessionId) restoreSessionCaches;

  /// Clears session-keyed caches when the paired session is discarded.
  final void Function() clearSessionCaches;

  /// Persists deferred interface-cache writes before the app backgrounds.
  final Future<void> Function()? flushSessionCaches;

  final Duration stateRefreshDebounce;
  final Duration hydrationRetryWindow;
  final Duration hydrationTimeout;
  final Duration worktreeCreateRecoveryInterval;
  final Duration worktreeCreateTimeout;
  final Duration archiveRestoreTimeout;
  final DateTime Function() _clock;
  final RemoteTimerFactory _timer;

  /// Mints optimistic send ids; see [ChatSendCoordinator.messageId].
  final RemoteMessageIdFactory? messageId;

  /// Mints client chat ids; see [ChatSendCoordinator.chatId].
  final RemoteChatIdFactory? chatId;

  /// Where unconfirmed text sends persist; in-memory when absent.
  final UnsentRecordPort? unsentStore;

  /// Recent chat tails persisted on this device, so a chat reopened after a
  /// cold start paints at once. Cleared with the paired session.
  final RemoteTranscriptCache? transcriptCache;

  bool _disposed = false;
  final List<void Function()> _changeWatchers = [];

  /// Whether [dispose] has run.
  bool get isDisposed => _disposed;

  // Collaborators own feature state. Every command this client submits is
  // claimed in [commands], and each feature reacts to its own commands'
  // terminal events through the handlers it registers there.
  late final commands = OwnedCommandRegistry(notify: _notify);
  late final RemoteSessionController session = RemoteSessionController(
    repository: repository,
    notify: _notify,
    isDisposed: () => _disposed,
    applySnapshot: _applySnapshot,
    onSnapshotApplied: (generation) {
      unawaited(archives.restorePendingArchiveCommands(generation));
      if (store.snapshot?.refreshing == false) {
        hydration.foregroundRequestCompleted();
      }
    },
    captureReadBaseline: store.captureReadBaseline,
    clearSnapshot: store.clearSnapshot,
    hasSnapshot: () => store.snapshot != null,
    resetSession: _resetSession,
    discardMissedEventState: _discardMissedEventState,
    restoreSessionCaches: (sessionId) {
      restoreSessionCaches(sessionId);
      return transcriptCache?.restoreSession(sessionId);
    },
    onEventBatch: _handleEventBatch,
    onBackgrounded: () {
      readReceipts.pauseRetries();
      hydration.pauseChatLoads();
      overviewRefresh.cancelArmed();
      projectClones.pauseStatusReads();
      worktreeCreates.pauseReconciliation();
      unawaited(transcriptCache?.flush());
      unawaited(flushSessionCaches?.call());
    },
    onForegrounded: () {
      sends.onAppForegrounded();
      readReceipts.resumeRetries();
      hydration.resumeChatLoads();
      projectClones.resumeStatusReads();
      worktreeCreates.resumeReconciliation();
    },
    onEventsStopped: () => overviewRefresh.cancelArmed(),
    onDeliveryRecovered: () {
      hydration.restartFailedChatLoads();
      prState.onDeliveryRecovered();
    },
    canRefreshOnForeground: () =>
        overviewRefresh.isVisible && !hydration.isChatHydrationPending,
    refresh: refresh,
    scheduleRefresh: () => overviewRefresh.schedule(),
    clock: _clock,
    timer: _timer,
  );
  late final RemoteSessionStore store = RemoteSessionStore(
    orderWorktrees: orderWorktrees,
    knownChatKeys: () => [
      ...transcripts.chatKeys,
      ...hydration.pendingChatTranscripts,
    ],
    isLocallyRead: (scope, chatId) => readReceipts.isLocallyRead(scope, chatId),
    hasLocalReads: () => readReceipts.hasReceipts,
  );
  late final ChatTranscriptStore transcripts = ChatTranscriptStore(
    notify: _notify,
    isConnected: () => session.isConnected,
    fetchHistory: repository.fetchChatHistory,
    onEvidence: (chat, message) {
      sends.clearAwaitingTurnOnEvidence(chat, message);
      unsent.confirmEcho(chat, message);
    },
    onTranscriptChanged: (chat) => transcriptCache?.markChanged(
      chat,
      () => transcripts.projectedRows(chat),
      authoritative: () => transcripts.hasAuthoritativeRows(chat),
    ),
  );
  late final RemoteUnsentSends unsent = RemoteUnsentSends(
    store: unsentStore ?? InMemoryChatDraftStore(),
  );
  late final attachments = PendingChatAttachmentStore(clock: _clock);
  late final questions = PendingQuestionTracker(
    repository: repository,
    notify: _notify,
    snapshot: () => store.snapshot,
    commands: commands,
  );
  late final prState = PrStateTracker(
    repository: repository,
    store: store,
    notify: _notify,
    isConnected: () => session.isConnected && !session.isDegraded,
    sessionGeneration: () => session.sessionGeneration,
    submit: (action) => commands.submit(action),
    awaitCommandResult: _awaitPrCommandResult,
    timer: _timer,
    clock: _clock,
  );
  late final archives = WorktreeArchiveCoordinator(
    repository: repository,
    attachmentCache: archiveLedger,
    notify: _notify,
    snapshot: () => store.snapshot,
    isConnected: () => session.isConnected,
    hasConnection: () => session.connection != null,
    sessionGeneration: () => session.sessionGeneration,
    loadGeneration: () => session.loadGeneration,
    commands: commands,
    refresh: refresh,
    archiveRestoreTimeout: archiveRestoreTimeout,
    clock: _clock,
  );
  late final HydrationCoordinator hydration = HydrationCoordinator(
    repository: repository,
    commands: commands,
    notify: _notify,
    isConnected: () => session.isConnected,
    isBackgrounded: () => session.isAppBackgrounded,
    snapshot: () => store.snapshot,
    chatSummariesFor: (worktree) => store.chatSummariesFor(
      workspaceLocalId: worktree.workspaceLocalId,
      worktreeLocalId: worktree.worktreeLocalId,
    ),
    hasTranscript: transcripts.hasTranscript,
    openPersistedTail: (chat) => transcriptCache?.readTail(chat) ?? const [],
    acceptsCachedTail: transcripts.acceptsCachedTail,
    seedCachedTail: (chat, rows, source) =>
        transcripts.seedFromCache(chat, rows, source: source),
    seedCurrentTail: (chat, rows) {
      if (!transcripts.acceptsCachedTail(chat, RemoteCachedTailSource.server)) {
        return false;
      }
      transcripts.replaceAuthoritative(chat, rows, truncated: true);
      return true;
    },
    onChatHydrationSettled: () => overviewRefresh.releaseDeferred(),
    onForegroundHydrated: () => appAdvisor.prefetch(),
    tabListMark: () => store.tabListMark,
    transcriptMark: () => transcripts.liveMark,
    retryWindow: hydrationRetryWindow,
    timeout: hydrationTimeout,
    clock: _clock,
    timer: _timer,
  );
  late final OverviewRefreshScheduler overviewRefresh =
      OverviewRefreshScheduler(
        isConnected: () => session.isConnected,
        isBackgrounded: () => session.isAppBackgrounded,
        isHydrationPending: () => hydration.isChatHydrationPending,
        needsOverviewRequest: () => _refreshNeedsOverviewRequest,
        onRefresh: (followUp) =>
            followUp == null ? refresh() : _refreshAfterSnapshot(followUp),
        debounce: stateRefreshDebounce,
        clock: _clock,
        timer: _timer,
      );
  late final ReadReceiptTracker readReceipts = ReadReceiptTracker(
    repository: repository,
    commands: commands,
    notify: _notify,
    isConnected: () => session.isConnected,
    isDisposed: () => _disposed,
    isBackgrounded: () => session.isAppBackgrounded,
    isDegraded: () => session.isDegraded,
    snapshot: () => store.snapshot,
    messagesFor: transcripts.messagesFor,
    reprojectOverview: _reprojectOverview,
    timer: _timer,
  );
  late final pipelineRuns = PipelineRunTracker(
    repository: repository,
    commands: commands,
    activityFor: hydration.worktreeActivityFor,
    isConnected: () => session.isConnected,
    notify: _notify,
    timer: _timer,
  );
  late final providerUsage = ProviderUsageTracker(
    usageCommands: repository.providerUsage,
    commands: commands,
    isConnected: () => session.isConnected,
    notify: _notify,
    timer: _timer,
  );
  late final appAdvisor = RemoteAppAdvisorController(
    advisorCommands: repository.appAdvisor,
    commands: commands,
    isConnected: () => session.isConnected,
    notify: _notify,
    clock: _clock,
    timer: _timer,
  );
  late final pipelineDispatch = PipelineDispatcher(
    repository: repository,
    commands: commands,
    isConnected: () => session.isConnected,
    notify: _notify,
    timer: _timer,
  );
  late final sends = ChatSendCoordinator(
    repository: repository,
    commands: commands,
    transcripts: transcripts,
    notify: _notify,
    isConnected: () => session.isConnected,
    isDisposed: () => _disposed,
    isBackgrounded: () => session.isAppBackgrounded,
    sessionGeneration: () => session.sessionGeneration,
    watchChanges: _watchChanges,
    onSendCompleted: attachments.removePendingChatAttachments,
    onSendFailed: attachments.markSendFailed,
    onTabCreateFailed: (target) {
      final chat = remoteChatKeyForTarget(target);
      if (chat != null) attachments.markChatCreateFailed(chat);
    },
    unsent: unsent,
    chatExists: (key) => store.rawChatSummary(key) != null,
    clock: _clock,
    timer: _timer,
    messageId: messageId,
    chatId: chatId,
  );
  late final pipelineFollowUps = PipelineChatFollowUpCoordinator(
    repository: repository,
    commands: commands,
    send: (target, text) => sends.sendChatMessage(target, text),
    ownerExists: (workspaceLocalId, worktreeLocalId) => store
        .worktreesFor(workspaceLocalId)
        .any((worktree) => worktree.localId == worktreeLocalId),
    isConnected: () => session.isConnected,
    sessionGeneration: () => session.sessionGeneration,
    notify: _notify,
  );
  late final pipelineContent = PipelineContentReader(
    repository: repository,
    commands: commands,
  );
  late final projectClones = ProjectCloneCoordinator(
    createProject: repository.projects.createProjectFromGitUrl,
    readStatus: repository.projects.commandStatus,
    commands: commands,
    notify: _notify,
    isConnected: () => session.isConnected,
    isBackgrounded: () => session.isAppBackgrounded,
    sessionGeneration: () => session.sessionGeneration,
    hasProject: (workspaceId) =>
        store.snapshot?.workspaces.any(
          (workspace) => workspace.localId == workspaceId,
        ) ??
        false,
    refreshProjects: _reprojectOverview,
    timer: _timer,
  );
  late final worktreeCreates = WorktreeCreateCoordinator(
    repository: repository,
    commands: commands,
    notify: _notify,
    isConnected: () => session.isConnected,
    isDisposed: () => _disposed,
    sessionGeneration: () => session.sessionGeneration,
    worktreesFor: store.worktreesFor,
    refreshSnapshot: () async =>
        (await session.refreshSnapshot()).outcome ==
        RemoteSnapshotRefreshOutcome.applied,
    recoveryInterval: worktreeCreateRecoveryInterval,
    timeout: worktreeCreateTimeout,
    clock: _clock,
    timer: _timer,
  );

  void _notify() {
    if (_disposed || session.deferPaint()) return;
    onChanged();
    for (final watcher in List.of(_changeWatchers)) {
      watcher();
    }
  }

  void Function() _watchChanges(void Function() onChange) {
    _changeWatchers.add(onChange);
    return () => _changeWatchers.remove(onChange);
  }

  /// Clears the command-failure banner.
  void clearCommandFailure() {
    if (commands.clearFailureMessage()) _notify();
  }

  /// The chat tab last shown in each worktree during this session.
  late final lastViewedChatTabs = LastViewedChatTabs(
    sessionGeneration: () => session.sessionGeneration,
  );

  // View-owned submissions also become obsolete when fresh recovery skips
  // their terminal events. Pairing changes and recoveries both advance this
  // generation; local choices and provisional tabs survive controller sync.
  int _viewRecoveryGeneration = 0;

  /// Optimistic tab membership and selection for one chat view, wired to
  /// this engine's tab commands, session, and chat-id minting. The view owns
  /// and disposes it.
  RemoteChatTabsController chatTabs({
    required void Function() onChanged,
    required void Function(String chatId) onCreateFailed,
    String? initialChatId,
  }) => RemoteChatTabsController(
    createTab: (target, {required onFailed}) =>
        sends.createChatTab(target, onFailed: (_) => onFailed()),
    closeTab: (target, {required onFailed}) =>
        sends.closeChatTab(target, onFailed: (_) => onFailed()),
    mintChatId: () => sends.mintChatId(RemoteChatScope.worktree),
    sessionGeneration: () =>
        session.sessionGeneration + _viewRecoveryGeneration,
    onChanged: onChanged,
    onCreateFailed: onCreateFailed,
    initialChatId: initialChatId,
  );

  /// Optimistic composer values for one chat view, wired to this engine's
  /// chat commands and composer projections. The view owns and disposes it.
  ComposerOverridesController composerOverrides({
    required void Function() onChanged,
  }) => ComposerOverridesController(
    submit: _submitComposerChange,
    sessionGeneration: () =>
        session.sessionGeneration + _viewRecoveryGeneration,
    projectionSequence: (target) {
      final key = remoteChatKeyForTarget(target);
      return key == null ? null : store.composerProjectionSequenceFor(key);
    },
    onChanged: onChanged,
  );

  Future<String> _submitComposerChange(
    RemoteChatTarget target,
    ComposerField<Object> field,
    Object value, {
    required void Function(int completedAt) onCompleted,
    required void Function() onFailed,
  }) {
    void failed(String _) => onFailed();
    return switch ((field, value, target)) {
      (ComposerField.model, final String model, _) => sends.setChatModel(
        target,
        model,
        onCompleted: onCompleted,
        onFailed: failed,
      ),
      (ComposerField.autoModel, true, final RemoteWorktreeChatTarget chat) =>
        sends.setChatAutoModel(
          chat,
          onCompleted: onCompleted,
          onFailed: failed,
        ),
      (
        ComposerField.planMode,
        final bool planMode,
        final RemoteWorktreeChatTarget chat,
      ) =>
        sends.setChatPlanMode(
          chat,
          planMode,
          onCompleted: onCompleted,
          onFailed: failed,
        ),
      (
        ComposerField.thinkingLevel,
        final String level,
        final RemoteWorktreeChatTarget chat,
      ) =>
        sends.setChatThinkingLevel(
          chat,
          level,
          onCompleted: onCompleted,
          onFailed: failed,
        ),
      (
        ComposerField.fastMode,
        final bool fastMode,
        final RemoteWorktreeChatTarget chat,
      ) =>
        sends.setChatFastMode(
          chat,
          fastMode,
          onCompleted: onCompleted,
          onFailed: failed,
        ),
      (
        ComposerField.pluginSelections,
        final Map<String, Object?> selections,
        final chat,
      ) =>
        sends.setChatPluginSelections(
          chat,
          selections,
          onCompleted: onCompleted,
          onFailed: failed,
        ),
      _ => Future.value(''),
    };
  }

  /// Retains an accepted attachment send's retry drafts, settling any
  /// outcome that raced ahead: a send or provisional chat the desktop
  /// already rejected restores at once.
  void retainPendingChatAttachments({
    required String commandId,
    required RemoteChatTarget target,
    required List<ChatAttachmentDraft> drafts,
    String? provisionalCreateCommandId,
    bool restoreImmediately = false,
  }) => attachments.retainPendingChatAttachments(
    commandId: commandId,
    sessionGeneration: session.sessionGeneration,
    target: target,
    drafts: drafts,
    provisionalCreateCommandId: provisionalCreateCommandId,
    restoreImmediately:
        restoreImmediately || commands.hasFailed(provisionalCreateCommandId),
    sendFailed: commands.hasFailed(commandId),
  );

  /// Whether a chat view showing [target] in [worktree] has retry drafts to
  /// restore now; see [PendingChatAttachmentStore.hasRestorable].
  bool hasRestorableChatAttachments({
    required RemoteChatTarget? target,
    RemoteWorktree? worktree,
  }) => attachments.hasRestorable(
    target: target,
    worktree: worktree == null ? null : remoteWorktreeKeyOf(worktree),
    sessionGeneration: session.sessionGeneration,
    canReupload: session.isConnected,
  );

  /// Removes and returns the retry drafts a chat view showing [target] in
  /// [worktree] restores now; see [PendingChatAttachmentStore.takeRestorable].
  List<PendingChatAttachmentBatch> takeRestorableChatAttachments({
    required RemoteChatTarget? target,
    RemoteWorktree? worktree,
  }) => attachments.takeRestorable(
    target: target,
    worktree: worktree == null ? null : remoteWorktreeKeyOf(worktree),
    sessionGeneration: session.sessionGeneration,
    canReupload: session.isConnected,
  );

  /// What [target]'s transcript view shows, as one comparable value; see
  /// [RemoteChatRevision]. Adapters compare it across changes so a view
  /// bound to one chat ignores every other chat and collaborator.
  RemoteChatRevision chatRevision(RemoteChatTarget target) {
    final key = remoteChatKeyForTarget(target);
    return (
      sessionGeneration: session.sessionGeneration,
      transcript: key == null ? 0 : transcripts.revisionFor(key),
      unsent: key == null ? 0 : unsent.revisionFor(key),
      awaitingTurn: sends.isAwaitingAgentTurn(target),
      questionResolutions: questions.resolutionGeneration,
      summary: key == null ? null : store.rawChatSummary(key),
      transcriptLoading: hydration.isChatTranscriptLoading(target),
      hydrationError: hydration.chatHydrationError(target),
    );
  }

  /// Host rows, then optimistic sends, then durable not-sent/uncertain rows
  /// that neither already shows.
  List<RemoteChatMessage> messagesFor(RemoteChatTarget target) {
    final rows = transcripts.messagesFor(target);
    final records = [
      for (final record in unsent.recordsFor(target))
        if (record.status != UnsentStatus.sending) record,
    ];
    if (records.isEmpty) return rows;
    final shown = {for (final row in rows) row.messageId};
    final extra = [
      for (final record in records)
        if (!shown.contains(record.userMessageId)) record.toMessage(),
    ];
    return extra.isEmpty ? rows : JoinedTranscript(rows, extra);
  }

  Future<Map<String, dynamic>> _awaitPrCommandResult(
    RemotePortalCommandResult response,
  ) async {
    final commandId = commands.register(
      response.commandId,
      throwIfFailed: true,
    );
    if (response.result case final result?) return result;
    if (commandId.isEmpty) {
      throw const RemoteControlException(
        'No PR command was acknowledged. Refresh to check its status.',
      );
    }
    if (commands.resultOf(commandId) case final result?) {
      return result;
    }
    try {
      final result = await commands.waitForResult(
        commandId,
        timeout: const Duration(minutes: 10),
      );
      if (result == null) {
        throw const RemoteControlException(
          'No PR result was returned. Refresh to check its status.',
        );
      }
      return result;
    } on TimeoutException {
      throw const RemoteControlException(
        'The PR action is still pending. Refresh to check its status before trying again.',
      );
    }
  }

  /// Asks the desktop to re-project its overview, then re-reads the
  /// snapshot. The desktop runs commands in order, so the projection follows
  /// a clone or a read that already finished. Returns whether the read
  /// landed after the server saw the projection complete.
  Future<bool> _reprojectOverview() async {
    var projected = false;
    try {
      projected = await repository.requestOverviewState();
    } catch (_) {
      // Best effort: the snapshot read below still runs.
    }
    if (_disposed) return false;
    return await refresh() && projected;
  }

  /// Re-fetches the session snapshot (pull-to-refresh). No-op unless
  /// currently connected. Uses the same load-generation guard as connect.
  Future<bool> refresh() async {
    final (pending: pendingRefresh, deltaOnly: pendingDeltaOnly) =
        overviewRefresh.takePending();
    // Captured before any await so a teardown racing the overview request is
    // visible to the session probe below, rather than relying on the session
    // reset incidentally clearing the desktop liveness.
    final generation = session.loadGeneration;
    final sessionAtStart = session.sessionGeneration;
    final needsOverview = _refreshNeedsOverviewRequest;
    await worktreeCreates.recoverPendingCreate();
    if (!session.isSessionCurrent(sessionAtStart)) {
      return false;
    }
    if (needsOverview) {
      try {
        await repository.requestOverviewState();
      } catch (error) {
        if (isRemoteSessionUnavailableError(error) &&
            session.isDegraded &&
            await session.isRemoteSessionGone(generation)) {
          session.handleRemoteSessionUnavailable();
          return false;
        }
        // Still refresh the visible session from its cache.
      }
    }
    final result = await session.refreshSnapshot();
    final stillCurrent =
        pendingRefresh &&
        result.generation == session.loadGeneration &&
        session.isConnected;
    _recordStateRefreshResult(result, countFailure: stillCurrent);
    if (result.outcome == RemoteSnapshotRefreshOutcome.failed && stillCurrent) {
      overviewRefresh.schedule(fromDelta: pendingDeltaOnly);
    }
    return result.outcome == RemoteSnapshotRefreshOutcome.applied;
  }

  void _recordStateRefreshResult(
    RemoteSnapshotRefreshResult result, {
    bool countFailure = false,
  }) {
    if (result.outcome == RemoteSnapshotRefreshOutcome.applied) {
      overviewRefresh.recordSuccess();
    } else if (result.outcome == RemoteSnapshotRefreshOutcome.failed &&
        countFailure) {
      overviewRefresh.recordFailure();
    }
  }

  /// Whether [refresh] must first wait for a desktop overview projection
  /// rather than read the server cache as-is.
  bool get _refreshNeedsOverviewRequest =>
      session.isDegraded || worktreeCreates.unidentifiedAttempt != null;

  /// Re-reads the overview after worktree snapshots signalled that the
  /// server cache is ready, for chat-tab placeholders the snapshots left
  /// empty. Returns whether the overview read landed.
  Future<bool> _refreshAfterSnapshot(OverviewFollowUp followUp) async {
    final sessionAtStart = session.sessionGeneration;
    final result = await session.settledSnapshotRefresh(sessionAtStart);
    if (session.isSessionCurrent(sessionAtStart) &&
        result.generation == session.loadGeneration) {
      _recordStateRefreshResult(result, countFailure: followUp.countFailure);
    }
    if (result.outcome != RemoteSnapshotRefreshOutcome.applied ||
        !session.isSessionCurrent(sessionAtStart)) {
      return false;
    }
    await _readActivityAfterSnapshot(
      followUp.resolvedWorktrees,
      followUp.hydratedWorktrees,
    );
    return true;
  }

  /// Reads the activity slices of the [hydrated] worktrees, whose projection
  /// landed. The overview scope excludes changed files and the other
  /// worktree-only slices, so only this scoped read refreshes them. Then the
  /// [resolved] worktrees stop loading: clearing after the read lets the
  /// chat-tab list flip straight from "loading" to its tabs instead of
  /// flashing "no chats yet".
  Future<void> _readActivityAfterSnapshot(
    Set<RemoteWorktreeKey> resolved,
    Set<RemoteWorktreeKey> hydrated,
  ) async {
    final sessionAtStart = session.sessionGeneration;
    await Future.wait([
      for (final target in hydrated)
        hydration.refreshWorktreeActivity(
          workspaceLocalId: target.workspaceLocalId,
          worktreeLocalId: target.worktreeLocalId,
        ),
    ]);
    if (!session.isSessionCurrent(sessionAtStart)) return;
    hydration.resolveWorktrees(resolved, hydrated);
    _notify();
  }

  void _applySnapshot(
    RemoteSessionSnapshot snapshot, {
    RemoteSnapshotReadBaseline? baseline,
  }) {
    _routeSessionEffects(
      store.applySnapshot(snapshot, baseline: baseline),
      transcriptCursor: snapshot.eventCursor,
    );
    if (snapshot.providerUsage case final usage?) {
      providerUsage.apply(usage, cursor: snapshot.eventCursor);
    }
    archives.pruneCompletedArchives();
    worktreeCreates.reconcileSnapshot();
    projectClones.reconcile();
  }

  /// One portal event batch: the session's liveness first, then each event
  /// through the session reducer or the command registry, with every
  /// reducer step's effects routed before the next event applies.
  void _handleEventBatch(RemotePortalEventBatch batch) {
    if (!session.isConnected) return;
    store.beginEventBatch(batch.nextCursor);
    try {
      _applyEventBatch(batch);
    } finally {
      store.endEventBatch();
    }
  }

  void _applyEventBatch(RemotePortalEventBatch batch) {
    session.beginEventBatch(batch);
    final resolvedWorktreeKeys = <RemoteWorktreeKey>{};
    final hydratedWorktreeTargets = <RemoteWorktreeKey>{};

    final connectionStatus = batch.connectionStatus;
    if (connectionStatus == RemotePortalConnectionStatus.ended) {
      session.handleRemoteSessionEnded();
      return;
    }
    var changed = session.adoptPortalConnectionStatus(connectionStatus);

    hydration.tailFreshness.observe(batch);
    for (final event in batch.events) {
      switch (event) {
        case RemoteChatMessageEvent(
          :final chatId,
          :final scope,
          :final message,
        ):
          final key = store.chatKeyIn(
            store.snapshot,
            chatId,
            scope ?? message.scope,
          );
          final previous =
              key != null &&
                  onSuccessfulTurn != null &&
                  hasCleanlyCompletedTurnTimer(message)
              ? transcripts
                    .projectedRows(key)
                    .where((row) => row.messageId == message.messageId)
                    .firstOrNull
              : null;
          changed =
              _routeSessionEffects(
                store.applyChatMessage(event),
                transcriptCursor: event.cursor,
                transcriptBatchCursor: batch.nextCursor,
              ) ||
              changed;
          if (key != null && previous != null) {
            _reportSuccessfulTurn(key, previous, message.messageId);
          }
        case RemoteStateSnapshotEvent():
          if (event.providerUsage case final usage?) {
            changed =
                providerUsage.apply(
                  usage,
                  cursor: event.cursor ?? batch.nextCursor,
                ) ||
                changed;
          }
          // A repeated delivery of a worktree projection shares the read
          // that its first delivery started.
          final repeated = switch (event) {
            RemoteStateSnapshotEvent(
              scope: 'worktree',
              targetWorkspaceLocalId: final workspaceLocalId?,
              targetWorktreeLocalId: final worktreeLocalId?,
            ) =>
              hydration.repeatsProjection(
                remoteWorktreeKey(workspaceLocalId, worktreeLocalId),
                event.eventId,
              ),
            _ => false,
          };
          changed =
              _routeSessionEffects(
                store.applySnapshotEvent(
                  event,
                  tabListBaseline: _tabListBaselineFor(event),
                ),
                snapshotCommandId: event.commandId,
                transcriptCursor: event.cursor,
                transcriptBatchCursor: batch.nextCursor,
                snapshotBaseline: _transcriptBaselineFor(event),
                resolvedWorktreeKeys: repeated ? null : resolvedWorktreeKeys,
                hydratedWorktreeTargets: repeated
                    ? null
                    : hydratedWorktreeTargets,
              ) ||
              changed;
          if (event.scope == 'overview') hydration.foregroundRequestCompleted();
          // The desktop projected one worktree's pipelines into the cache.
          if (event case RemoteStateSnapshotEvent(
            scope: 'pipelines',
            targetWorkspaceLocalId: final workspaceLocalId?,
            targetWorktreeLocalId: final worktreeLocalId?,
          )) {
            hydration.resolvePipelineRuns(
              workspaceLocalId: workspaceLocalId,
              worktreeLocalId: worktreeLocalId,
            );
          }
        case RemoteStateDeltaEvent():
          if (event.providerUsage case final usage?) {
            changed =
                providerUsage.apply(
                  usage,
                  cursor: event.cursor ?? batch.nextCursor,
                ) ||
                changed;
          }
          changed = _routeSessionEffects(store.applyDelta(event)) || changed;
          // Worktree slices carry no cursor, so these apply in stream order.
          for (final worktree in backgroundProcessWorktrees(event.shell)) {
            changed =
                hydration.applySlicePatch(
                  worktree,
                  (slices) =>
                      withBackgroundProcessDelta(slices, worktree, event.shell),
                ) ||
                changed;
          }
          if (event.shell.changesWatchers) {
            for (final worktree in watcherWorktrees(event.shell, [
              ...hydration.watcherSlices.worktrees,
              for (final row in store.snapshot?.worktrees ?? <RemoteWorktree>[])
                remoteWorktreeKey(row.workspaceLocalId, row.localId),
            ])) {
              changed =
                  hydration.applySlicePatch(
                    worktree,
                    (slices) => withWatcherDelta(slices, worktree, event.shell),
                  ) ||
                  changed;
            }
          }
        case RemoteSessionEndedEvent():
          session.handleRemoteSessionEnded();
          return;
        case RemoteCommandCompletedEvent(:final commandId, :final result):
          if (commandId != null) {
            changed =
                commands.handleCompleted(
                  commandId,
                  result,
                  projectionSequence: store.composerProjectionSequence,
                ) ||
                changed;
          }
        case RemoteCommandFailedEvent(:final message, :final commandId):
          if (commandId != null) {
            changed =
                commands.handleFailed(
                  commandId,
                  message,
                  projectionSequence: store.composerProjectionSequence,
                ) ||
                changed;
          }
        case RemotePipelineRunEvent(:final run, :final commandId):
          pipelineRuns.applyPipelineRun(run);
          pipelineRuns.settlePipelineRequest(run.localId);
          pipelineDispatch.observeRunStarted(
            commandId: commandId,
            executionId: run.localId,
          );
          changed = true;
        case RemotePipelineRunRemovedEvent(:final localId):
          changed = pipelineRuns.removePipelineRun(localId) || changed;
        case RemoteAppAdvisorMessageEvent():
          changed = appAdvisor.applyMessage(event) || changed;
        case RemoteAppAdvisorSnapshotEvent():
          changed = appAdvisor.applySnapshot(event) || changed;
        case RemoteAppAdvisorDeltaEvent():
          changed = appAdvisor.applyDelta(event) || changed;
        case RemoteHookDescriptorEvent():
          changed = hydration.applyHookDescriptor(event) || changed;
        case RemoteUnknownPortalEvent():
          break;
      }
    }

    archives.pruneCompletedArchives();
    // Snapshot events and deltas can list a cloned project or the created
    // worktree.
    projectClones.reconcile();
    worktreeCreates.reconcileSnapshot();
    if (changed) _notify();
    session.endEventBatch(batch);
    if (resolvedWorktreeKeys.isNotEmpty) {
      // Worktree-scoped snapshots signal that the server cache is ready and
      // carry the worktree's chat tabs, so only its activity slices need a
      // read. A tab placeholder they left empty waits for one overview read.
      // Chat/overview snapshots already carry their useful payload and must
      // not trigger an overview read that produces another snapshot in a
      // perpetual loop.
      hydration.markWorktreesProjected(hydratedWorktreeTargets);
      final needTabs = {
        for (final worktree in resolvedWorktreeKeys)
          if (hydration.needsTabListRead(worktree)) worktree,
      };
      if (needTabs.isNotEmpty) {
        overviewRefresh.deferWorktreeFollowUp(
          needTabs,
          hydratedWorktreeTargets.intersection(needTabs),
        );
      }
      if (needTabs.length < resolvedWorktreeKeys.length) {
        unawaited(
          _readActivityAfterSnapshot(
            resolvedWorktreeKeys.difference(needTabs),
            hydratedWorktreeTargets.difference(needTabs),
          ),
        );
      }
    }
  }

  int? _transcriptBaselineFor(RemoteStateSnapshotEvent event) {
    final chatId = event.targetChatId;
    if (chatId == null) return null;
    final chat = store.chatKeyForIncoming(chatId, event.targetChatScope);
    if (chat == null) return null;
    final workspace = event.targetWorkspaceLocalId;
    final worktree = event.targetWorktreeLocalId;
    return hydration.transcriptBaselineFor(
      chat,
      worktree: workspace == null || worktree == null
          ? null
          : remoteWorktreeKey(workspace, worktree),
      commandId: event.commandId,
    );
  }

  int? _tabListBaselineFor(RemoteStateSnapshotEvent event) {
    final workspaceLocalId = event.targetWorkspaceLocalId;
    final worktreeLocalId = event.targetWorktreeLocalId;
    if (workspaceLocalId == null || worktreeLocalId == null) return null;
    return hydration.tabListBaselineFor(
      remoteWorktreeKey(workspaceLocalId, worktreeLocalId),
    );
  }

  void _reportSuccessfulTurn(
    RemoteChatKey key,
    RemoteChatMessage previous,
    String messageId,
  ) {
    if (!hasRunningTurnTimer(previous)) return;
    final transcript = transcripts.projectedRows(key);
    final stored = transcript
        .where((row) => row.messageId == messageId)
        .firstOrNull;
    if (stored == null || !hasCleanlyCompletedTurnTimer(stored)) return;
    if (commands.failureMessage != null || session.isDegraded) return;
    if (!latestTurnSucceeded(transcript)) return;
    onSuccessfulTurn?.call('remote:${key.chatId}:$messageId');
  }

  /// Routes a session reducer step's effects to the collaborators they
  /// concern, right after the step, so they apply in event order. Worktree
  /// resolutions accumulate into the batch's sets. Returns whether anything
  /// visible changed.
  bool _routeSessionEffects(
    RemoteSessionEffects effects, {
    String? snapshotCommandId,
    int? snapshotBaseline,
    int? transcriptCursor,
    int? transcriptBatchCursor,
    Set<RemoteWorktreeKey>? resolvedWorktreeKeys,
    Set<RemoteWorktreeKey>? hydratedWorktreeTargets,
  }) {
    var changed = effects.changed;
    if (effects.summariesIndexHydrated) {
      changed = hydration.resolveChatSummariesIndex() || changed;
    }
    if (effects.readsPrunedAgainst case final snapshot?) {
      readReceipts.pruneRemoved(snapshot);
    }
    for (final (:chat, :unread) in effects.unreadProjections) {
      readReceipts.reconcileProjection(chat, unread);
    }
    final unsequencedChats = <RemoteChatKey>{};
    for (final incoming in effects.transcriptUpdates) {
      final update = hydration.tailFreshness.afterCache(
        incoming,
        resolveChat: store.chatKeyIn,
        cursor: transcriptCursor,
        batchCursor: transcriptBatchCursor,
        onUnsequencedLive: unsequencedChats.add,
      );
      if (update == null) continue;
      final applied = transcripts.applyUpdate(
        update,
        resolveChat: store.chatKeyIn,
        snapshotBaseline: snapshotBaseline,
      );
      changed = applied || changed;
      // A live row shows the chat loads again, so its failure clears.
      if (update case LiveChatMessageUpdate(
        :final chatId,
        :final scope,
        :final message,
        :final keySnapshot,
      ) when applied) {
        if (store.chatKeyIn(keySnapshot, chatId, scope ?? message.scope)
            case final chat?) {
          changed = hydration.clearChatHydrationError(chat) || changed;
        }
      }
    }
    for (final chat in unsequencedChats) {
      hydration.reconcileUnsequencedTail(chat);
    }
    if (effects.chatHydrated case final chat?) {
      hydration.resolveChatTranscript(chat, commandId: snapshotCommandId);
    }
    if (effects.foregroundHydrated case final worktree?) {
      hydration.resolveForegroundChat(
        worktree,
        chat: effects.chatHydrated,
        commandId: snapshotCommandId,
      );
    }
    resolvedWorktreeKeys?.addAll(effects.resolvedWorktreeKeys);
    if (effects.resolvesPendingWorktrees) {
      resolvedWorktreeKeys?.addAll(hydration.pendingWorktrees);
    }
    hydratedWorktreeTargets?.addAll(effects.hydratedWorktreeTargets);
    if (effects.worktreeSetupFailure case (:final worktree, :final error)?) {
      worktreeCreates.recordSetupFailure(worktree, error);
    }
    changed = prState.applyPrProgress(effects.prProgress) || changed;
    prState.onSessionChanged();
    if (effects.overviewRefresh case final request?) {
      overviewRefresh.schedule(
        fromDelta: request == RemoteOverviewRefreshRequest.deltaRequested,
      );
    }
    return changed;
  }

  /// Discards every collaborator's state for the paired session. Runs after
  /// [session] advanced its session generation, so work bound to the old
  /// pairing sees itself as stale.
  void _resetSession() {
    sends.reset();
    // Sends the discarded session accepted but never echoed (or that are
    // still in flight) lose their optimistic rows below; keep them visible.
    unsent.demoteSending();
    overviewRefresh.reset();
    clearSessionCaches();
    unawaited(transcriptCache?.clearSession());
    readReceipts.reset();
    store.reset();
    transcripts.reset();
    // Hydration and worktree activity slices describe one desktop session's
    // projections; worktree local ids are stable per desktop, so carrying
    // them across a re-pair would merge stale changed files/plans over the
    // fresh snapshot.
    hydration.reset();
    commands.reset();
    attachments.reset();
    questions.reset();
    archives.reset();
    prState.reset();
    pipelineRuns.reset();
    pipelineDispatch.reset();
    pipelineFollowUps.reset();
    providerUsage.reset();
    appAdvisor.reset();
    worktreeCreates.reset();
    projectClones.reset();
  }

  /// Drops what the events a fresh resume skipped would have updated, as a
  /// relaunch does: transcripts, hydrations and the activity they loaded,
  /// and the waits those events would have settled. Open views reload from
  /// fresh reads; the persisted chat tails paint first. The pairing, its
  /// caches, and unsent sends survive.
  void _discardMissedEventState() {
    _viewRecoveryGeneration++;
    sends.reset();
    // Optimistic rows go with the transcripts; keep unconfirmed sends visible.
    unsent.demoteSending();
    transcripts.reset();
    hydration.reloadAfterSkippedEvents();
    prState.reloadAfterSkippedEvents();
    appAdvisor.reloadAfterSkippedEvents();
    pipelineRuns.reloadAfterSkippedEvents();
    pipelineDispatch.reloadAfterSkippedEvents();
    worktreeCreates.reconcileAfterSkippedEvents();
    // The recovered snapshot owns which questions still await an answer.
    questions.reset();
    commands.invalidateAfterSkippedEvents();
  }

  /// Invalidates in-flight work, stops live delivery, and releases every
  /// collaborator. No change is reported afterwards. The paired session's
  /// persisted transcripts are kept for the next launch.
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    unawaited(transcriptCache?.flush());
    sends.dispose();
    readReceipts.dispose();
    session.dispose();
    hydration.dispose();
    overviewRefresh.dispose();
    transcripts.dispose();
    commands.dispose();
    attachments.dispose();
    questions.dispose();
    prState.dispose();
    pipelineRuns.dispose();
    pipelineDispatch.dispose();
    pipelineFollowUps.dispose();
    providerUsage.dispose();
    appAdvisor.dispose();
    archives.dispose();
    worktreeCreates.dispose();
    projectClones.dispose();
    _changeWatchers.clear();
  }
}
