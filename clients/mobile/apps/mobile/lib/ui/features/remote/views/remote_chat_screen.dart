import 'package:mobile/ui/core/chat/widgets/chat_provisioning.dart';
import 'package:mobile/ui/core/chat/widgets/queued_messages_status.dart';
import 'dart:async';
import 'dart:developer' show Timeline;

import 'package:mobile/ui/features/remote/view_models/remote_draft_first_send.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/overlay-action/canopy_overlay_action.dart';

import 'package:flutter/material.dart';
import 'package:mobile/ui/core/navigation/app_route_scope.dart';
import 'package:mobile/ui/features/remote/view_models/pipeline_run_chat_activity_controller.dart';
import 'package:mobile/ui/features/remote/views/widgets/pipeline_run_agent_activity.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/chat_turn_liveness.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/services/active_chat_tracker.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/services/platform_attachment_picker.dart';
import 'package:mobile/services/satisfaction/satisfaction_policy.dart';
import 'package:mobile/services/speech_recognizer.dart';
import 'package:mobile/services/speech_to_text_recognizer.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_chat_attachment_uploader.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_response_fork.dart';
import 'package:mobile/ui/features/remote/view_models/remote_chat_draft_coordinator.dart';
import 'package:mobile/ui/features/remote/view_models/remote_composer_command_source.dart';
import 'package:mobile/ui/features/remote/view_models/remote_composer_chat_resolver.dart';
import 'package:mobile/ui/features/remote/view_models/remote_composer_plugins_source.dart';
import 'package:mobile/ui/features/remote/view_models/provisional_standalone_chat_creator.dart';
import 'package:mobile/ui/features/remote/view_models/provisional_worktree_chat_creator.dart';
import 'package:mobile/ui/features/remote/view_models/picker_copy_recorder.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';
import 'package:mobile/ui/features/remote/view_models/shown_chat_reopener.dart';
import 'package:mobile/ui/core/chat/view_models/composer_draft_binding.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_control.dart';
import 'package:mobile/ui/features/remote/view_models/remote_composer_effort.dart';
import 'package:mobile/ui/core/chat/view_models/voice_dictation_controller.dart';
import 'package:mobile/ui/features/remote/views/widgets/activity_sidebar.dart';
import 'package:mobile/ui/features/satisfaction/views/satisfaction_prompt_host.dart';
import 'package:mobile/ui/features/remote/views/widgets/chat_tabs_sheet.dart';
import 'package:mobile/ui/features/remote/views/widgets/remote_background_tray.dart';
import 'package:mobile/ui/features/remote/views/widgets/chat_watchers_chip.dart';
import 'package:mobile/ui/features/remote/views/widgets/command_failure_banner.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';
import 'package:mobile/ui/core/chat/widgets/attachment_thumbnail_scope.dart';
import 'package:mobile/ui/core/chat/widgets/chat_body.dart';
import 'package:mobile/ui/core/chat/widgets/chat_feed.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/chat/widgets/chat_location_subtitle.dart';
import 'package:mobile/ui/core/chat/widgets/attachment_strip.dart';
import 'package:mobile/ui/core/chat/widgets/chat_attachment_input.dart';
import 'package:mobile/ui/core/chat/widgets/pending_question_card.dart';
import 'package:mobile/ui/features/remote/views/widgets/remote_degraded_banner.dart';
import 'package:mobile/ui/features/remote/views/widgets/standalone_workspace_panel.dart';
import 'package:mobile/ui/features/remote/views/widgets/transcript_hydration_banner.dart';
import 'package:mobile/ui/core/chat/widgets/voice_dictation_dialog.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';

/// Shown on the disabled attach control of a Cowork chat when the paired
/// desktop announces `chat_attachments` but not `standalone_chat_create`.
/// Matches the web composer's copy for the same desktop.
const String kStandaloneAttachmentsNeedDesktopUpdate =
    'Update the desktop app and reconnect to attach files. '
    'Text messages still work.';

/// Shown on the disabled attach control while staged files wait for the
/// paired desktop to announce `chat_attachments` again.
const String kAttachmentsNeedReconnect =
    'Reconnect to the desktop to attach more files.';

/// Live chat view for one desktop chat thread: transcript, composer, and (for
/// worktree chats) the desktop's chat-tab list as horizontal chips.
///
/// Reads the ambient [RemoteControlViewModel] (handed down via
/// `ChangeNotifierProvider.value` at the push site).  Transcript hydration and
/// live updates flow through the view model: opening the screen fires
/// worktree/chat state requests (deduped per pairing) and the transcript
/// re-renders as chat events land.
class RemoteChatScreen extends StatefulWidget {
  /// Chat surface for a worktree's chat tabs.
  const RemoteChatScreen.worktree({
    super.key,
    required RemoteWorktree this.worktree,
    this.initialChatId,
    this.speechRecognizer,
    this.attachmentPicker,
    this.isActive = true,
  }) : standaloneChat = null,
       workspace = null,
       firstSend = null,
       baseWorktreeId = null;

  /// Chat surface for a standalone (cowork) chat. No `initialChatId` — a
  /// standalone screen always shows `standaloneChat.localId`, so the field
  /// would be silently ignored.
  const RemoteChatScreen.standalone({
    super.key,
    required RemoteStandaloneChat this.standaloneChat,
    this.speechRecognizer,
    this.attachmentPicker,
    this.isActive = true,
  }) : worktree = null,
       workspace = null,
       initialChatId = null,
       firstSend = null,
       baseWorktreeId = null;

  /// Chat surface for a chat that does not exist yet in [workspace]. Tree
  /// workspaces start creating their worktree as soon as the screen mounts
  /// and hold the send action until it is ready; flat workspaces mint a
  /// standalone chat with the first message. The created worktree or chat
  /// binds in place — there is no route handoff, so the chrome and the draft
  /// never jump.
  ///
  /// [firstSend] coordinates a draft composed before this screen opened.
  /// A tree workspace's worktree branches from
  /// [baseWorktreeId] when it is set, like web's "Branch from".
  const RemoteChatScreen.create({
    super.key,
    required RemoteWorkspace this.workspace,
    this.speechRecognizer,
    this.attachmentPicker,
    this.isActive = true,
    this.firstSend,
    this.baseWorktreeId,
  }) : worktree = null,
       standaloneChat = null,
       initialChatId = null;

  final RemoteWorktree? worktree;
  final RemoteStandaloneChat? standaloneChat;

  /// Workspace whose new chat this screen creates; set only by
  /// [RemoteChatScreen.create].
  final RemoteWorkspace? workspace;

  /// Chat id to preselect on first build, e.g. when the screen is pushed from
  /// a push-notification deep link that targets a specific chat. Validated
  /// against projected summaries by [RemoteChatTabsController], so a stale or unknown
  /// id falls back gracefully instead of leaving the screen stuck. Only
  /// settable via [RemoteChatScreen.worktree] — [RemoteChatScreen.standalone]
  /// always binds to `standaloneChat.localId`.
  final String? initialChatId;

  /// Coordinates a draft's first send and retains its selections for retry.
  final RemoteDraftFirstSend? firstSend;

  /// The worktree a created worktree branches from; null starts a new one
  /// from the workspace's default branch.
  final String? baseWorktreeId;

  /// Speech engine behind the composer mic. Null uses the `speech_to_text`
  /// plugin; tests inject a scripted recognizer.
  final SpeechRecognizer? speechRecognizer;

  /// File picking behind the composer's attach control. Null uses
  /// [PlatformAttachmentPicker]; tests inject a scripted picker so no
  /// platform channel is involved. Consulted when the paired desktop
  /// announces `chat_attachments`.
  final AttachmentPicker? attachmentPicker;

  /// Whether this screen is the visible home-shell destination. Pushed chat
  /// routes stay active by default and rely on their route being current;
  /// the home shell keeps its chat mounted behind other tabs and clears this
  /// while one of them is shown, so the hidden chat marks nothing read,
  /// claims no active chat, and stops refreshing its PR state.
  final bool isActive;

  @override
  State<RemoteChatScreen> createState() => _RemoteChatScreenState();
}

