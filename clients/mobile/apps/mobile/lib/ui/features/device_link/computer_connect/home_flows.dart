import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/delivery.dart';
import 'package:mobile/device_link/worktrees/models.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_draft.dart';

import 'controller.dart';
import 'home_model.dart';
import 'new_task_model.dart';

abstract interface class ComputerHomeFlows {
  ComputerChatHomeModel homeModel(
    ComputerConnectController controller,
    WorkspaceContext context,
  );

  DeviceNewTaskModel newTask(
    ComputerConnectController controller,
    DeviceProject project, {
    DeviceWorktree? worktree,
    String? baseBranch,
    ModelOption? initialModel,
    String? thinkingLevel,
    void Function()? onSent,
    DeviceChatDelivery? delivery,
    WorkspaceContext? workspaceContext,
    List<ChatAttachmentDraft> attachments,
    ValueChanged<List<ChatAttachmentDraft>>? onAttachmentsSent,
  });
}
