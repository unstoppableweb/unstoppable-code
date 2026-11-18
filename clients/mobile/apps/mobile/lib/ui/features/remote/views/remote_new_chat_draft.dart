import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_context_scope.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/services/speech_recognizer.dart';
import 'package:mobile/services/speech_to_text_recognizer.dart';
import 'package:mobile/ui/core/chat/view_models/new_chat_draft_carry.dart';
import 'package:mobile/ui/core/chat/view_models/voice_dictation_controller.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/chat/widgets/chat_body.dart';
import 'package:mobile/ui/core/chat/widgets/chat_location_subtitle.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';
import 'package:mobile/ui/core/chat/widgets/draft_option_sheet.dart';
import 'package:mobile/ui/core/chat/widgets/new_chat_draft_header.dart';
import 'package:mobile/ui/core/chat/widgets/new_chat_draft_pill.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/chat/view_models/composer_draft_binding.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/core/chat/widgets/voice_dictation_dialog.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_draft_composer.dart';
import 'package:provider/provider.dart';

/// The worktree pill's choice that creates a fresh worktree.
const String _newWorktreeId = '';

/// A new chat on the paired computer before its first send (CAN-2932): the
/// host's project pill and, for code projects, a worktree pill above a
/// composer ready to type, with the desktop's model, thinking, Fast and (for
/// code projects) Plan controls, as on web.
///
/// Nothing is created here. Sending hands the project and the worktree to
/// branch from to [onStart], and the host opens `RemoteChatScreen.create`,
/// which creates the worktree or standalone chat the project calls for and
/// sends this draft. The draft is saved under the project's new-chat target,
/// where that screen reads it.
class RemoteNewChatDraft extends StatefulWidget {
  const RemoteNewChatDraft({
    super.key,
    required this.computerName,
    required this.projectPill,
    required this.carry,
    required this.onStart,
    this.unavailableMessage,
    this.onReconnect,
    this.speechRecognizer,
    this.isActive = true,
  });

  /// The computer this draft runs on, named in the header.
  final String computerName;

  final bool isActive;

  /// The host's project selector, which lists every destination's projects.
  final DraftProjectPillBuilder projectPill;

  /// Brings in a draft typed for another destination, and hands this one
  /// over when the destination changes.
  final NewChatDraftCarry carry;

  /// Starts the chat in the chosen project, branching a code project's new
  /// worktree from the given worktree when it is not null, and sending the
  /// composer selections with the first message.
  final void Function(
    RemoteWorkspace workspace,
    String? baseWorktreeId,
    RemoteChatSendOptions? sendOptions,
  )
  onStart;

  /// Why the computer cannot take the chat now, such as being offline. Send
  /// is held while it is set.
  final String? unavailableMessage;

  /// Asks the server for the computer's state again; null hides Reconnect.
  final VoidCallback? onReconnect;

  /// Speech engine behind the composer mic. Null uses the `speech_to_text`
  /// plugin; tests inject a scripted recognizer.
  final SpeechRecognizer? speechRecognizer;

  @override
  State<RemoteNewChatDraft> createState() => _RemoteNewChatDraftState();
}

