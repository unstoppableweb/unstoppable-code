import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';
import 'package:mobile/data/models/effort_speed.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/store.dart';
import 'package:mobile/device_link/worktrees/models.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';
import 'package:mobile/ui/core/chat/widgets/chat_attachment_input.dart';
import 'package:mobile/ui/core/chat/widgets/chat_body.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';
import 'package:mobile/ui/core/chat/widgets/composer_drawer.dart';
import 'package:mobile/ui/core/chat/widgets/draft_option_sheet.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';
import 'package:mobile/ui/core/workspaces/workspace_kind_badge.dart';
import 'controller.dart';
import 'home_model.dart';

/// Home's empty transcript: the prompt heading, centered in the room above
/// the composer, followed by any notices.
class ComputerHomeIntro extends StatelessWidget {
  const ComputerHomeIntro({super.key, this.children = const []});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) => SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          minHeight: (constraints.maxHeight - 32).clamp(0, double.infinity),
        ),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 640),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              spacing: 8,
              children: [
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    "Say what you'd like to get done",
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineLarge,
                  ),
                ),
                ...children,
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

/// Home's composer pinned to the bottom like a chat's, with the project,
/// worktree and base branch pickers in a drawer joined to its top, as on
/// desktop Home.
class ComputerHomeComposer extends StatefulWidget {
  const ComputerHomeComposer({
    super.key,
    required this.controller,
    required this.workspaceContext,
    required this.store,
    required this.draft,
    required this.opening,
    this.pendingDelivery = false,
    this.onCheckDelivery,
    this.notices = const [],
    required this.attachments,
    required this.onStart,
  });
  final ComputerConnectController controller;
  final WorkspaceContext workspaceContext;
  final DeviceLinkStore store;
  final TextEditingController draft;
  final bool opening, pendingDelivery;
  final VoidCallback? onCheckDelivery;

  /// Host notices shown under the heading, before the composer's own.
  final List<Widget> notices;

  /// Files staged for this computer and context. Home owns them, keeping
  /// them alongside the draft while the computer reconnects.
  final ChatAttachmentController attachments;

  /// Starts the chat with the staged files, which upload into it once it
  /// exists.
  final Future<void> Function(ComputerChatHomeModel, ChatAttachmentController)
  onStart;
  @override
  State<ComputerHomeComposer> createState() => ComputerHomeComposerState();
}

class ComputerHomeComposerState extends State<ComputerHomeComposer> {
  late final model = ComputerChatHomeModel(
    widget.controller,
    widget.workspaceContext,
    widget.store,
  );

  ChatAttachmentController get _attachments => widget.attachments;

