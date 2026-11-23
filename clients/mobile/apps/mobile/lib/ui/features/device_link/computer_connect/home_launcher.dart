import 'dart:async';
import 'package:flutter/widgets.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/delivery.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/worktrees/models.dart';
import 'package:mobile/ui/core/chat/view_models/composer_draft_binding.dart';
import 'controller.dart';
import 'home_model.dart';

final class ComputerHomeLaunch {
  const ComputerHomeLaunch({
    required this.project,
    required this.worktree,
    required this.baseBranch,
    required this.model,
    required this.thinkingLevel,
    required this.text,
    required this.delivery,
    required this.context,
  });
  final DeviceProject project;
  final DeviceWorktree? worktree;
  final String? baseBranch, thinkingLevel;
  final ModelOption? model;
  final String text;
  final DeviceChatDelivery delivery;
  final WorkspaceContext context;
}

/// One context's Home draft: the composer's text controller, bound to the
/// draft store.
final class _HomeDraft {
  _HomeDraft(this.target, ChatDraftPort store) {
    _binding = ComposerDraftBinding(controller: controller, store: store)
      ..bind(target);
  }
  final ComputerHomeDraftTarget target;
  final controller = TextEditingController();
  late ComposerDraftBinding _binding;
  void bindStore(ChatDraftPort store) {
    _binding.dispose();
    _binding = ComposerDraftBinding(controller: controller, store: store)
      ..adopt(target);
  }

  void dispose() {
    _binding.dispose();
    controller.dispose();
  }
}

/// Home's composer drafts of one computer, one per navigation context.
/// Text controllers are widget state; the store keeps the text.
final class ComputerHomeDrafts {
  ComputerHomeDrafts(this.computerId, this._store);
  final String computerId;
  ChatDraftPort _store;
  final _drafts = <WorkspaceContext, _HomeDraft>{};
  ChatDraftPort get store => _store;

  TextEditingController draftFor(WorkspaceContext context) => _drafts
      .putIfAbsent(
        context,
        () => _HomeDraft(
          ComputerHomeDraftTarget(
            computerId: computerId,
            contextId: context.organizationId == null
                ? 'personal'
                : 'organization:${context.organizationId}',
          ),
          _store,
        ),
      )
      .controller;

  /// The controller of the context [contextId] names, if one exists.
  TextEditingController? existing(String contextId) => _drafts.values
      .where((d) => d.target.contextId == contextId)
      .firstOrNull
      ?.controller;

  void bindStore(ChatDraftPort store) {
    if (identical(store, _store)) return;
    _store = store;
    for (final draft in _drafts.values) {
      draft.bindStore(store);
    }
  }

  void dispose() {
    for (final draft in _drafts.values) {
      draft.dispose();
    }
  }
}

/// One computer session owns launch admission, scoped durable drafts and
/// delivery observation. Replacing Home never releases an unresolved send
/// or its draft.
abstract interface class ComputerHomeLauncher implements Listenable {
  ComputerConnectController get controller;
  bool get busy;
  String? get error;

  /// The chat of the computer's unconfirmed send, which blocks a launch.
  DeviceChatRef? get pendingRef;
  TextEditingController draftFor(WorkspaceContext context);
  void bindDraftStore(ChatDraftPort store);

  /// Starts a launch from [choices]; `null` when none may start.
  Future<ComputerHomeLaunch?> begin(ComputerChatHomeModel choices);

  /// Opens the unconfirmed send's chat in [context].
  Future<DeviceChatRef?> resume(WorkspaceContext context);

  /// Leaves the launched or resumed chat.
  Future<void> finish();
  void dispose();
}