class _RemoteNewChatDraftState extends State<RemoteNewChatDraft>
    with WidgetsBindingObserver {
  final TextEditingController _composer = TextEditingController();
  late final ComposerDraftBinding _drafts;
  late final ChatDraftStore _draftStore;
  late final VoiceDictationController _voice;

  /// Project picked here; null falls back to the carried or the first one.
  String? _pickedWorkspaceId;

  /// The project name carried from another destination. When it matches no
  /// project here, no project is selected until the user picks one.
  String? _carriedProjectName;
  bool _carried = false;
  String? _lastProjectName;

  /// The worktree a code project's new worktree branches from; null starts
  /// a new worktree. Cleared when the project changes.
  String? _baseWorktreeId;

  /// Model, thinking, Fast and Plan as the user set them here.
  RemoteDraftComposerChoices _choices = const RemoteDraftComposerChoices();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _draftStore = maybeChatDraftStore(context) ?? InMemoryChatDraftStore();
    _drafts = ComposerDraftBinding(controller: _composer, store: _draftStore);
    if (widget.carry.take() case final carried?) {
      _carried = true;
      _carriedProjectName = carried.projectName;
      _pickedWorkspaceId = carried.projectId;
      _composer.text = carried.text;
    }
    widget.carry.attach(_handOver);
    // The model catalog is carried by the desktop's chats; make sure their
    // summaries are loaded. Post-frame: hydration notifies synchronously.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        context.read<RemoteControlViewModel>().ensureChatSummariesIndex();
      }
    });
    _voice = VoiceDictationController(
      draft: _composer,
      recognizer: widget.speechRecognizer ?? SpeechToTextRecognizer(),
    )..addListener(_onVoiceChanged);
  }

  @override
  void didUpdateWidget(RemoteNewChatDraft oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.isActive && !widget.isActive) {
      unawaited(_voice.abandon());
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      unawaited(_voice.abandon());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.carry.detach(_handOver);
    _voice.removeListener(_onVoiceChanged);
    unawaited(_voice.abandon());
    _voice.dispose();
    _drafts.dispose();
    _composer.dispose();
    super.dispose();
  }

  CarriedDraft _handOver() {
    unawaited(_voice.abandon());
    final carried = (
      text: _composer.text,
      projectName: _workspace(_workspaces())?.name ?? _lastProjectName,
      projectId: null,
    );
    widget.carry.preserveSource(_drafts.retainForHandoff());
    return carried;
  }

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

  /// The computer's projects in the selected workspace context (CAN-4429).
  List<RemoteWorkspace> _workspaces() {
    final remote = context.read<RemoteControlViewModel>();
    return RemoteContextScope(
      context.read<WorkspaceContext?>(),
      remote.workspaces,
    ).workspaces;
  }

  /// The draft's project: the one picked here, else the carried project's
  /// namesake, else the first. A carried project with no namesake selects
  /// nothing, so the chat cannot start in a project the user did not choose.
  RemoteWorkspace? _workspace(List<RemoteWorkspace> workspaces) {
    if (_pickedWorkspaceId case final id?) {
      final picked = workspaces.where((w) => w.localId == id).firstOrNull;
      if (picked != null) return picked;
    }
    if (!_carried) return workspaces.firstOrNull;
    final name = _carriedProjectName?.toLowerCase();
    if (name == null) return null;
    return workspaces.where((w) => w.name.toLowerCase() == name).firstOrNull;
  }

  /// Saves the composer under the project's new-chat target, keeping text
  /// typed before the project was known.
  void _syncDraftTarget(RemoteWorkspace? workspace) {
    if (workspace == null) return;
    final target = RemoteNewChatDraftTarget(workspace.localId);
    widget.carry.adoptStored(_drafts, target, _draftStore);
  }

  void _selectWorkspace(String id) {
    if (!mounted || id == _pickedWorkspaceId) return;
    setState(() {
      _pickedWorkspaceId = id;
      _baseWorktreeId = null;
    });
  }

  /// The worktrees a code project's new worktree can branch from, like
  /// web's "Branch from"; null for a project without worktrees of its own.
  List<RemoteWorktree>? _branchSources(
    RemoteControlViewModel remote,
    RemoteWorkspace? workspace,
  ) {
    if (workspace == null ||
        workspace.resolvedLayout == RemoteWorkspaceLayout.flat) {
      return null;
    }
    return remote.worktreesFor(workspace.localId);
  }

  static String _worktreeLabel(RemoteWorktree worktree) {
    final label = worktree.label;
    return label != null && label.isNotEmpty ? label : worktree.branch;
  }

  Future<void> _pickBaseWorktree(List<RemoteWorktree> worktrees) async {
    final colors = AppColors.of(context);
    final icon = CanopyIcon(
      glyph: CanopyGlyph.branch,
      size: 14,
      tint: colors.foregroundSecondary,
    );
    final id = await showDraftOptionSheet(
      context,
      title: 'Start from',
      keyPrefix: 'remote-new-chat-worktree',
      selectedId: _baseWorktreeId ?? _newWorktreeId,
      options: [
        (id: _newWorktreeId, name: 'New worktree', icon: icon, subtitle: null),
        for (final worktree in worktrees)
          (
            id: worktree.localId,
            name: 'Branch from ${_worktreeLabel(worktree)}',
            icon: icon,
            subtitle: null,
          ),
      ],
    );
    if (id == null || !mounted) return;
    setState(() => _baseWorktreeId = id == _newWorktreeId ? null : id);
  }

  /// The worktree whose chats seed a code project's composer: the one the
  /// new worktree branches from, else the project's first, as on web.
  static RemoteWorktree? _referenceWorktree(
    List<RemoteWorktree>? sources,
    String? baseWorktreeId,
  ) {
    if (sources == null) return null;
    return sources.where((w) => w.localId == baseWorktreeId).firstOrNull ??
        sources.firstOrNull;
  }

  /// The composer for [workspace]: the user's choices over its reference
  /// chat's settings and the desktop's catalog.
  RemoteDraftComposer _composerFor(
    RemoteControlViewModel remote,
    RemoteWorkspace? workspace,
    List<RemoteWorktree>? sources,
  ) {
    final cowork = workspace != null && sources == null;
    final RemoteDraftReference? reference;
    if (workspace == null) {
      reference = null;
    } else if (cowork) {
      reference = remoteDraftCoworkReference(
        remote.standaloneChatsFor(workspace.localId),
      );
    } else {
      reference = remoteDraftWorktreeReference(
        remote.allChatSummaries,
        workspaceLocalId: workspace.localId,
        worktreeLocalId: _referenceWorktree(sources, _baseWorktreeId)?.localId,
      );
    }
    final catalog = remoteDraftModelCatalog(
      reference: reference,
      projected: remote.projectedModelCatalog,
      projectedAvailability: remote.projectedProviderAvailability,
      standaloneChats: remote.allStandaloneChats,
    );
    return RemoteDraftComposer(
      choices: _choices,
      reference: reference,
      catalog: catalog.models,
      availability: catalog.availability,
      cowork: cowork,
    );
  }

  /// Loads the reference worktree's chats, once per worktree, so its
  /// settings can seed the composer.
  void _hydrateReference(RemoteWorkspace? workspace, RemoteWorktree? worktree) {
    if (workspace == null || worktree == null) return;
    final key = '${workspace.localId}/${worktree.localId}';
    if (key == _hydratedReference) return;
    _hydratedReference = key;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      context.read<RemoteControlViewModel>().ensureWorktreeState(
        workspaceLocalId: workspace.localId,
        worktreeLocalId: worktree.localId,
      );
    });
  }

  String? _hydratedReference;

  /// The composer's model, thinking, Fast and (for code projects) Plan
  /// controls, seeded from the reference chat. They change only this draft;
  /// the first send carries them. Each control updates from the current
  /// choices, so taps landing in one frame do not undo each other.
  ComposerControlsData _controls(RemoteDraftComposer composer) {
    final withChoices = composer.withChoices;
    final effort = composer.effort;
    void update(
      RemoteDraftComposerChoices Function(RemoteDraftComposerChoices) change,
    ) => setState(() => _choices = change(_choices));
    return ComposerControlsData(
      providerType: composer.providerType,
      modelLabel: composer.modelLabel,
      selectedModelId: composer.modelId ?? composer.selectedModel?.id,
      executionHarness: composer.selectedModel?.harness,
      availableModels: composer.catalog,
      providerAvailability: composer.availability,
      planMode: composer.cowork
          ? null
          : PlanModeControl(
              enabled: composer.planMode,
              onToggle: () => update(
                (current) =>
                    current.copyWith(planMode: !withChoices(current).planMode),
              ),
            ),
      effort: effort.levels.isEmpty
          ? null
          : EffortControl(
              level: effort.level,
              levels: effort.levels,
              onSelect: (level) async {
                update((current) => current.copyWith(thinkingLevel: level));
                return true;
              },
            ),
      speed: effort.speed,
      supportsFastMode: composer.providerType == 'codex',
      isRunning: false,
      catalogStatus: composer.catalog.isEmpty
          ? ModelCatalogStatus.absent
          : ModelCatalogStatus.loaded,
      emptyCatalogHint: 'Check model settings in the desktop app.',
      onSelectModel: (id, {executionHarness}) => update(
        (current) =>
            current.copyWith(model: id, executionHarness: executionHarness),
      ),
      onToggleFast: () => update(
        (current) => current.copyWith(fastMode: !withChoices(current).fastMode),
      ),
      // Nothing runs before the first send.
      onStop: () {},
    );
  }

  void _send(
    RemoteWorkspace workspace,
    List<RemoteWorktree>? sources,
    RemoteDraftComposer composer,
  ) {
    if (_composer.text.trim().isEmpty) return;
    final dictated = _voice.dictated;
    unawaited(_voice.abandon());
    _syncDraftTarget(workspace);
    final base = _baseWorktreeId;
    widget.onStart(
      workspace,
      sources != null && sources.any((w) => w.localId == base) ? base : null,
      composer.sendOptions(inputMode: dictated ? 'voice' : null),
    );
  }

  @override
  Widget build(BuildContext context) {
    final remote = context.watch<RemoteControlViewModel>();
    final workspaces = RemoteContextScope(
      context.watch<WorkspaceContext?>(),
      remote.workspaces,
    ).workspaces;
    final workspace = _workspace(workspaces);
    if (workspace != null) _lastProjectName = workspace.name;
    if (workspace != null &&
        _drafts.target != RemoteNewChatDraftTarget(workspace.localId)) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _syncDraftTarget(_workspace(_workspaces()));
      });
    }
    final loading =
        workspaces.isEmpty && (remote.isSyncing || !remote.isConnected);
    final unavailable = widget.unavailableMessage;
    final sources = _branchSources(remote, workspace);
    _hydrateReference(workspace, _referenceWorktree(sources, _baseWorktreeId));
    final composer = _composerFor(remote, workspace, sources);
    final base = sources
        ?.where((worktree) => worktree.localId == _baseWorktreeId)
        .firstOrNull;
    final colors = AppColors.of(context);
    final Widget body;
    if (loading) {
      body = const _DraftPrompt(
        key: ValueKey('remote-new-chat-loading'),
        text: 'Loading projects…',
      );
    } else if (workspaces.isEmpty) {
      body = const _DraftPrompt(
        key: ValueKey('remote-new-chat-no-projects'),
        text: 'Add a project on this computer to start a chat.',
      );
    } else if (workspace == null) {
      body = const _DraftPrompt(
        key: ValueKey('remote-new-chat-choose-project'),
        text: 'Choose a project to start.',
      );
    } else {
      body = const _DraftPrompt(
        key: ValueKey('remote-new-chat-prompt'),
        text: 'What would you like to do?',
      );
    }
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        leading: HomeMenuButton.maybeOf(context, designSystem: true),
        content: const NewChatDraftHeader(title: 'New chat'),
        subtitle: ChatLocationSubtitle(
          glyph: CanopyGlyph.macbook,
          location: 'Chat on ${widget.computerName}',
          text: widget.computerName,
        ),
      ),
      body: Builder(
        builder: (context) => Padding(
          key: const ValueKey('remote-new-chat-screen'),
          padding: CanopyScaffold.contentPaddingOf(context),
          child: ChatBody(
            transcript: Column(
              children: [
                Expanded(child: body),
                if (unavailable != null)
                  _UnavailableNotice(
                    message: unavailable,
                    onReconnect: widget.onReconnect,
                  ),
              ],
            ),
            composer: ChatInput(
              controller: _composer,
              sending: false,
              enabled: workspace != null && unavailable == null,
              voiceEnabled: true,
              hintText: 'Message the agent…',
              controls: _controls(composer),
              header: Row(
                spacing: 8,
                children: [
                  Flexible(
                    child: widget.projectPill(
                      context,
                      DraftProjectSelection(
                        id: workspace?.localId,
                        name: workspace?.name,
                        icon: CanopyIcon(
                          glyph: CanopyGlyph.folderFilled,
                          size: 14,
                          tint: colors.foregroundSecondary,
                        ),
                        // Open while this computer's projects load: the
                        // list may span computers.
                        enabled: true,
                        select: _selectWorkspace,
                      ),
                    ),
                  ),
                  if (sources != null)
                    Flexible(
                      child: NewChatDraftPill(
                        key: const ValueKey('remote-new-chat-worktree'),
                        icon: CanopyIcon(
                          glyph: CanopyGlyph.branch,
                          size: 16,
                          tint: colors.foregroundSecondary,
                        ),
                        label: base == null
                            ? 'New worktree'
                            : 'Branch from ${_worktreeLabel(base)}',
                        semanticLabel: base == null
                            ? 'Worktree, New worktree'
                            : 'Worktree, Branch from ${_worktreeLabel(base)}',
                        onPressed: () => unawaited(_pickBaseWorktree(sources)),
                      ),
                    ),
                ],
              ),
              voice: _voice,
              onSend: () {
                if (workspace != null) _send(workspace, sources, composer);
              },
            ),
          ),
        ),
      ),
    );
  }
}

class _DraftPrompt extends StatelessWidget {
  const _DraftPrompt({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          text,
          textAlign: TextAlign.center,
          style: AppTypography.heading.copyWith(
            color: AppColors.of(context).foreground,
          ),
        ),
      ),
    );
  }
}

/// Says why the computer cannot take the chat, with Reconnect when the host
/// can ask again.
class _UnavailableNotice extends StatelessWidget {
  const _UnavailableNotice({required this.message, this.onReconnect});

  final String message;
  final VoidCallback? onReconnect;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final onReconnect = this.onReconnect;
    return Padding(
      key: const ValueKey('remote-new-chat-unavailable'),
      padding: const EdgeInsets.fromLTRB(16, 4, 8, 0),
      child: Row(
        children: [
          Expanded(
            child: Text(
              message,
              style: AppTypography.bodySmall.copyWith(
                color: colors.foregroundSecondary,
              ),
            ),
          ),
          if (onReconnect != null)
            TextButton(
              key: const ValueKey('remote-new-chat-reconnect'),
              style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
              onPressed: onReconnect,
              child: const Text('Reconnect'),
            ),
        ],
      ),
    );
  }
}
