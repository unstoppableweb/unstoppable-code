import 'dart:async';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/device_link/chats/delivery.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/device_link/worktrees/models.dart';
import 'package:mobile/ui/core/activity/worktree_activity_context.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_draft.dart';
import 'package:mobile/ui/core/chat/widgets/chat_body.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/chat/widgets/chat_location_subtitle.dart';
import 'package:mobile/ui/core/chat/widgets/chat_provisioning.dart';
import '../chats_screen.dart';
import 'controller.dart';
import 'new_task_model.dart';

/// The same chat-first creation flow as mobile Remote Control. Code projects
/// provision on entry; flat projects create their entry on the first send.
class DeviceNewTaskScreen extends StatefulWidget {
  const DeviceNewTaskScreen({
    super.key,
    required this.controller,
    required this.project,
    this.worktree,
    this.baseBranch,
    this.initialDraft = '',
    this.initialModel,
    this.thinkingLevel,
    this.sendOnOpen = false,
    this.onSent,
    this.delivery,
    this.workspaceContext,
    this.attachments = const [],
    this.onAttachmentsSent,
  });
  final ComputerConnectController controller;
  final DeviceProject project;
  final DeviceWorktree? worktree;
  final String? baseBranch, thinkingLevel;
  final String initialDraft;
  final ModelOption? initialModel;
  final bool sendOnOpen;
  final VoidCallback? onSent;
  final DeviceChatDelivery? delivery;
  final WorkspaceContext? workspaceContext;

  /// See [DeviceNewTaskModel.attachments].
  final List<ChatAttachmentDraft> attachments;
  final ValueChanged<List<ChatAttachmentDraft>>? onAttachmentsSent;
  @override
  State<DeviceNewTaskScreen> createState() => _DeviceNewTaskScreenState();
}

class _DeviceNewTaskScreenState extends State<DeviceNewTaskScreen> {
  final _draft = TextEditingController();
  late final DeviceNewTaskModel _model;
  @override
  void initState() {
    super.initState();
    _model = DeviceNewTaskModel(
      widget.controller,
      widget.project,
      worktree: widget.worktree,
      baseBranch: widget.baseBranch,
      initialModel: widget.initialModel,
      thinkingLevel: widget.thinkingLevel,
      onSent: widget.onSent,
      delivery: widget.delivery,
      workspaceContext: widget.workspaceContext,
      attachments: widget.attachments,
      onAttachmentsSent: widget.onAttachmentsSent,
    );
    _draft.text = widget.initialDraft;
    _model.draft = widget.initialDraft;
    _draft.addListener(() => _model.draft = _draft.text);
    if (widget.sendOnOpen) {
      unawaited(_model.send());
    } else if (!_model.flat) {
      unawaited(_model.prepare());
    }
  }

  @override
  void dispose() {
    _model.dispose();
    _draft.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _model,
    builder: (context, _) => _build(context),
  );

  Widget _build(BuildContext context) {
    final model = widget.controller.chats;
    if (_model.ready) {
      return DeviceChatScreen(
        model: model,
        locationLabel:
            _model.created?.name ??
            widget.worktree?.name ??
            widget.project.name,
        worktree: widget.worktree != null
            ? WorktreeActivityContext(
                workspaceLocalId: widget.project.id,
                localId: widget.worktree!.id,
              )
            : _model.created == null
            ? null
            : WorktreeActivityContext(
                workspaceLocalId: _model.created!.projectId,
                localId: _model.created!.id,
              ),
      );
    }
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: const Text('New chat'),
        subtitle: ChatLocationSubtitle(
          glyph: CanopyGlyph.macbook,
          location: 'Computer chat',
          text: widget.project.name,
          computer: model.connection.hostName,
        ),
      ),
      // The scaffold's insets are only visible below it.
      body: Builder(
        builder: (context) => Padding(
          padding: CanopyScaffold.contentPaddingOf(context),
          child: ChatBody(
            transcript: _model.error != null
                ? ChatCreationFailed(
                    message: _model.error!,
                    onRetry: _model.canRetryCreation
                        ? () => unawaited(_model.retryCreation())
                        : null,
                  )
                : !_model.flat || _model.sending
                ? ChatTranscriptLoading(
                    label: _model.statusLabel,
                    labelKey: const ValueKey('creating-worktree-status'),
                  )
                : const ChatEmptyTranscript(isNewChat: true),
            composer: ChatInput(
              controller: _draft,
              sending: _model.sending,
              enabled: model.online && _model.error == null,
              onSend: () => unawaited(_model.send()),
              voiceEnabled: false,
              actionsEnabled: false,
              hintText: 'Message the agent…',
            ),
          ),
        ),
      ),
    );
  }
}
