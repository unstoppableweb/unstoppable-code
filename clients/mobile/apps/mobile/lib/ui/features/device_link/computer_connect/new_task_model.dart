import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/delivery.dart';
import 'package:mobile/device_link/worktrees/writes.dart';
import 'package:mobile/device_link/worktrees/models.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_draft.dart';
import 'controller.dart';

/// A single chat-first creation attempt. Disposing the route ends the attempt.
abstract interface class DeviceNewTaskModel implements Listenable {
  factory DeviceNewTaskModel(
    ComputerConnectController controller,
    DeviceProject project, {
    DeviceWorktree? worktree,
    String? baseBranch,
    ModelOption? initialModel,
    String? thinkingLevel,
    void Function()? onSent,
    DeviceChatDelivery? delivery,
    WorkspaceContext? workspaceContext,
    List<ChatAttachmentDraft> attachments = const [],
    ValueChanged<List<ChatAttachmentDraft>>? onAttachmentsSent,
  }) => controller.homeFlows.newTask(
    controller,
    project,
    worktree: worktree,
    baseBranch: baseBranch,
    initialModel: initialModel,
    thinkingLevel: thinkingLevel,
    onSent: onSent,
    delivery: delivery,
    workspaceContext: workspaceContext,
    attachments: attachments,
    onAttachmentsSent: onAttachmentsSent,
  );

  ComputerConnectController get controller;
  DeviceProject get project;
  bool get flat;
  bool get ready;
  bool get sending;
  String? get error;
  DeviceCreatedWorktree? get created;
  DeviceWorktreeAttempt get attempt;

  /// "Creating worktree…" until the computer answered the create, then
  /// "Setting up worktree…".
  String get statusLabel;
  bool get canRetryCreation;

  /// The screen composer's text.
  String get draft;
  set draft(String value);
  Future<void> retryCreation();
  Future<void> prepare();
  Future<void> send();
  void dispose();
}
