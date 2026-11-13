import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_control_exception.dart';
import 'remote_composer_commands.dart';

/// The existing Portal fork command delegates to the desktop renderer. Its
/// acknowledgement means delivery only; the caller waits for the new tab.
final class RemoteResponseCommands {
  const RemoteResponseCommands({required this.submit});
  final RemotePortalCommandSubmit submit;

  Future<String> fork(RemoteWorktreeChatTarget target, String turnKey) async {
    final response = await submit(
      type: 'portal.chat.fork',
      target: {
        'workspaceLocalId': target.workspaceLocalId,
        'worktreeLocalId': target.worktreeLocalId,
      },
      payload: {
        'projectId': target.workspaceLocalId,
        'worktreeId': target.worktreeLocalId,
        'chatId': target.chatId,
        'forkAfterUserMessageId': turnKey,
      },
    );
    if (response.error case final error?) throw RemoteControlException(error);
    return response.commandId;
  }
}