  @override
  void initState() {
    super.initState();
    unawaited(model.load());
    _attachments.addListener(_onAttachmentsChanged);
    // Android may have killed the app while a picker was open.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_attachments.recoverLostMedia());
    });
  }

  @override
  void didUpdateWidget(ComputerHomeComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (identical(oldWidget.attachments, widget.attachments)) return;
    oldWidget.attachments.removeListener(_onAttachmentsChanged);
    widget.attachments.addListener(_onAttachmentsChanged);
  }

  @override
  void dispose() {
    _attachments.removeListener(_onAttachmentsChanged);
    model.dispose();
    super.dispose();
  }

  /// Surfaces a pick that could not be staged once.
  void _onAttachmentsChanged() {
    final issue = _attachments.takeIssue();
    if (issue == null || !mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(content: Text(chatAttachmentIssueMessage(issue))),
      );
  }

  Future<void> _pick(
    String title,
    String prefix,
    String? selected,
    List<DraftOption> options,
    Future<void> Function(String) select,
  ) async {
    final id = await showDraftOptionSheet(
      context,
      title: title,
      keyPrefix: prefix,
      selectedId: selected,
      options: options,
    );
    if (mounted && id != null) await select(id);
  }

  Widget _glyph(CanopyGlyph glyph) => CanopyIcon(
    glyph: glyph,
    size: 16,
    tint: AppColors.of(context).foregroundMuted,
  );

  Widget _badge(DeviceProject project) => WorkspaceKindBadge(
    type: project.type,
    color: project.color,
    temporary: project.temporary,
  );

  Widget _picker(
    String key,
    String title,
    Widget icon,
    String label,
    VoidCallback? onPressed,
  ) => ComposerContextPicker(
    key: ValueKey(key),
    icon: icon,
    label: label,
    semanticLabel: '$title, $label',
    onPressed: onPressed,
  );

  List<Widget> _pickers(bool enabled) {
    final project = model.project;
    return [
      _picker(
        'home-project',
        'Project',
        project == null ? _glyph(CanopyGlyph.folder1) : _badge(project),
        project?.name ?? 'Choose a project',
        !enabled || model.projects.isEmpty
            ? null
            : () => unawaited(
                _pick('Project', 'home-project', model.projectId, [
                  for (final p in model.projects)
                    (
                      id: p.id,
                      name: p.name,
                      icon: _badge(p),
                      subtitle: p.type == 'cowork' ? 'Cowork' : 'Code',
                    ),
                ], model.selectProject),
              ),
      ),
      if (project != null && project.type != 'cowork') ...[
        _picker(
          'home-worktree',
          'Worktree',
          _glyph(CanopyGlyph.arrowSplitRight),
          model.worktree?.name ?? 'New worktree',
          !enabled
              ? null
              : () => unawaited(
                  _pick(
                    'Worktree',
                    'home-worktree',
                    model.worktreeId ?? ':new',
                    [
                      (
                        id: ':new',
                        name: 'New worktree',
                        icon: _glyph(CanopyGlyph.plusMedium),
                        subtitle: 'Create when you send',
                      ),
                      for (final w in model.worktrees)
                        (
                          id: w.id,
                          name: w.name,
                          icon: _glyph(CanopyGlyph.arrowSplitRight),
                          subtitle: 'Start a new chat here',
                        ),
                    ],
                    (id) => model.selectWorktree(id == ':new' ? null : id),
                  ),
                ),
        ),
        if (model.worktreeId == null && model.branchesSupported)
          _picker(
            'home-base-branch',
            'Base branch',
            _glyph(CanopyGlyph.branch),
            model.baseBranch ?? 'Desktop default branch',
            !enabled || model.branches.isEmpty
                ? null
                : () => unawaited(
                    _pick(
                      'Base branch',
                      'home-base-branch',
                      model.baseBranch,
                      [
                        for (final branch in model.branches)
                          (
                            id: branch,
                            name: branch,
                            icon: _glyph(CanopyGlyph.branch),
                            subtitle: null,
                          ),
                      ],
                      model.selectBranch,
                    ),
                  ),
          ),
      ],
    ];
  }

  List<Widget> _notices() {
    final scope = widget.controller.scopeFor(widget.workspaceContext);
    final online = widget.controller.chats.online;
    return [
      ...widget.notices,
      if (widget.pendingDelivery) ...[
        const InlineNotice(
          glyph: CanopyGlyph.circleInfo,
          state:
              'Delivery is unconfirmed. Check the existing chat before starting another.',
        ),
        CanopyButton(
          label: 'Check delivery',
          variant: CanopyButtonVariant.inline,
          onPressed: widget.opening || widget.controller.scopePending
              ? null
              : widget.onCheckDelivery,
        ),
      ],
      if (widget.controller.error case final error? when online) ...[
        InlineNotice(glyph: CanopyGlyph.circleInfo, state: error),
        CanopyButton(
          label: 'Refresh projects',
          variant: CanopyButtonVariant.inline,
          onPressed: widget.controller.loading
              ? null
              : () => unawaited(widget.controller.refresh()),
        ),
      ],
      if ((model.loading || widget.controller.scopePending) &&
          widget.controller.error == null)
        const Padding(
          padding: EdgeInsets.all(16),
          child: Center(child: LoadingSpinner()),
        ),
      if (scope.hasUnknownOwners)
        const InlineNotice(
          glyph: CanopyGlyph.circleInfo,
          state:
              'Some projects are hidden because their account context could not be verified.',
        ),
      if (online &&
          !model.loading &&
          !widget.controller.scopePending &&
          model.projects.isEmpty)
        const InlineNotice(
          glyph: CanopyGlyph.folder1,
          state:
              'No projects in this context. Add a project on your computer or choose another account context.',
        ),
      if (model.error case final error? when online) ...[
        InlineNotice(glyph: CanopyGlyph.circleInfo, state: error),
        CanopyButton(
          label: 'Try again',
          variant: CanopyButtonVariant.inline,
          onPressed: () => unawaited(model.refreshChoices()),
        ),
      ],
      if (model.saveError case final error?)
        InlineNotice(glyph: CanopyGlyph.circleInfo, state: error),
    ];
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: model,
    builder: (context, _) {
      final enabled =
          widget.controller.chats.online &&
          !widget.opening &&
          !model.loading &&
          !widget.controller.scopePending;
      final effort = model.effort;
      final selected = model.selectedModel;
      final files = chatInputAttachmentsFor(_attachments);
      return ChatBody(
        transcript: ComputerHomeIntro(children: _notices()),
        composer: ChatInput(
          key: const ValueKey('home-composer'),
          controller: widget.draft,
          sending: widget.opening,
          enabled:
              model.canStart &&
              !widget.opening &&
              !widget.pendingDelivery &&
              model.error == null,
          actionsEnabled: !widget.opening,
          voiceEnabled: false,
          onSend: () => unawaited(widget.onStart(model, _attachments)),
          hintText: 'Message the agent…',
          attachedHeader: ComposerDrawerSurface(
            key: const ValueKey('home-context'),
            child: ComposerContextRow(children: _pickers(enabled)),
          ),
          // The first message needs text: files alone keep Send held.
          attachments: ChatInputAttachments(
            listenable: files.listenable,
            strip: files.strip,
            hasAttachments: files.hasAttachments,
            hasSendableAttachments: () => false,
            canAdd: files.canAdd,
            canSend: files.canSend,
            onAttach: files.onAttach,
          ),
          controls: ComposerControlsData(
            providerType: selected?.harness ?? selected?.provider,
            modelLabel: selected?.label ?? 'Desktop default',
            selectedModelId: model.modelId,
            executionHarness: selected?.harness,
            availableModels: model.models,
            providerAvailability: model.providerAvailability,
            effort: effort.levels.isEmpty
                ? null
                : EffortControl(
                    level: effort.level,
                    levels: effort.levels,
                    onSelect: model.selectEffort,
                  ),
            speed: CanopyEffortSpeed.regular,
            supportsFastMode: false,
            isRunning: false,
            onSelectModel: enabled
                ? (id, {executionHarness}) => unawaited(
                    model.selectModel(id, executionHarness: executionHarness),
                  )
                : null,
            onToggleFast: () {},
            onStop: () {},
            catalogStatus: model.loading
                ? ModelCatalogStatus.loading
                : model.error != null
                ? ModelCatalogStatus.failed
                : ModelCatalogStatus.loaded,
            onRetryCatalog: () => unawaited(model.refreshChoices()),
          ),
        ),
      );
    },
  );
}