class _RemoteChatScreenState extends State<RemoteChatScreen>
    with WidgetsBindingObserver, RouteAware {
  late final RemoteControlViewModel _viewModel;

  /// Optimistic tab membership and selection; see [RemoteChatTabsController].
  late final RemoteChatTabsController _tabs;

  /// Optimistic composer values; see [ComposerOverridesController].
  late final ComposerOverridesController _composerOverrides;

  /// The chat a composer action applies to; see [RemoteComposerChatResolver].
  late final RemoteComposerChatResolver _composerChat;

  /// This view's PR-state poll, once it shows a worktree.
  PrStatePoll? _prPoll;

  String? _renderedReadChatId;
  final TextEditingController _composer = TextEditingController();
  late final ChatDraftStore _draftStore;
  late final ComposerDraftBinding _drafts;
  late final RemoteChatDraftCoordinator _draftCoordinator;
  late final ProvisionalStandaloneChatCreator _standaloneChatCreator;
  late final ProvisionalWorktreeChatCreator _worktreeChatCreator;
  late final PickerCopyRecorder _pickerCopies;
  late final VoiceDictationController _voice;
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();

  /// The session this screen was opened in; see [_recordViewedChat].
  late final int _openedSessionGeneration;

  /// Notifies when the bound chat changes; see [_bindChatChanges].
  RemoteChatChangeNotifier? _chatChanges;
  ({RemoteChatKey? chat, int sessionGeneration})? _chatChangesKey;

  /// Reopens the bound chat each time this screen shows it.
  late final _reopener = ShownChatReopener(
    reopen: (target) {
      if (mounted) _viewModel.reopenChatTranscript(target);
    },
    afterFrame: (callback) =>
        WidgetsBinding.instance.addPostFrameCallback((_) => callback()),
  );

  /// Turn keys whose intermediate steps the user expanded. Steps collapse by
  /// default so an agent turn reads as prompt → steps row → answer instead of
  /// a wall of tool/thinking bubbles.
  final Set<String> _expandedTurns = {};
  bool _sending = false;

  /// True while a send carrying attachments awaits its response; retained
  /// drafts are restored only after it settles its own batch.
  bool _attachmentSendInFlight = false;
  bool _attachmentRestoreScheduled = false;
  bool _routeIsCurrent = true;
  bool _paneIsCurrent = true;
  RouteObserver<ModalRoute<Object?>>? _routeObserver;

  // ---- In-place creation ([RemoteChatScreen.create]) ----

  /// Identity of this screen's non-idempotent worktree create. Retry reuses
  /// it so the view model can only reconcile the accepted create, never queue
  /// a duplicate.
  final RemoteWorktreeCreateAttempt _createAttempt =
      RemoteWorktreeCreateAttempt();

  /// The worktree this screen created, once the desktop reports it ready.
  RemoteWorktree? _createdWorktree;

  /// The pairing that reported [_createdWorktree].
  int? _createdWorktreeGeneration;
  bool _creatingWorktree = false;
  String? _createError;

  /// The worktree create in flight, shared by Retry and attachment uploads.
  Future<void>? _worktreeCreation;

  /// Client-minted id for a flat workspace's first chat. The `cc-` prefix
  /// distinguishes it from the `chat-m` ids minted for worktree tabs.
  String? _provisionalStandaloneChatId;

  RemoteWorktree? get _worktree => _createdWorktree ?? widget.worktree;

  /// The worktree chats' Agent activity panels (CAN-3619).
  final _agentActivity = PipelineRunChatActivityHost();

  /// The bound chat's Agent activity panels; see [_bindChat].
  PipelineRunChatActivityController? _activity;

  /// True while a tree workspace's worktree is still being created: the
  /// composer accepts a draft but holds the send action, because the
  /// desktop cannot run a turn in a checkout that does not exist yet.
  bool get _worktreeProvisioning =>
      _createsWorktree && _createdWorktree == null;

  /// Whether this screen creates a tree workspace's worktree.
  bool get _createsWorktree =>
      widget.workspace != null &&
      widget.workspace?.resolvedLayout != RemoteWorkspaceLayout.flat;

  /// The standalone chat this screen is bound to: the one it opened with, or
  /// the flat workspace's provisional first chat.
  RemoteStandaloneChat? get _standaloneChat {
    final chat = widget.standaloneChat;
    if (chat != null) return chat;
    final chatId = _provisionalStandaloneChatId;
    final workspace = widget.workspace;
    if (chatId == null || workspace == null) return null;
    return RemoteStandaloneChat(
      localId: chatId,
      projectLocalId: workspace.localId,
      title: 'New chat',
    );
  }

  /// The tracker (when a host provides one) is told which chat this screen
  /// currently shows.
  ActiveChatTracker? _activeChatTracker;
  final Object _activeChatOwner = Object();
  ModalRoute<Object?>? _observedRoute;

  /// Staged uploads for the next message. Null when the surface cannot carry
  /// attachments because its paired desktop does not announce
  /// `chat_attachments` — and the composer then renders no attach
  /// control at all rather than a control that would fail on use. Files
  /// staged before the capability went away stay, with adding disabled.
  ChatAttachmentController? _attachments;

  /// The session [_attachments]' uploads belong to.
  int? _attachmentsSessionGeneration;

  @override
  void initState() {
    super.initState();
    _voice = VoiceDictationController(
      draft: _composer,
      recognizer: widget.speechRecognizer ?? SpeechToTextRecognizer(),
    )..addListener(_onVoiceChanged);
    WidgetsBinding.instance.addObserver(this);
    _draftStore = maybeChatDraftStore(context) ?? InMemoryChatDraftStore();
    _drafts = ComposerDraftBinding(controller: _composer, store: _draftStore);
    _draftCoordinator = RemoteChatDraftCoordinator(
      store: _draftStore,
      binding: _drafts,
      composerText: () => _composer.text,
    );
    final viewModel = _viewModel = context.read<RemoteControlViewModel>();
    _openedSessionGeneration = viewModel.sessionGeneration;
    final worktree = widget.worktree;
    // An exact chat link wins; otherwise the worktree reopens on the tab the
    // user last viewed in it.
    final initialChatId =
        widget.initialChatId ??
        (worktree == null ? null : viewModel.lastViewedChatId(worktree));
    _drafts.bind(_draftTargetFor(initialChatId));
    _tabs = viewModel.chatTabs(
      initialChatId: initialChatId,
      onChanged: _onControllerChanged,
      onCreateFailed: _preserveFailedTabDraft,
    );
    _composerOverrides = viewModel.composerOverrides(
      onChanged: _onControllerChanged,
    );
    _composerChat = RemoteComposerChatResolver(
      tabs: _tabs,
      overrides: _composerOverrides,
      shownChatId: () => _chatIdFor(_tabRows(_viewModel)),
    );
    _standaloneChatCreator = ProvisionalStandaloneChatCreator(
      supportsCreate: () => viewModel.supportsStandaloneChatCreate,
      create: viewModel.ensureStandaloneChatCreated,
    );
    _worktreeChatCreator = ProvisionalWorktreeChatCreator(
      createWorktree: _ensureWorktreeCreated,
      shownChatId: () => switch (_chatIdFor(_tabRows(_viewModel))) {
        '' => null,
        final chatId => chatId,
      },
      createChat: (worktree) => _tabs.create(worktree).chatId,
      confirmChat: _tabs.ensureCreated,
      isListed: (worktree, chatId) =>
          viewModel
              .worktreesFor(worktree.workspaceLocalId)
              .any((listed) => listed.localId == worktree.localId) &&
          viewModel
              .chatSummariesFor(
                workspaceLocalId: worktree.workspaceLocalId,
                worktreeLocalId: worktree.localId,
              )
              .any((summary) => summary.chatId == chatId),
      firstMessageSent: () => _draftCoordinator.sentFromNewChat,
      sessionGeneration: () => viewModel.sessionGeneration,
    );
    _pickerCopies = PickerCopyRecorder(
      record: viewModel.attachmentCache.record,
    );
    final standaloneChat = widget.standaloneChat;
    if (worktree != null) {
      unawaited(_pickerCopies.bind(worktree));
      viewModel.ensureForegroundWorktreeChat(
        workspaceLocalId: worktree.workspaceLocalId,
        worktreeLocalId: worktree.localId,
        chatId: initialChatId,
      );
      _bindPrPoll(worktree);
    } else if (standaloneChat != null) {
      viewModel.ensureChatTranscript(
        RemoteStandaloneChatTarget(
          chatId: standaloneChat.localId,
          projectLocalId: standaloneChat.projectLocalId,
        ),
      );
    } else if (_worktreeProvisioning) {
      _creatingWorktree = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_createWorktree());
      });
    } else if (widget.workspace case final workspace?) {
      // Flat workspace: the first send mints the chat. Until the desktop
      // projects it there is nothing to hydrate, so it is tracked like a
      // provisional tab and the transcript round trip is skipped. A first
      // message that never reached the desktop keeps its chat: the screen
      // reopens it, so the not-sent row stays reachable.
      final unsent = _draftCoordinator.firstUnprojectedChat(
        viewModel.unsentStandaloneChatIdsForProject(workspace.localId),
        (chatId) => viewModel.standaloneChatById(chatId) != null,
      );
      final chatId = unsent ?? viewModel.mintStandaloneChatId();
      _provisionalStandaloneChatId = chatId;
      _tabs.addProvisional(chatId);
      if (unsent != null) {
        _draftCoordinator.resumeUnsentFirstChat(
          RemoteStandaloneChatDraftTarget(unsent),
        );
      }
    }
    viewModel.addListener(_syncWithViewModel);
  }

  /// Applies view-model changes outside rendering: tab and composer
  /// bookkeeping, then the bound chat's side effects. Rebuilds only when
  /// the bookkeeping changed something the screen renders.
  void _syncWithViewModel() {
    if (!mounted) return;
    final viewModel = _viewModel;
    final attachmentsChanged = _reconcileAttachmentCapability(viewModel);
    final worktree = _worktree;
    final projected = _projectedSummaries(viewModel);
    final projectedChatIds = {for (final summary in projected) summary.chatId};
    var changed = _tabs.sync(
      projected: projected,
      worktree: worktree,
      adopt: worktree == null
          ? const []
          : [
              ..._draftCoordinator.adoptableChatIds(
                unsentChatIds: viewModel.unsentChatIdsForWorktree(
                  worktree.workspaceLocalId,
                  worktree.localId,
                ),
                pendingChatIds: _tabs.pendingChatIds,
                projectedChatIds: projectedChatIds,
                isLoading: viewModel.isWorktreeChatsLoading(
                  workspaceLocalId: worktree.workspaceLocalId,
                  worktreeLocalId: worktree.localId,
                ),
              ),
              // Listed as provisional until the replaced pairing lists
              // it, so another chat cannot take over its files.
              if (_worktreeChatCreator.heldChatId case final chatId?
                  when !(_attachments?.isEmpty ?? true) &&
                      !projectedChatIds.contains(chatId))
                chatId,
            ],
      // The flat workspace's first chat stops being provisional once the
      // desktop projects it; from then on its transcript hydrates normally.
      confirmed: [
        if (_provisionalStandaloneChatId case final id?
            when viewModel.standaloneChatById(id) != null)
          id,
      ],
    );
    changed = _composerOverrides.sync() || changed;
    _bindChat(viewModel);
    if (changed || attachmentsChanged) setState(() {});
  }

  /// A user action or command outcome changed the tabs or composer.
  void _onControllerChanged() {
    if (!mounted) return;
    _bindChat(_viewModel);
    setState(() {});
  }

  List<RemoteChatSummary> _projectedSummaries(
    RemoteControlViewModel viewModel,
  ) {
    final worktree = _worktree;
    return worktree == null
        ? const []
        : viewModel.chatSummariesFor(
            workspaceLocalId: worktree.workspaceLocalId,
            worktreeLocalId: worktree.localId,
          );
  }

  /// The tab rows this screen lists, with optimistic creates and closes.
  List<RemoteChatSummary> _tabRows(RemoteControlViewModel viewModel) {
    final worktree = _worktree;
    if (worktree == null) return const [];
    return _tabs.rowsFor(_projectedSummaries(viewModel), worktree);
  }

  /// The chat the transcript and composer are bound to. For worktree chats
  /// this follows the desktop's active tab until the user picks one; for a
  /// worktree with no chats yet it is null and the first send mints a chat.
  String? _chatIdFor(List<RemoteChatSummary> rows) =>
      _standaloneChat?.localId ?? _tabs.chatIdFor(rows);

  /// Side effects for the chat now bound: hydration, the chat notifier and
  /// Agent activity panels, the active-chat claim and selection report, the
  /// composer's draft target, retained attachment restores, and the read
  /// acknowledgement.
  void _bindChat(RemoteControlViewModel viewModel) {
    final chatId = _chatIdFor(_tabRows(viewModel));
    final target = chatId == null ? null : _target(chatId);
    // A freshly minted chat (selected optimistically, no projected summary
    // yet) has no history to hydrate — skip the round trip so the empty
    // conversation renders instantly instead of flashing a loading state.
    final loadable =
        target != null && chatId!.isNotEmpty && !_tabs.isPending(chatId)
        ? target
        : null;
    if (loadable != null) {
      // Deduped per pairing inside the view model.
      viewModel.ensureChatTranscript(loadable);
    }
    _bindChatChanges(viewModel, target);
    _activity = _agentActivity.controllerFor(viewModel, _worktree);
    if (chatId != null) _activity?.bind(chatId);
    final isCurrent = _isShown && (_observedRoute?.isCurrent ?? true);
    _reopener.show(
      // Restoration can connect without changing the pairing generation.
      // Leave activation pending until its cache has a connected owner.
      isCurrent && viewModel.isConnected ? loadable : null,
      sessionGeneration: viewModel.sessionGeneration,
    );
    _syncActiveChat(isCurrent: isCurrent, chatId: chatId);
    if (isCurrent) _recordViewedChat(viewModel, chatId);
    _syncDraftTarget(chatId);
    _restoreRetainedAttachments(viewModel, target);
    _acknowledgeAfterFrame(
      viewModel,
      target,
      target == null
          ? const <RemoteChatMessage>[]
          : viewModel.messagesFor(target),
    );
  }

  /// Puts retained drafts back on the composer after the next frame, once
  /// each, after any send carrying attachments has settled its own batch.
  void _restoreRetainedAttachments(
    RemoteControlViewModel viewModel,
    RemoteChatTarget? target,
  ) {
    if (_attachmentRestoreScheduled ||
        _attachments == null ||
        !viewModel.supportsChatAttachments ||
        _attachmentSendInFlight ||
        !viewModel.hasRestorableChatAttachments(
          target: target,
          worktree: _worktree,
        )) {
      return;
    }
    _attachmentRestoreScheduled = true;
    WidgetsBinding.instance
      ..addPostFrameCallback((_) {
        _attachmentRestoreScheduled = false;
        final attachments = _attachments;
        if (!mounted || attachments == null || _attachmentSendInFlight) return;
        final rows = _tabRows(viewModel);
        final chatId = _chatIdFor(rows);
        for (final batch in viewModel.takeRestorableChatAttachments(
          target: chatId == null ? null : _target(chatId),
          worktree: _worktree,
        )) {
          if (batch.sessionGeneration != viewModel.sessionGeneration) {
            unawaited(attachments.restoreForNewSession(batch.drafts));
          } else {
            attachments.restore(batch.drafts);
          }
        }
      })
      ..ensureVisualUpdate();
  }

  /// Whether the user can see this chat: its route is on top and, inside the
  /// home shell, it is the selected destination.
  bool get _isShown => widget.isActive && _routeIsCurrent && _paneIsCurrent;

  DraftTarget? _draftTargetFor(String? chatId) => _draftCoordinator.targetFor(
    workspace: widget.workspace,
    worktree: _worktree,
    standaloneChat: _standaloneChat,
    chatId: chatId,
  );

  /// Rebinds the composer after the frame when the shown chat changes. The
  /// callback binds the chat shown when it runs, not [chatId]: a selection
  /// that changes back before the frame, such as a failed close, must not
  /// move the composer to the chat it left.
  void _syncDraftTarget(String? chatId) {
    if (_draftTargetFor(chatId) == _drafts.target) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _switchDraftTarget(_draftTargetFor(_chatIdFor(_tabRows(_viewModel))));
    });
  }

  void _switchDraftTarget(DraftTarget? next) =>
      _draftCoordinator.switchTarget(next);

  /// Moves a dropped provisional tab's draft to the chat now shown.
  void _preserveFailedTabDraft(String failedChatId) {
    final worktree = _worktree;
    if (worktree == null || !mounted) return;
    _draftCoordinator.preserveFailedTabDraft(
      worktree: worktree,
      failedChatId: failedChatId,
      next: _draftTargetFor(_chatIdFor(_tabRows(_viewModel))),
    );
  }

  bool _attachmentsAvailable(RemoteControlViewModel viewModel) =>
      viewModel.supportsChatAttachments &&
      (_worktree != null ||
          _worktreeProvisioning ||
          (_standaloneChat != null && viewModel.supportsStandaloneChatCreate));

  /// Creates or drops [_attachments] for the current capability, and
  /// reports whether it did.
  bool _reconcileAttachmentCapability(RemoteControlViewModel viewModel) {
    final shouldEnable = _attachmentsAvailable(viewModel);
    final current = _attachments;
    if (current != null) {
      // Uploads belong to one session and need the capability; the picked
      // bytes stay for Retry. An empty strip goes with the capability once
      // no pick is under way.
      final generation = viewModel.sessionGeneration;
      if (!shouldEnable || generation != _attachmentsSessionGeneration) {
        _attachmentsSessionGeneration = generation;
        current.invalidateUploads();
      }
      if (shouldEnable || !current.isEmpty || current.isPicking) return false;
      _attachments = null;
      _discardAndDisposeAttachments(current);
      return true;
    }
    if (!shouldEnable) return false;
    final attachments = ChatAttachmentController(
      uploader: RemoteChatAttachmentUploader(viewModel.repository),
      prepareUpload: _prepareAttachmentUpload,
      picker:
          widget.attachmentPicker ??
          PlatformAttachmentPicker(
            onFilesRead: _worktree != null || _createsWorktree
                ? _pickerCopies.filesRead
                : null,
          ),
    )..addListener(_onAttachmentsChanged);
    _attachments = attachments;
    _attachmentsSessionGeneration = viewModel.sessionGeneration;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && identical(_attachments, attachments)) {
        _recoverLostMedia(attachments);
      }
    });
    return true;
  }

  /// Runs before each upload, so a retried file never uploads while the
  /// desktop cannot take it. A new task's files then wait for its worktree
  /// and first chat.
  Future<void> _prepareAttachmentUpload() async {
    if (!_attachmentsAvailable(_viewModel)) {
      throw const RemoteControlException(kAttachmentsNeedReconnect);
    }
    if (_createsWorktree) return _worktreeChatCreator.ensureCreated();
    return _ensureStandaloneChatCreated();
  }

  void _discardAndDisposeAttachments(ChatAttachmentController attachments) {
    attachments.removeListener(_onAttachmentsChanged);
    unawaited(attachments.discardAll().whenComplete(attachments.dispose));
  }

  /// Starts this view's PR-state poll for [worktree].
  void _bindPrPoll(RemoteWorktree worktree) {
    _prPoll?.dispose();
    _prPoll = _viewModel.pollPrState(worktree);
    _syncPrPoll();
  }

  /// The poll runs while the chat is shown and the app is in the foreground.
  void _syncPrPoll() {
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    final appIsForeground =
        lifecycle == null || lifecycle == AppLifecycleState.resumed;
    _prPoll?.setVisible(_isShown && appIsForeground);
  }

  /// Creates the tree workspace's worktree and binds it in place, unless a
  /// create is already running. Errors render inside the transcript area
  /// with a Retry that reuses [_createAttempt], so a retry can only
  /// reconcile the accepted create.
  Future<void> _createWorktree() => _worktreeCreation ??= _runWorktreeCreate()
      .whenComplete(() => _worktreeCreation = null);

  Future<void> _runWorktreeCreate() async {
    final workspace = widget.workspace;
    if (workspace == null) return;
    widget.firstSend?.begin();
    if (!_creatingWorktree || _createError != null) {
      setState(() {
        _creatingWorktree = true;
        _createError = null;
      });
    }
    final viewModel = context.read<RemoteControlViewModel>();
    try {
      final worktree = await viewModel.createWorktree(
        workspaceLocalId: workspace.localId,
        baseWorktreeId: widget.baseWorktreeId,
        attempt: _createAttempt,
      );
      unawaited(_pickerCopies.bind(worktree));
      if (!mounted) return;
      setState(() {
        _createdWorktree = worktree;
        _createdWorktreeGeneration = viewModel.sessionGeneration;
        _creatingWorktree = false;
      });
      viewModel.ensureForegroundWorktreeChat(
        workspaceLocalId: worktree.workspaceLocalId,
        worktreeLocalId: worktree.localId,
        chatId: null,
      );
      _bindPrPoll(worktree);
      _syncWithViewModel();
    } catch (error) {
      widget.firstSend?.didFail();
      if (!mounted) return;
      setState(() {
        _creatingWorktree = false;
        _createError = error is RemoteControlException
            ? error.message
            : "Couldn't create the worktree. Please try again.";
      });
    }
  }

  /// The worktree a new task's first upload waits for, and the pairing that
  /// reported it, starting a retry when its create failed.
  Future<({RemoteWorktree worktree, int generation})>
  _ensureWorktreeCreated() async {
    if (_createdWorktree == null) await _createWorktree();
    return switch ((_createdWorktree, _createdWorktreeGeneration)) {
      (final worktree?, final generation?) => (
        worktree: worktree,
        generation: generation,
      ),
      _ => throw RemoteControlException(
        _createError ?? "Couldn't create the worktree. Please try again.",
      ),
    };
  }

  /// Progress copy for the in-place create, following the view model's
  /// phase: submitted, reserved with git setup running, or accepted without
  /// an echoed id.
  String _worktreeCreateLabel(RemoteControlViewModel viewModel) =>
      switch (viewModel.worktreeCreatePhase) {
        RemoteWorktreeCreatePhase.settingUp => 'Setting up worktree…',
        RemoteWorktreeCreatePhase.awaitingDesktop =>
          'Still setting up on your desktop…',
        RemoteWorktreeCreatePhase.submitting || null => 'Creating worktree…',
      };

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!mounted) return;
    _syncPrPoll();
    if (state == AppLifecycleState.resumed) {
      setState(() {});
      final attachments = _attachments;
      if (attachments != null) _recoverLostMedia(attachments);
      _bindChat(_viewModel);
      return;
    }
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      unawaited(_voice.abandon());
    }
  }

  void _acknowledgeAfterFrame(
    RemoteControlViewModel vm,
    RemoteChatTarget? target,
    List<RemoteChatMessage> messages,
  ) {
    _renderedReadChatId = target?.chatId;
    if (target == null || isChatTurnRunning(messages)) return;
    // Synthetic turn-timer rows can follow the final reply; acknowledge the
    // actual transcript message, matching the desktop's persisted projection.
    final latest = messages
        .where(
          (m) =>
              m.delivery == null &&
              (m.text.isNotEmpty ||
                  m.attachments.isNotEmpty ||
                  m.parts.any((p) => p.kind != 'turn_timer')),
        )
        .lastOrNull;
    if (latest != null && latest.role != ChatRole.assistant) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final lifecycle = WidgetsBinding.instance.lifecycleState;
      if (!mounted ||
          !_isShown ||
          _renderedReadChatId != target.chatId ||
          !(ModalRoute.of(context)?.isCurrent ?? true) ||
          (lifecycle != null && lifecycle != AppLifecycleState.resumed)) {
        return;
      }
      unawaited(vm.acknowledgeVisibleChat(target, latest?.messageId));
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _paneIsCurrent = AppRouteScope.isCurrentOf(context);
    _syncPrPoll();
    if (!_paneIsCurrent) unawaited(_voice.abandon());
    final route = ModalRoute.of<Object?>(context);
    final observer = AppRouteScope.of(context);
    if (!identical(route, _observedRoute) ||
        !identical(observer, _routeObserver)) {
      _routeObserver?.unsubscribe(this);
      _routeObserver = observer;
      _observedRoute = route;
      if (route != null) observer.subscribe(this, route);
    }
    ActiveChatTracker? tracker;
    try {
      tracker = context.read<ActiveChatTracker>();
    } on ProviderNotFoundException {
      // Hosts without push wiring (tests, previews) simply skip tracking.
      tracker = null;
    }
    if (!identical(tracker, _activeChatTracker)) {
      _activeChatTracker?.release(_activeChatOwner);
      _activeChatTracker = tracker;
    }
    // Route currency is a dependency: covering or uncovering the route
    // re-runs this, which updates the active-chat claim.
    _syncWithViewModel();
  }

  @override
  void didUpdateWidget(RemoteChatScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.isActive == widget.isActive) return;
    _syncPrPoll();
    _bindChat(_viewModel);
    if (!widget.isActive) unawaited(_voice.abandon());
  }

  @override
  void didPushNext() {
    _routeIsCurrent = false;
    _syncPrPoll();
    unawaited(_voice.abandon());
  }

  @override
  void didPopNext() {
    _routeIsCurrent = true;
    _syncPrPoll();
  }

  /// Remembers the worktree tab on screen so the worktree reopens on it. A
  /// tab the desktop has not listed yet is remembered once it is, so a
  /// failed create is never remembered. A tab this screen still shows after
  /// a disconnect or ended session is not remembered in the next session.
  void _recordViewedChat(RemoteControlViewModel viewModel, String? chatId) {
    final worktree = _worktree;
    if (worktree == null || chatId == null || chatId.isEmpty) return;
    viewModel.recordViewedChat(
      worktree,
      chatId,
      pending: _tabs.isPending(chatId),
      sessionGeneration: _openedSessionGeneration,
    );
  }

  void _syncActiveChat({required bool isCurrent, required String? chatId}) {
    final tracker = _activeChatTracker;
    if (tracker == null) return;
    if (!isCurrent) {
      tracker.release(_activeChatOwner);
      return;
    }
    // Preserve a deep-linked selection while chat summaries hydrate. Once a
    // non-empty authoritative list arrives, the tabs controller either
    // validates it or clears it before this claim is updated.
    tracker.claim(_activeChatOwner, chatId ?? _tabs.selectedChatId);
  }

  @override
  void dispose() {
    _viewModel.removeListener(_syncWithViewModel);
    _worktreeChatCreator.dispose();
    _tabs.dispose();
    _composerOverrides.dispose();
    _prPoll?.dispose();
    _chatChanges?.dispose();
    _agentActivity.dispose();
    WidgetsBinding.instance.removeObserver(this);
    _routeObserver?.unsubscribe(this);
    _activeChatTracker?.release(_activeChatOwner);
    final attachments = _attachments;
    if (attachments != null) {
      // Leaving the screen abandons the staged files: reclaim the uploaded
      // blobs before the controller goes away (discardAll tolerates the
      // disposal that follows it).
      _discardAndDisposeAttachments(attachments);
    }
    _voice.removeListener(_onVoiceChanged);
    // Close the microphone before the draft goes away; a late final result
    // has nowhere to land.
    unawaited(_voice.abandon());
    _voice.dispose();
    _drafts.dispose();
    _composer.dispose();
    super.dispose();
  }

  /// Surfaces a dictation issue once: guidance dialogs for blocked or
  /// missing recognition, a snackbar for a transient stop.
  void _onVoiceChanged() {
    final issue = _voice.takeIssue();
    if (issue == null || !mounted) return;
    if (issue == VoiceDictationIssue.failed) {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          const SnackBar(content: Text('Voice dictation stopped. Try again.')),
        );
      return;
    }
    unawaited(showVoiceDictationIssueDialog(context, issue));
  }

  /// Surfaces a staging issue or an upload failure once, as a snackbar. Each
  /// string points at the action the user can take rather than restating the
  /// refusal. The failed chip keeps its own copy of the upload error, but the
  /// strip can be scrolled out of view, so the failure is announced too.
  void _onAttachmentsChanged() {
    final attachments = _attachments;
    if (attachments == null) return;
    final issue = attachments.takeIssue();
    final uploadError = attachments.takeUploadError();
    if (!mounted) return;
    setState(() {});
    if (uploadError != null) {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(uploadError)));
    }
    if (issue == null) return;
    final message = chatAttachmentIssueMessage(
      issue,
      tooMany: 'Attach or mention up to 8 files per message.',
    );
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  /// A new task's files added to an empty strip start a batch for this
  /// pairing; other chats' files are not held. A pick still under way keeps
  /// its batch, whatever pairing or chat is current when it returns.
  void _startBatchIfIdle(ChatAttachmentController attachments) {
    if (_createsWorktree && attachments.isEmpty && !attachments.isPicking) {
      _worktreeChatCreator.startBatch();
    }
  }

  void _recoverLostMedia(ChatAttachmentController attachments) {
    unawaited(_pick(attachments, attachments.recoverLostMedia));
  }

  Future<void> _onAttach(ChatAttachmentSource source) async {
    final attachments = _attachments;
    if (attachments == null) return;
    await _pick(attachments, switch (source) {
      ChatAttachmentSource.camera => attachments.addFromCamera,
      ChatAttachmentSource.photoLibrary => attachments.addFromPhotoLibrary,
      ChatAttachmentSource.files => attachments.addFiles,
    });
  }

  /// Runs a pick or lost-media recovery. A controller kept through a lost
  /// capability only for this pick goes once it stages nothing.
  Future<void> _pick(
    ChatAttachmentController attachments,
    Future<void> Function() pick,
  ) async {
    _startBatchIfIdle(attachments);
    await pick();
    if (mounted && _reconcileAttachmentCapability(_viewModel)) setState(() {});
  }

  /// The computer icon, then [detail] and the computer's name.
  static Widget _locationSubtitle(String? detail, String? computer) {
    final hasComputer = computer != null && computer.isNotEmpty;
    return ChatLocationSubtitle(
      glyph: CanopyGlyph.macbook,
      location: hasComputer ? 'Chat on $computer' : 'Chat on your computer',
      text: detail,
      computer: computer,
    );
  }

  String get _title {
    final worktree = _worktree;
    if (worktree != null) {
      final label = worktree.label;
      return label != null && label.isNotEmpty ? label : worktree.branch;
    }
    final standalone = _standaloneChat;
    if (standalone == null) return 'Chat';
    if (widget.standaloneChat != null) return standalone.displayTitle;
    // A provisional first chat takes the desktop's title once it exists.
    final live = context.read<RemoteControlViewModel>().standaloneChatById(
      standalone.localId,
    );
    return (live ?? standalone).displayTitle;
  }

  /// The bound chat's change notifier, rebound when the chat or the paired
  /// session changes. The chat body listens to it instead of the whole view
  /// model, so other chats and unrelated client concerns never rebuild it.
  void _bindChatChanges(
    RemoteControlViewModel viewModel,
    RemoteChatTarget? target,
  ) {
    final key = (
      chat: target == null ? null : remoteChatKeyForTarget(target),
      sessionGeneration: viewModel.sessionGeneration,
    );
    if (_chatChanges != null && key == _chatChangesKey) return;
    _chatChanges?.dispose();
    _chatChangesKey = key;
    _chatChanges = viewModel.chatChangesFor(target);
  }

  /// Everything [_buildChatBody] reads besides the bound chat's own state,
  /// as comparable values, so the body rebuilds for its chrome (banners, the
  /// tabs button, and composer inputs) but not for unrelated notifications.
  /// Siblings contribute only their unread flag, the tabs button's one
  /// sibling input.
  List<Object?> _bodyChrome(
    RemoteControlViewModel vm,
    RemoteWorktree? worktree,
    String? chatId,
  ) {
    return [
      vm.portalConnectionStatus,
      vm.linkState,
      vm.connection?.deviceLabel,
      vm.commandFailureMessage,
      vm.isConnected,
      vm.sessionGeneration,
      vm.supportsChatAttachments,
      vm.supportsStandaloneChatCreate,
      vm.projectedModelCatalog,
      vm.projectedModelCatalogIsAuthoritative,
      vm.projectedProviderAvailability,
      vm.worktreeCreatePhase,
      vm.isWorktreeCreateStillRunning,
      if (worktree != null) ...[
        for (final summary in vm.chatSummariesFor(
          workspaceLocalId: worktree.workspaceLocalId,
          worktreeLocalId: worktree.localId,
        ))
          (summary.chatId, summary.hasUnread),
        vm.worktreeNeedsAnswer(worktree),
        vm.foregroundChatError(worktree.workspaceLocalId, worktree.localId),
      ] else if (chatId != null)
        vm.snapshot?.standaloneChats
            .where((chat) => chat.localId == chatId)
            .firstOrNull,
    ];
  }

  /// What the end drawer shows, as comparable values: the worktree's raw
  /// snapshot row (the sidebar reads only row fields the read projection
  /// never changes), its activity, changed-file load and PR state, or a
  /// standalone chat's workspace name.
  List<Object?> _drawerInputs(
    RemoteControlViewModel vm,
    RemoteWorktree? worktree,
  ) {
    if (worktree == null) {
      return [
        vm.workspaces
            .where((w) => w.localId == _standaloneChat?.projectLocalId)
            .firstOrNull
            ?.name,
      ];
    }
    return [
      vm.snapshot?.worktrees
          .where(
            (row) =>
                row.workspaceLocalId == worktree.workspaceLocalId &&
                row.localId == worktree.localId,
          )
          .firstOrNull,
      vm.worktreeActivityFor(worktree.localId),
      vm.changedFilesStatus(worktree.localId),
      vm.prProgressFor(worktree.workspaceLocalId, worktree.localId),
      vm.cachedPrReposFor(worktree.workspaceLocalId, worktree.localId),
      vm.cachedPrBusyFor(worktree.workspaceLocalId, worktree.localId),
      vm.supportsPrActions,
    ];
  }

  RemoteChatTarget _target(String? chatId) {
    final worktree = _worktree;
    if (worktree != null) {
      return RemoteWorktreeChatTarget(
        workspaceLocalId: worktree.workspaceLocalId,
        worktreeLocalId: worktree.localId,
        chatId: chatId,
      );
    }
    final standaloneChat = _standaloneChat;
    return RemoteStandaloneChatTarget(
      chatId: standaloneChat?.localId ?? '',
      projectLocalId: standaloneChat?.projectLocalId,
    );
  }

  /// Standalone chats have no `portal.standalone_chat.set_*` commands for
  /// thinking/fast — the values ride each send's `modelConfig` instead, and
  /// only when the user actually touched the control (an untouched send must
  /// omit the field so it cannot clobber a level set on desktop). Mirrors
  /// the web composer's touched-tracking. A touched level is sent as shown:
  /// clamped to the current model's levels, and omitted when it has none.
  RemoteChatSendOptions? _standaloneSendOptions(String? chatId) {
    if (_worktree != null || chatId == null) return null;
    final standalone = _viewModel.standaloneChatById(chatId) ?? _standaloneChat;
    final provider = standalone?.providerType;
    final touched = _composerOverrides.valueOf(
      chatId,
      ComposerField.thinkingLevel,
    );
    final effort = touched == null
        ? null
        : RemoteComposerEffort.resolve(
            catalog: standalone?.availableModels ?? const [],
            modelId:
                _composerOverrides.valueOf(chatId, ComposerField.model) ??
                standalone?.model,
            providerType: provider,
            level: touched,
          );
    final options = RemoteChatSendOptions(
      thinkingLevel: effort == null || effort.levels.isEmpty
          ? null
          : effort.level,
      fastMode: provider == 'codex'
          ? _composerOverrides.valueOf(chatId, ComposerField.fastMode)
          : null,
    );
    return options.isEmpty ? null : options;
  }

  /// Send options for [chatId]; a dictated draft also carries the voice
  /// input marker the desktop renders as a mic badge on the bubble.
  RemoteChatSendOptions? _sendOptions(
    String? chatId, {
    required bool dictated,
    List<ChatAttachmentRef> attachments = const [],
    RemoteChatSendOptions? draftOptions,
  }) {
    // A draft composed before this screen opened brings its own selections.
    var options = draftOptions ?? _standaloneSendOptions(chatId);
    if (dictated) {
      options = (options ?? const RemoteChatSendOptions()).copyWith(
        inputMode: 'voice',
      );
    }
    if (attachments.isEmpty) return options;
    return (options ?? const RemoteChatSendOptions()).copyWith(
      attachments: attachments,
    );
  }

  Future<void> _send(RemoteControlViewModel viewModel, String? chatId) async {
    final draft = _composer.value;
    final draftTarget = _drafts.target;
    final text = draft.text.trim();
    final attachments = _attachments;
    if (_sending) return;
    if (text.isEmpty && (attachments?.isEmpty ?? true)) {
      widget.firstSend?.didFail();
      return;
    }
    // Taken only once the send is certain to proceed, so a disabled or
    // double tap can never strip the composer of its staged files.
    final staged = attachments?.takeForSend() ?? const <ChatAttachmentDraft>[];
    final refs = [for (final stagedDraft in staged) ?stagedDraft.uploaded];
    // The refs belong to this session; files restored after it changed
    // upload again, as the strip's own files do.
    final sendGeneration = viewModel.sessionGeneration;
    void restoreStaged(ChatAttachmentController attachments) {
      if (viewModel.sessionGeneration == sendGeneration) {
        attachments.restore(staged);
      } else {
        unawaited(attachments.restoreForNewSession(staged));
      }
    }

    // The only moment this device holds both the bytes and the id the
    // transcript will carry. The decode is deliberately not awaited: a
    // preview must never delay the send, and the chip rebuilds itself when
    // the thumbnail lands.
    for (final stagedDraft in staged) {
      final uploaded = stagedDraft.uploaded;
      if (uploaded == null) continue;
      unawaited(
        viewModel.attachmentThumbnails.retain(
          attachmentId: uploaded.attachmentId,
          mediaType: stagedDraft.mediaType,
          bytes: stagedDraft.bytes,
        ),
      );
    }
    widget.firstSend?.begin();
    final dictated = _voice.dictated;
    // Sending mid-dictation ends the session without its final result; the
    // words on screen are what the user chose to send.
    unawaited(_voice.abandon());
    setState(() => _sending = true);
    // A text-only send clears the composer once its durable record holds the
    // text (below); an attachment send keeps the restore-on-failure path.
    if (staged.isNotEmpty) _composer.clear();
    var sendChatId = chatId;
    String? submittingAttachmentBatchId;
    _attachmentSendInFlight = staged.isNotEmpty;
    try {
      await _ensureStandaloneChatCreated();
      final worktree = _worktree;
      if (staged.isNotEmpty && sendChatId == null && worktree != null) {
        // The provisional tab stays while this send settles its batch, even
        // if the desktop rejects its creation meanwhile.
        final (:chatId, :submitted) = _tabs.create(worktree);
        sendChatId = chatId;
        _tabs.holdFailures(chatId);
        submittingAttachmentBatchId = viewModel.retainSubmittingChatAttachments(
          target: _target(chatId),
          drafts: staged,
        );
        await submitted;
      }
      if (staged.isNotEmpty && submittingAttachmentBatchId == null) {
        submittingAttachmentBatchId = viewModel.retainSubmittingChatAttachments(
          target: _target(sendChatId),
          drafts: staged,
        );
      }
      if (staged.isNotEmpty &&
          sendChatId != null &&
          _tabs.isPending(sendChatId)) {
        _tabs.holdFailures(sendChatId);
      }
      final sending = viewModel.sendChatMessage(
        _target(sendChatId),
        text,
        options: _sendOptions(
          sendChatId,
          dictated: dictated,
          attachments: refs,
          draftOptions: widget.firstSend?.options,
        ),
        clearDraft: staged.isEmpty ? draftTarget : null,
      );
      if (staged.isEmpty) _composer.clear();
      final result = await sending;
      widget.firstSend?.didEnqueue();
      if (staged.isNotEmpty && result.commandId.isNotEmpty) {
        final provisionalCreateCommandId = sendChatId == null
            ? null
            : _tabs.createCommandIdFor(sendChatId);
        if (viewModel.hasCommandFailed(result.commandId)) {
          final currentAttachments = _attachments;
          if (mounted &&
              currentAttachments != null &&
              identical(attachments, currentAttachments)) {
            restoreStaged(currentAttachments);
            if (submittingAttachmentBatchId != null) {
              viewModel.removePendingChatAttachments(
                submittingAttachmentBatchId,
              );
            }
          } else if (submittingAttachmentBatchId != null) {
            viewModel.markPendingChatAttachmentsForRestore(
              submittingAttachmentBatchId,
            );
          } else {
            viewModel.retainPendingChatAttachments(
              commandId: result.commandId,
              target: _target(result.chatId ?? sendChatId),
              drafts: staged,
              provisionalCreateCommandId: provisionalCreateCommandId,
            );
          }
        } else if (!viewModel.hasCommandCompleted(result.commandId)) {
          if (submittingAttachmentBatchId != null) {
            viewModel.removePendingChatAttachments(submittingAttachmentBatchId);
          }
          viewModel.retainPendingChatAttachments(
            commandId: result.commandId,
            target: _target(result.chatId ?? sendChatId),
            drafts: staged,
            provisionalCreateCommandId: provisionalCreateCommandId,
          );
        } else if (submittingAttachmentBatchId != null) {
          viewModel.removePendingChatAttachments(submittingAttachmentBatchId);
        }
      } else if (submittingAttachmentBatchId != null) {
        viewModel.removePendingChatAttachments(submittingAttachmentBatchId);
      }
      if (!mounted) return;
      final mintedChatId = result.chatId;
      if (sendChatId == null &&
          mintedChatId != null &&
          mintedChatId.isNotEmpty) {
        _tabs.addProvisional(mintedChatId, select: true);
      }
      // The `finally` below rebuilds.
      _followSentChat(draftTarget, sendChatId ?? mintedChatId);
    } on RemoteChatSendNotSentException catch (e) {
      widget.firstSend?.didEnqueue();
      // The transcript row now holds the message with Resend and Discard.
      if (!mounted) return;
      final rowChatId = e.chatId;
      if (sendChatId == null && rowChatId != null) {
        _tabs.addProvisional(rowChatId, select: true);
      }
      _followSentChat(draftTarget, sendChatId ?? rowChatId);
    } on RemoteControlException catch (e) {
      if (!mounted) {
        if (submittingAttachmentBatchId != null) {
          viewModel.markPendingChatAttachmentsForRestore(
            submittingAttachmentBatchId,
          );
        }
        return;
      }
      if (_composer.text.isEmpty) {
        _composer.value = draft;
        if (dictated) _voice.restoreDictatedMarker();
      }
      // The files were never sent; put them back on the strip so a retry
      // carries what the user chose instead of silently dropping it.
      final currentAttachments = _attachments;
      if (currentAttachments != null &&
          identical(attachments, currentAttachments)) {
        restoreStaged(currentAttachments);
        if (submittingAttachmentBatchId != null) {
          viewModel.removePendingChatAttachments(submittingAttachmentBatchId);
        }
      } else if (submittingAttachmentBatchId != null) {
        viewModel.markPendingChatAttachmentsForRestore(
          submittingAttachmentBatchId,
        );
      }
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      widget.firstSend?.didFail();
      _attachmentSendInFlight = false;
      _tabs.releaseFailures();
      if (mounted) {
        setState(() => _sending = false);
        _syncWithViewModel();
      }
    }
  }

  /// Moves the composer from the target it sent from ([sentFrom]) to the chat
  /// the send landed in, so text typed while a send created its chat (or this
  /// screen's first chat) stays in the composer and is saved under that chat.
  /// Does nothing when the user has switched chats since the send started.
  void _followSentChat(DraftTarget? sentFrom, String? chatId) {
    _draftCoordinator.sentFromNewChat = true;
    if (sentFrom == null || _drafts.target != sentFrom) return;
    if (_draftTargetFor(chatId) case final next?) _drafts.rebind(next);
  }

  Future<void> _ensureStandaloneChatCreated() =>
      _standaloneChatCreator.ensureCreated(
        chatId: _provisionalStandaloneChatId,
        projectLocalId: widget.workspace?.localId,
        isOpen: mounted,
      );

  /// Starts a new conversation the same way the web portal does (CAN-1233):
  /// mint the chat id locally, select it optimistically, and ask the desktop
  /// to create the matching empty tab. Works against current production
  /// desktops — the tab is created through the desktop renderer, the single
  /// tabs-file writer.
  void _startNewChat(RemoteWorktree worktree) {
    unawaited(_voice.abandon());
    unawaited(_runRemoteAction(_tabs.start(worktree)));
  }

  Future<void> _closeChatTab(RemoteWorktree worktree, String chatId) async {
    if (_tabs.selectedChatId == chatId) unawaited(_voice.abandon());
    await _runRemoteAction(_tabs.close(worktree, chatId));
  }

  RemoteChatSummary? _summaryFor(
    List<RemoteChatSummary> summaries,
    String chatId,
  ) {
    for (final summary in summaries) {
      if (summary.chatId == chatId) return summary;
    }
    return null;
  }

  String? _modelLabelFor(String id, List<ModelOption> models) {
    for (final model in models) {
      if (model.id == id) return model.label;
    }
    return null;
  }

  /// Applies a composer choice immediately and, unless [local], sends it. A
  /// rejection returns the control to the projection and is surfaced.
  /// [onSettled] reports whether the choice was kept.
  void _changeComposer<T extends Object>(
    RemoteChatTarget target,
    ComposerField<T> field,
    T value, {
    bool local = false,
    void Function(bool applied)? onSettled,
  }) => unawaited(
    _runRemoteAction(
      _composerOverrides.change(
        target,
        field,
        value,
        local: local,
        onSettled: (applied) {
          if (applied) widget.firstSend?.didChange(field, value);
          onSettled?.call(applied);
        },
      ),
    ),
  );

  /// Auto for a worktree chat whose desktop can route, or that is already in
  /// Auto. Standalone chats have no Auto.
  ModelAutoControl? _autoControl(
    RemoteWorktreeChatTarget? target,
    RemoteChatSummary? summary,
  ) {
    final chatId = target?.chatId;
    if (target == null || chatId == null) return null;
    final selected = _composerOverrides.autoSelected(
      chatId,
      projected: summary?.modelAuto ?? false,
    );
    if (!selected && summary?.modelRoutingSupported != true) return null;
    return ModelAutoControl(
      selected: selected,
      onSelect: () =>
          unawaited(_runRemoteAction(_composerOverrides.chooseAuto(target))),
    );
  }

  /// Builds the composer control bundle for the resolved chat, or null when no
  /// chat is resolved yet (a brand-new worktree chat).
  ComposerControlsData? _composerControls({
    required RemoteControlViewModel viewModel,
    required String? chatId,
    required List<RemoteChatSummary> summaries,
    required bool isRunning,
  }) {
    if (chatId == null || chatId.isEmpty) return null;
    final worktree = _worktree;
    final isWorktree = worktree != null;
    final summary = isWorktree ? _summaryFor(summaries, chatId) : null;
    final standalone = isWorktree
        ? null
        : viewModel.standaloneChatById(chatId) ?? _standaloneChat;
    final target = _target(chatId);
    final overrides = _composerOverrides;

    // A new tab has no catalog until its first desktop projection. Reuse the
    // host catalog already hydrated by another chat. An explicitly projected
    // empty catalog remains authoritative.
    final hasWorktreeCatalog = summary?.hasProjectedModelCatalog ?? false;
    final availableModels = isWorktree
        ? (hasWorktreeCatalog && summary != null
              ? summary.availableModels
              : viewModel.projectedModelCatalog)
        : (standalone?.availableModels ?? const <ModelOption>[]);
    final providerAvailability = isWorktree
        ? (hasWorktreeCatalog
              ? summary?.providerAvailability
              : viewModel.projectedProviderAvailability)
        : standalone?.providerAvailability;

    // Empty tabs can omit a model override. The projected default is what
    // the desktop will use on send; displaying it must not persist an override.
    final defaultModel = availableModels
        .where((model) => model.isDefault)
        .firstOrNull;
    final summaryModelId =
        (isWorktree ? summary?.model : standalone?.model) ?? defaultModel?.id;
    final summaryModelLabel = isWorktree
        ? summary?.modelLabel
        : standalone?.modelLabel;
    final summaryPlan = summary?.planMode ?? false;

    final pendingModel = overrides.valueOf(chatId, ComposerField.model);
    final effModelId = pendingModel ?? summaryModelId;
    final effModelLabel = pendingModel != null
        ? (_modelLabelFor(pendingModel, availableModels) ??
              summaryModelLabel ??
              pendingModel)
        : summaryModelLabel;
    final selectedModel = availableModels
        .where((model) => model.id == effModelId)
        .firstOrNull;
    final providerType =
        selectedModel?.provider ??
        (isWorktree ? summary?.providerType : standalone?.providerType);
    final effPlan =
        overrides.valueOf(chatId, ComposerField.planMode) ?? summaryPlan;
    final effort = RemoteComposerEffort.resolve(
      catalog: availableModels,
      modelId: effModelId,
      executionHarness: summary?.executionHarness,
      providerType: isWorktree
          ? summary?.providerType
          : standalone?.providerType,
      level:
          overrides.valueOf(chatId, ComposerField.thinkingLevel) ??
          summary?.thinkingLevel ??
          'off',
      pendingFast: overrides.valueOf(chatId, ComposerField.fastMode),
      speed: summary?.speed,
      fastMode: summary?.fastMode,
    );

    final worktreeTarget = isWorktree
        ? RemoteWorktreeChatTarget(
            workspaceLocalId: worktree.workspaceLocalId,
            worktreeLocalId: worktree.localId,
            chatId: chatId,
          )
        : null;

    return ComposerControlsData(
      providerType: providerType,
      modelLabel: effModelLabel ?? selectedModel?.label ?? effModelId,
      selectedModelId: effModelId,
      availableModels: availableModels,
      providerAvailability: providerAvailability,
      planMode: worktreeTarget == null
          ? null
          : PlanModeControl(
              enabled: effPlan,
              onToggle: () => _changeComposer(
                worktreeTarget,
                ComposerField.planMode,
                !effPlan,
              ),
            ),
      supportsFastMode: providerType == 'codex',
      // Standalone chats carry effort and fast mode on the next send's
      // modelConfig instead of a command; see [_standaloneSendOptions].
      effort: effort.levels.isEmpty
          ? null
          : EffortControl(
              level: effort.level,
              levels: effort.levels,
              chatId: chatId,
              onSelect: (level) {
                final kept = Completer<bool>();
                _changeComposer(
                  target,
                  ComposerField.thinkingLevel,
                  level,
                  local: worktreeTarget == null,
                  onSettled: kept.complete,
                );
                return kept.future;
              },
            ),
      speed: effort.speed,
      isRunning: isRunning,
      catalogStatus: hasWorktreeCatalog || availableModels.isNotEmpty
          ? ModelCatalogStatus.loaded
          : ModelCatalogStatus.absent,
      emptyCatalogHint: 'Check model settings in the desktop app.',
      lockedHarness: summary?.executionHarness,
      auto: _autoControl(worktreeTarget, summary),
      onSelectModel: (id) => unawaited(
        _runRemoteAction(
          overrides.chooseModel(
            target,
            id,
            onSettled: (applied) {
              if (!applied) return;
              widget.firstSend?.didChange(
                ComposerField.model,
                id,
                providerType: availableModels
                    .where((model) => model.id == id)
                    .firstOrNull
                    ?.provider,
              );
            },
          ),
        ),
      ),
      // Ultra fast is read-only here: this client cannot set it, and
      // toggling would step the chat down to Fast or Regular. The speed is
      // read again because a sheet or command can hold this callback past a
      // newer projection.
      onToggleFast: () {
        final current = isWorktree
            ? _summaryFor(_projectedSummaries(viewModel), chatId) ?? summary
            : null;
        final speed = RemoteComposerEffort.speedOf(
          pendingFast: overrides.valueOf(chatId, ComposerField.fastMode),
          speed: current?.speed,
          fastMode: current?.fastMode,
        );
        if (speed == CanopyEffortSpeed.ultraFast) return;
        _changeComposer(
          target,
          ComposerField.fastMode,
          speed == CanopyEffortSpeed.regular,
          local: worktreeTarget == null,
        );
      },
      onStop: () => unawaited(() async {
        try {
          await viewModel.cancelChat(target);
        } on RemoteControlException catch (e) {
          if (!mounted) return;
          ScaffoldMessenger.of(context)
            ..hideCurrentSnackBar()
            ..showSnackBar(SnackBar(content: Text(e.message)));
        }
      }()),
    );
  }

  /// Awaits a remote command, surfacing a rejected submit as a snackbar
  /// (mirrors the stop-button error path).
  Future<void> _runRemoteAction(Future<void> action) async {
    try {
      await action;
    } on RemoteControlException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  /// The worktree's current per-chat signals for the tab sheet.
  ///
  /// Membership comes from [rows] — the screen's snapshot, which layers
  /// optimistic create/close bookkeeping over the projection — while each
  /// row's state is re-read from the view model, so a row the desktop has
  /// since updated reports its new state rather than the one it had when the
  /// sheet opened. A provisional chat with no projection yet falls back to its
  /// snapshot summary, which is how a brand-new tab still shows the turn it is
  /// already awaiting.
  ChatTabsLiveState _chatTabsLiveState(
    RemoteControlViewModel viewModel,
    RemoteWorktree worktree,
    List<RemoteChatSummary> rows,
  ) {
    final projected = {
      for (final summary in viewModel.chatSummariesFor(
        workspaceLocalId: worktree.workspaceLocalId,
        worktreeLocalId: worktree.localId,
      ))
        summary.chatId: summary,
    };
    final working = <String>{};
    final unread = <String>{};
    for (final row in rows) {
      final chatId = row.chatId;
      final live = projected[chatId] ?? row;
      final target = RemoteWorktreeChatTarget(
        workspaceLocalId: worktree.workspaceLocalId,
        worktreeLocalId: worktree.localId,
        chatId: chatId,
      );
      if (viewModel.isAwaitingAgentTurn(target) ||
          live.turnActive == true ||
          viewModel.isStreamingForChat(target)) {
        working.add(chatId);
      }
      if (live.hasUnread == true) unread.add(chatId);
    }
    return ChatTabsLiveState(
      working: working,
      unread: unread,
      needsAnswer: viewModel.chatsNeedingAnswerFor(worktree),
    );
  }

  @override
  Widget build(BuildContext context) {
    final viewModel = context.read<RemoteControlViewModel>();
    // Chrome and tab membership depend on membership, titles, selection and
    // the controllers' state, never on streamed transcript text. Lists are
    // fresh value projections so Provider can compare their contents; no
    // mutable map or full snapshot is retained as a selector value.
    context.select<RemoteControlViewModel, List<Object?>>(
      (vm) => [
        vm.sessionGeneration,
        vm.isConnected,
        vm.connection?.deviceLabel,
        vm.supportsChatAttachments,
        vm.supportsStandaloneChatCreate,
        if (_worktree case final worktree?) ...[
          for (final summary in vm.chatSummariesFor(
            workspaceLocalId: worktree.workspaceLocalId,
            worktreeLocalId: worktree.localId,
          ))
            (summary.chatId, summary.displayTitle, summary.active),
          vm.isWorktreeChatsLoading(
            workspaceLocalId: worktree.workspaceLocalId,
            worktreeLocalId: worktree.localId,
          ),
        ],
        if (_provisionalStandaloneChatId case final id?)
          vm.standaloneChatById(id)?.displayTitle,
      ],
    );
    final worktree = _worktree;
    final summaries = _tabRows(viewModel);
    final chatId = _chatIdFor(summaries);
    final chatsLoading =
        worktree != null &&
        _createdWorktree == null &&
        summaries.isEmpty &&
        viewModel.isWorktreeChatsLoading(
          workspaceLocalId: worktree.workspaceLocalId,
          worktreeLocalId: worktree.localId,
        );
    final chatDiscoveryFailed =
        worktree != null &&
        summaries.isEmpty &&
        viewModel.foregroundChatError(
              worktree.workspaceLocalId,
              worktree.localId,
            ) !=
            null;
    final boundSummary = summaries.where((s) => s.chatId == chatId).firstOrNull;
    return CanopyScaffold(
      scaffoldKey: _scaffoldKey,
      onEndDrawerChanged: (isOpen) {
        if (!isOpen || worktree == null) return;
        // Refresh on every opening, including the edge swipe that bypasses
        // the app-bar button. Foreground chat hydration omits these slices.
        viewModel.refreshChangedFiles(
          workspaceLocalId: worktree.workspaceLocalId,
          worktreeLocalId: worktree.localId,
        );
      },
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        // Shell destinations use the menu; pushed routes keep their back button.
        leading: HomeMenuButton.maybeOf(context, designSystem: true),
        content: Text(
          worktree == null && !_worktreeProvisioning
              ? _title
              : boundSummary?.displayTitle ??
                    (chatsLoading || chatDiscoveryFailed ? 'Chat' : 'New chat'),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        // A worktree chat is subtitled by its branch; a chat being created
        // in place shows its workspace until that branch exists. Either way
        // it leads with the computer it runs on (CAN-2932).
        subtitle: _locationSubtitle(switch ((worktree, widget.workspace)) {
          (final RemoteWorktree _, _) => _title,
          (null, final RemoteWorkspace workspace) => workspace.name,
          _ => null,
        }, viewModel.connection?.deviceLabel),
        trailing: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            if (worktree != null)
              CanopyIconButton(
                key: const ValueKey('open-activity'),
                glyph: CanopyGlyph.sidebar,
                tooltip: 'Activity & files',
                onPressed: () {
                  _scaffoldKey.currentState?.openEndDrawer();
                },
              )
            else if (!_worktreeProvisioning)
              CanopyIconButton(
                key: const ValueKey('open-workspace-panel'),
                glyph: CanopyGlyph.sidebar,
                tooltip: 'Project',
                onPressed: () => _scaffoldKey.currentState?.openEndDrawer(),
              ),
          ],
        ),
      ),
      endDrawer: _worktreeProvisioning
          ? null
          : Builder(
              builder: (context) {
                final viewModel = context.read<RemoteControlViewModel>();
                // Also after a session reset while the drawer stays open.
                if (worktree != null) {
                  viewModel.ensureChangedFiles(
                    workspaceLocalId: worktree.workspaceLocalId,
                    worktreeLocalId: worktree.localId,
                  );
                }
                context.select<RemoteControlViewModel, List<Object?>>(
                  (vm) => _drawerInputs(vm, worktree),
                );
                // The route's worktree is its navigation identity. Status and
                // runtime flags must follow the same live row as the list.
                final liveWorktree = worktree == null
                    ? null
                    : viewModel
                              .worktreesFor(worktree.workspaceLocalId)
                              .where((row) => row.localId == worktree.localId)
                              .firstOrNull ??
                          worktree;
                return worktree != null
                    ? RemoteActivitySidebar(
                        worktree: liveWorktree!,
                        activity: viewModel.worktreeActivityFor(
                          worktree.localId,
                        ),
                        prProgress: viewModel.prProgressFor(
                          worktree.workspaceLocalId,
                          worktree.localId,
                        ),
                        cachedPrRepos: viewModel.cachedPrReposFor(
                          worktree.workspaceLocalId,
                          worktree.localId,
                        ),
                        cachedPrBusy: viewModel.cachedPrBusyFor(
                          worktree.workspaceLocalId,
                          worktree.localId,
                        ),
                        runPrAction: !viewModel.supportsPrActions
                            ? null
                            : (
                                action, {
                                repoId,
                                identity,
                                confirmUnresolvedComments = false,
                              }) => viewModel.runPrAction(
                                worktree,
                                action,
                                repoId: repoId,
                                identity: identity,
                                confirmUnresolvedComments:
                                    confirmUnresolvedComments,
                              ),
                        changedFilesStatus: viewModel.changedFilesStatus(
                          worktree.localId,
                        ),
                        onRetryChangedFiles: () =>
                            viewModel.refreshChangedFiles(
                              workspaceLocalId: worktree.workspaceLocalId,
                              worktreeLocalId: worktree.localId,
                            ),
                        selectedChatId: chatId,
                        onSetHookPaused: (hookKey, paused) => unawaited(
                          _runRemoteAction(
                            viewModel.setHooksPaused(
                              workspaceLocalId: worktree.workspaceLocalId,
                              worktreeLocalId: worktree.localId,
                              paused: paused,
                              hookKey: hookKey,
                            ),
                          ),
                        ),
                      )
                    : StandaloneWorkspacePanel(
                        workspaceName: viewModel.workspaces
                            .where(
                              (w) =>
                                  w.localId == _standaloneChat?.projectLocalId,
                            )
                            .firstOrNull
                            ?.name,
                      );
              },
            ),
      body: Builder(
        builder: (context) {
          // Chrome inputs only; the bound chat's own state arrives through
          // its notifier below.
          context.select<RemoteControlViewModel, List<Object?>>(
            (vm) => _bodyChrome(vm, worktree, chatId),
          );
          return ListenableBuilder(
            listenable: Listenable.merge([?_chatChanges, ?_activity]),
            // Named so profile traces can count chat body builds (CAN-3428).
            builder: (context, _) => Timeline.timeSync(
              'RemoteChatBody.build',
              () => _buildChatBody(
                context,
                viewModel,
                worktree,
                chatId,
                summaries,
                chatsLoading,
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _buildChatBody(
    BuildContext context,
    RemoteControlViewModel viewModel,
    RemoteWorktree? worktree,
    String? chatId,
    List<RemoteChatSummary> tabMembership,
    bool chatsLoading,
  ) {
    // Membership includes optimistic tabs from the screen. Read live summary
    // fields here so timers, queue/model changes and unread badges can update
    // without rerunning membership reconciliation or rebuilding the app bar.
    final liveSummaries = {
      if (worktree != null)
        for (final summary in viewModel.chatSummariesFor(
          workspaceLocalId: worktree.workspaceLocalId,
          worktreeLocalId: worktree.localId,
        ))
          summary.chatId: summary,
    };
    final summaries = [
      for (final summary in tabMembership)
        liveSummaries[summary.chatId] ?? summary,
    ];
    final isProvisionalNewChat = chatId != null && _tabs.isPending(chatId);
    final target = chatId == null ? null : _target(chatId);
    final pendingQuestions = target == null
        ? const <AskUserQuestionState>[]
        : viewModel.pendingQuestionsFor(target);
    final messages = target == null
        ? const <RemoteChatMessage>[]
        : viewModel.messagesFor(target);
    // An accepted send whose turn has not surfaced in any projection yet
    // still counts as running, so the indicator cannot briefly flap to idle.
    final awaitingTurn =
        target != null && viewModel.isAwaitingAgentTurn(target);
    // Use the desktop's per-chat signal even before its transcript is loaded.
    // Older desktops fall back to per-chat transcript state.
    final boundSummary = summaries.where((s) => s.chatId == chatId).firstOrNull;
    final queuedMessages =
        boundSummary?.queuedMessages ?? const <RemoteQueuedMessage>[];
    final isRunning =
        awaitingTurn ||
        boundSummary?.turnActive == true ||
        (target != null && viewModel.isStreamingForChat(target));
    final connectionStatus = viewModel.portalConnectionStatus;
    final linkState = viewModel.linkState;
    final showReconnecting = RemoteDegradedBanner.shows(
      status: connectionStatus,
      linkState: linkState,
    );
    // While the worktree's chat tabs (or the selected chat's transcript) are
    // still round-tripping to the desktop, an empty list means "loading",
    // not "no chats/messages yet".
    // A worktree this screen just created is known to have no chats, so its
    // hydration round trip must not flash the title or hold the composer.
    final transcriptLoading =
        chatId != null &&
        messages.isEmpty &&
        target != null &&
        viewModel.isChatTranscriptLoading(target);
    final hydrationError = target == null
        ? null
        : viewModel.chatHydrationError(target);
    final discoveryError = worktree == null || chatId != null
        ? null
        : viewModel.foregroundChatError(
            worktree.workspaceLocalId,
            worktree.localId,
          );

    // Computed for the composer. Feedback intentionally does not reuse its
    // live provider/model for historical turns; those values are not carried
    // per message on the portal wire.
    final composerControls = _composerControls(
      viewModel: viewModel,
      chatId: chatId,
      summaries: summaries,
      isRunning: isRunning,
    );
    final showTabsFab = worktree != null && summaries.isNotEmpty;

    // Awaiting questions render as the tail of the transcript, below the
    // agent's last row, so they scroll with the conversation instead of
    // occupying a fixed shelf between the feed and the composer.
    final questionCards = <Widget>[
      if (target case final RemoteWorktreeChatTarget worktreeTarget)
        for (final request in pendingQuestions)
          PendingQuestionCard(
            key: ValueKey('question-${request.requestId}'),
            request: request,
            onSubmit: (answers) => unawaited(
              _runRemoteAction(
                viewModel.answerQuestion(
                  worktreeTarget,
                  requestId: request.requestId,
                  answers: answers,
                ),
              ),
            ),
            onDismiss: () => unawaited(
              _runRemoteAction(
                viewModel.dismissQuestion(
                  worktreeTarget,
                  requestId: request.requestId,
                ),
              ),
            ),
          ),
    ];
    // Questions arrive on the chat summary, independently of the transcript
    // round trip, so they can open the feed before any history has landed.
    // Pin the transcript's own loading/failure state above the feed instead
    // of presenting the question as the whole conversation. Question cards
    // can outgrow the screen, and the feed opens on its newest row, so a
    // status row inside the feed would scroll out of view with its Retry.
    final transcriptStatus = messages.isNotEmpty || questionCards.isEmpty
        ? null
        : transcriptLoading
        ? const ChatTranscriptLoading(
            key: ValueKey('transcript-status-loading'),
            label: 'Loading conversation…',
          )
        : (hydrationError != null && target != null)
        ? _TranscriptHydrationError(
            key: const ValueKey('transcript-status-error'),
            message: hydrationError,
            onRetry: () => viewModel.retryChatTranscript(target),
          )
        : null;
    final trailingRows = <Widget>[
      if (queuedMessages.isNotEmpty)
        QueuedMessagesStatus(count: queuedMessages.length),
      ...questionCards,
    ];

    // Pinned connection/error notices stay below the chrome. Otherwise the
    // feed owns the top inset so its viewport can extend behind the app bar.
    final hasFeed =
        (messages.isNotEmpty || trailingRows.isNotEmpty || isRunning) &&
        chatId != null;
    final showHydrationBanner =
        hasFeed && hydrationError != null && transcriptStatus == null;
    final hasPinnedBanner =
        showReconnecting ||
        viewModel.commandFailureMessage != null ||
        transcriptStatus != null ||
        showHydrationBanner;
    final Widget transcriptArea;
    if (hasFeed) {
      transcriptArea = Builder(
        builder: (context) => AttachmentThumbnailScope(
          thumbnails: viewModel.attachmentThumbnails,
          child: ChatFeed(
            topContentInset: hasPinnedBanner
                ? 0
                : CanopyScaffold.contentPaddingOf(context).top,
            chatId: chatId,
            bottomActionInset: showTabsFab
                ? CanopyOverlayAction.stackOffset
                : 0,
            messages: messages,
            forkEnabled: viewModel.isConnected && !showReconnecting,
            onForkResponse: target is! RemoteWorktreeChatTarget
                ? null
                : (response) async {
                    final generation = viewModel.sessionGeneration;
                    final destination = await forkRemoteResponse(
                      viewModel,
                      target,
                      response.turnKey,
                    );
                    if (!mounted ||
                        generation != viewModel.sessionGeneration ||
                        _chatIdFor(_tabRows(viewModel)) != response.chatId) {
                      return;
                    }
                    unawaited(_voice.abandon());
                    _switchDraftTarget(_draftTargetFor(destination));
                    _tabs.select(destination);
                  },
            expandedTurns: _expandedTurns,
            turnInProgress: isRunning,
            onToggleTurn: (key) => setState(() {
              if (!_expandedTurns.remove(key)) _expandedTurns.add(key);
            }),
            onLoadOlder: target == null
                ? null
                : () => unawaited(viewModel.loadOlderMessages(target)),
            loadingOlder:
                target != null && viewModel.isLoadingOlderMessages(target),
            trailing: trailingRows,
            turnFooters: pipelineRunAgentActivityFooters(
              context,
              controller: _activity,
              chatId: chatId,
              messages: messages,
            ),
            onResend: (messageId) =>
                unawaited(viewModel.resendUnsent(messageId)),
            onDiscard: viewModel.discardUnsent,
          ),
        ),
      );
    } else if (_worktreeProvisioning && _createError != null) {
      transcriptArea = ChatCreationFailed(
        message: _createError ?? "Couldn't create the worktree.",
        onRetry: () => unawaited(_createWorktree()),
      );
    } else if (_worktreeProvisioning) {
      transcriptArea = ChatTranscriptLoading(
        label: _worktreeCreateLabel(viewModel),
        labelKey: const ValueKey('creating-worktree-status'),
      );
    } else if (chatsLoading) {
      transcriptArea = const ChatTranscriptLoading(label: 'Loading chats…');
    } else if (transcriptLoading) {
      transcriptArea = const ChatTranscriptLoading(
        label: 'Loading conversation…',
      );
    } else if (discoveryError != null && worktree != null) {
      transcriptArea = _TranscriptHydrationError(
        message: discoveryError,
        onRetry: () => viewModel.retryForegroundChat(
          worktree.workspaceLocalId,
          worktree.localId,
        ),
      );
    } else if (hydrationError != null && target != null) {
      transcriptArea = _TranscriptHydrationError(
        message: hydrationError,
        onRetry: () => viewModel.retryChatTranscript(target),
      );
    } else {
      transcriptArea = ChatEmptyTranscript(
        isNewChat: chatId == null,
        composingNew: isProvisionalNewChat,
      );
    }

    final canSend =
        !(chatId == null && (chatsLoading || discoveryError != null)) &&
        !_worktreeProvisioning;
    widget.firstSend?.sendWhenReady(
      ready: () =>
          canSend &&
          !_sending &&
          widget.isActive &&
          (_attachments?.canSend ?? true),
      send: () {
        if (mounted) {
          unawaited(_send(_viewModel, _chatIdFor(_tabRows(_viewModel))));
        }
      },
    );

    return SatisfactionPromptHost(
      surface: SatisfactionSurface.remoteChat,
      isQuiet:
          widget.isActive &&
          target != null &&
          messages.isNotEmpty &&
          !isRunning &&
          // A send the desktop has not accepted yet: the post-send "awaiting
          // the agent" bridge can lapse while the request is still open.
          !_sending &&
          !showReconnecting &&
          viewModel.commandFailureMessage == null &&
          hydrationError == null &&
          discoveryError == null &&
          pendingQuestions.isEmpty,
      child: Builder(
        builder: (context) => Padding(
          padding: CanopyScaffold.contentPaddingOf(context).copyWith(
            top: hasPinnedBanner || !hasFeed
                ? CanopyScaffold.contentPaddingOf(context).top
                : 0,
          ),
          child: Column(
            children: [
              if (showReconnecting)
                RemoteDegradedBanner(
                  status: connectionStatus,
                  linkState: linkState,
                  deviceLabel: viewModel.connection?.deviceLabel,
                ),
              if (viewModel.commandFailureMessage case final message?)
                CommandFailureBanner(
                  message: message,
                  onDismiss: viewModel.clearCommandFailure,
                ),
              ?transcriptStatus,
              if (showHydrationBanner && target != null)
                TranscriptHydrationBanner(
                  message: hydrationError,
                  onRetry: () => viewModel.retryChatTranscript(target),
                  onDismiss: () => viewModel.dismissChatHydrationError(target),
                ),
              Expanded(
                child: ChatBody(
                  minimumTranscriptHeight: showTabsFab
                      ? CanopyScaffold.contentPaddingOf(context).top +
                            CanopyOverlayAction.stackOffset
                      : 0,
                  transcript: Stack(
                    children: [
                      Positioned.fill(child: transcriptArea),
                      if (showTabsFab)
                        Positioned(
                          right: CanopyOverlayAction.gutter,
                          // The composer's own top padding supplies the bottom
                          // gutter, so the button lines up with the composer's
                          // right edge on the same 8px grid.
                          bottom: 0,
                          child: ChatTabsFab(
                            hasUnread: summaries.any(
                              (s) => s.hasUnread == true,
                            ),
                            needsAnswer: viewModel.worktreeNeedsAnswer(
                              worktree,
                            ),
                            onPressed: () => unawaited(
                              showChatTabsSheet(
                                context,
                                summaries: summaries,
                                selectedChatId: chatId,
                                // Resolved on every notification instead of
                                // captured here, so an open sheet follows turns
                                // starting and finishing, unread output, and
                                // questions arriving.
                                chatState: viewModel,
                                resolveLiveState: () => _chatTabsLiveState(
                                  viewModel,
                                  worktree,
                                  summaries,
                                ),
                                onSelect: (id) {
                                  if (id != chatId) unawaited(_voice.abandon());
                                  _switchDraftTarget(_draftTargetFor(id));
                                  _tabs.select(id);
                                },
                                onNewChat: () => _startNewChat(worktree),
                                onClose: (id) => _closeChatTab(worktree, id),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                  composer: ChatInput(
                    attachedHeader: target is RemoteWorktreeChatTarget
                        ? RemoteBackgroundTray(target: target, active: _isShown)
                        : null,
                    controller: _composer,
                    sending: _sending,
                    // While the worktree's chat tabs are still hydrating we don't yet
                    // know the active chat id; sending now would mint a phantom new
                    // chat the desktop echoes to an id this screen isn't showing. Hold
                    // the composer until the tabs resolve. A worktree that genuinely
                    // has no chats (not loading) still sends to mint its first one.
                    // Likewise while the worktree is still being created: the
                    // draft field stays open, only the send action waits.
                    enabled: canSend,
                    voiceEnabled:
                        !(chatId == null &&
                            (chatsLoading || discoveryError != null)),
                    actionsEnabled:
                        !(chatId == null &&
                            (chatsLoading || discoveryError != null)),
                    hintText: _worktreeProvisioning
                        ? 'Message the agent…'
                        : null,
                    controls: composerControls,
                    commands: remoteComposerCommandSource(
                      viewModel.repository.composerCommands,
                      worktree: worktree,
                      chatId: chatId,
                      providerType: composerControls?.providerType,
                      sessionGeneration: () => viewModel.sessionGeneration,
                      pluginSelections: () => switch (chatId) {
                        null => null,
                        final id when worktree == null =>
                          viewModel
                              .standaloneChatById(id)
                              ?.pluginSelectionsDetail,
                        final id => _summaryFor(
                          _projectedSummaries(viewModel),
                          id,
                        )?.pluginSelectionsDetail,
                      },
                      standaloneProjectLocalId:
                          worktree != null || chatId == null
                          ? null
                          : viewModel
                                .standaloneChatById(chatId)
                                ?.projectLocalId,
                    ),
                    plugins: worktree == null
                        ? remoteStandalonePluginsSource(
                            commands: viewModel.repository.composerCommands,
                            overrides: _composerOverrides,
                            chatId: chatId,
                            providerType: composerControls?.providerType,
                            standaloneChat: viewModel.standaloneChatById,
                          )
                        : remoteComposerPluginsSource(
                            commands: viewModel.repository.composerCommands,
                            overrides: _composerOverrides,
                            chats: _composerChat,
                            worktree: worktree,
                            chatId: chatId,
                            providerType: (id) => _composerControls(
                              viewModel: viewModel,
                              chatId: id,
                              summaries: _projectedSummaries(viewModel),
                              isRunning: false,
                            )?.providerType,
                            summary: (id) =>
                                _summaryFor(_projectedSummaries(viewModel), id),
                          ),
                    planMode: worktree == null
                        ? null
                        : PlanModeControl(
                            enabled: false,
                            onToggle: () => unawaited(
                              _runRemoteAction(
                                _composerChat.change(
                                  worktree,
                                  ComposerField.planMode,
                                  true,
                                ),
                              ),
                            ),
                          ),
                    watchers: remoteChatWatchersChip(
                      context,
                      viewModel: viewModel,
                      worktree: worktree,
                      chatId: chatId,
                      promptOpen: pendingQuestions.isNotEmpty,
                    ),
                    voice: _voice,
                    attachments: switch (_attachments) {
                      final attachments? => ChatInputAttachments(
                        listenable: attachments,
                        strip: AttachmentStrip(controller: attachments),
                        hasAttachments: () => attachments.drafts.isNotEmpty,
                        canAdd: () =>
                            attachments.drafts.length <
                            kChatAttachmentsMaxPerMessage,
                        canSend: () => attachments.canSend,
                        onAttach: (source) => unawaited(_onAttach(source)),
                      ),
                      null => null,
                    },
                    attachmentsUnavailableReason: switch (_attachments) {
                      null
                          when _worktree == null &&
                              _standaloneChat != null &&
                              viewModel.supportsChatAttachments &&
                              !viewModel.supportsStandaloneChatCreate =>
                        kStandaloneAttachmentsNeedDesktopUpdate,
                      _? when !_attachmentsAvailable(viewModel) =>
                        kAttachmentsNeedReconnect,
                      _ => null,
                    },
                    onSend: () => _send(viewModel, chatId),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TranscriptHydrationError extends StatelessWidget {
  const _TranscriptHydrationError({
    super.key,
    required this.message,
    required this.onRetry,
  });

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // Scrolls when the composer's suggestion list leaves a short transcript.
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, color: theme.colorScheme.error, size: 32),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            FilledButton.tonal(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}
