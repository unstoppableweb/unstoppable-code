import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/store.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/services/platform_attachment_picker.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';
import '../chats_screen.dart';
import 'account.dart';
import 'computer_switcher.dart';
import 'connection_view.dart';
import 'details_picker.dart';
import 'home_model.dart';
import 'home_launcher.dart';
import 'home_composer.dart';
import 'new_task_screen.dart';

/// The mobile start page. Setup and the composer share the existing account
/// connection lifetime. Choosing a destination never creates a task.
class ComputerChatHome extends StatefulWidget {
  const ComputerChatHome({
    super.key,
    required this.account,
    required this.selectionStore,
    this.attachmentPicker,
  });
  final ComputerConnectAccount account;

  /// Device pickers behind the composer's `+` sheet. Null uses
  /// [PlatformAttachmentPicker].
  final AttachmentPicker? attachmentPicker;
  final DeviceLinkStore Function(String computerId, WorkspaceContext context)
  selectionStore;
  @override
  State<ComputerChatHome> createState() => _ComputerChatHomeState();
}

class _ComputerChatHomeState extends State<ComputerChatHome> {
  /// Files staged per computer and context. They stay on this phone until a
  /// chat exists to store them in, and survive reconnects. Leaving Home
  /// discards them.
  final _attachments = <String, ChatAttachmentController>{};

  ChatAttachmentController _attachmentsFor(String key) =>
      _attachments.putIfAbsent(
        key,
        () => ChatAttachmentController(
          uploader: null,
          picker: widget.attachmentPicker ?? PlatformAttachmentPicker(),
        ),
      );

  @override
  void dispose() {
    for (final attachments in _attachments.values) {
      unawaited(attachments.discardAll().whenComplete(attachments.dispose));
    }
    super.dispose();
  }

  Future<void> _manage() => showComputerConnections(context, widget.account);
  Future<void> _start(
    ComputerChatHomeModel model,
    ChatAttachmentController attachments,
  ) async {
    final launcher = widget.account.engine.homeLauncher;
    final launch = await launcher.begin(model);
    if (launch == null) return;
    try {
      if (!mounted ||
          (context.read<WorkspaceContext?>() ??
                  const WorkspaceContext.personal()) !=
              launch.context) {
        return;
      }
      await Navigator.of(context).push<void>(
        MaterialPageRoute(
          builder: (_) => DeviceNewTaskScreen(
            controller: launcher.controller,
            project: launch.project,
            worktree: launch.worktree,
            baseBranch: launch.baseBranch,
            initialDraft: launch.text,
            initialModel: launch.model,
            thinkingLevel: launch.thinkingLevel,
            sendOnOpen: true,
            workspaceContext: launch.context,
            delivery: launch.delivery,
            attachments: attachments.drafts,
            onAttachmentsSent: (sent) {
              for (final draft in sent) {
                unawaited(attachments.remove(draft.localId));
              }
            },
          ),
        ),
      );
    } finally {
      await launcher.finish();
    }
  }

  Future<void> _resumeDelivery(
    ComputerHomeLauncher launcher,
    WorkspaceContext contextScope,
  ) async {
    final ref = await launcher.resume(contextScope);
    if (ref == null) return;
    try {
      if (!mounted ||
          (context.read<WorkspaceContext?>() ??
                  const WorkspaceContext.personal()) !=
              contextScope) {
        return;
      }
      await Navigator.of(context).push<void>(
        MaterialPageRoute(
          builder: (_) => DeviceChatScreen(
            model: launcher.controller.chats,
            locationLabel: ref.title,
            worktree: launcher.controller.activityContext(ref),
          ),
        ),
      );
    } finally {
      await launcher.finish();
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.account,
    builder: (context, _) {
      final account = widget.account, controller = account.engine.selected;
      final workspaceContext =
          context.watch<WorkspaceContext?>() ??
          const WorkspaceContext.personal();
      final hasComputers = account.hasSelectedComputer;
      final launcher = account.engine.selectedId == null
          ? null
          : account.engine.homeLauncher;
      final connection = controller.chats.connection;
      final title =
          (controller.chats.online || connection.reconnecting
              ? (connection.host?['name'] as String?)
              : null) ??
          account.selectedName ??
          'Choose a computer';
      final status = controller.chats.online ? 'Connected' : '';
      return ListenableBuilder(
        listenable: launcher ?? account,
        builder: (context, _) => CanopyScaffold(
          appBar: CanopyAppBar(
            // The same computer switcher as the projects screen.
            content: hasComputers
                ? ComputerSwitcher(
                    account: account,
                    title: title,
                    label: status,
                    onManage: () => unawaited(_manage()),
                  )
                : const Text('Computer connect'),
            leading: HomeMenuButton.maybeOf(context, designSystem: true),
          ),
          body: !hasComputers
              ? ComputerConnectionView(account: account)
              // The scaffold's insets are only visible below it.
              : Builder(
                  builder: (context) => Padding(
                    padding: CanopyScaffold.contentPaddingOf(context),
                    child: launcher == null
                        ? ComputerHomeIntro(
                            children: [
                              if (launcher?.error case final error?)
                                InlineNotice(
                                  glyph: CanopyGlyph.circleInfo,
                                  state: error,
                                ),
                            ],
                          )
                        : ComputerHomeComposer(
                            key: ValueKey(
                              '${account.engine.selectedId}:${workspaceContext.organizationId}',
                            ),
                            controller: controller,
                            workspaceContext: workspaceContext,
                            store: widget.selectionStore(
                              account.engine.selectedId!,
                              workspaceContext,
                            ),
                            draft: launcher.draftFor(workspaceContext),
                            opening: launcher.busy,
                            pendingDelivery: launcher.pendingRef != null,
                            onCheckDelivery: () => unawaited(
                              _resumeDelivery(launcher, workspaceContext),
                            ),
                            notices: [
                              if (launcher.error case final error?)
                                InlineNotice(
                                  glyph: CanopyGlyph.circleInfo,
                                  state: error,
                                ),
                            ],
                            attachments: _attachmentsFor(
                              '${account.engine.selectedId}:${workspaceContext.organizationId}',
                            ),
                            onStart: _start,
                          ),
                  ),
                ),
        ),
      );
    },
  );
}
