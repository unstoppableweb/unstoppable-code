import '../desktop/ipc.dart';
import '../protocol.dart';
import 'dto.dart';
import 'models.dart';

/// Fork construction and persistence remain in the desktop's canonical chat
/// command. Stable attempt identities make a lost acknowledgement retryable
/// without creating a second destination.
final class DeviceChatForks {
  DeviceChatForks(this.ipc);
  final DesktopIpc ipc;
  final _attempts = <(String, String), ({String commandId, String tabId})>{};

  void opened(DeviceChatRef source, String atMessageId) =>
      _attempts.remove((source.key, atMessageId));

  Future<DeviceChatRef> fork(DeviceChatRef source, String atMessageId) async {
    final key = (source.key, atMessageId);
    final attempt = _attempts.putIfAbsent(
      key,
      () => (commandId: chatId(), tabId: chatId()),
    );
    final result = deviceLinkObject(
      deviceChatDto(
        await ipc.invoke('chat:command', [
          {
            'schemaVersion': 1,
            'commandId': attempt.commandId,
            ...source.scope,
            'command': {
              'type': 'chat.fork_tab',
              'sourceTabId': source.id,
              'targetTabId': attempt.tabId,
              'atMessageId': atMessageId,
            },
          },
        ]),
      ),
    );
    if (!['applied', 'already_applied'].contains(result['outcome']) ||
        result['entityId'] != attempt.tabId) {
      if (['rejected', 'not_found', 'conflict'].contains(result['outcome'])) {
        _attempts.remove(key);
      }
      throw const DeviceLinkException('The computer did not confirm the fork.');
    }
    return DeviceChatRef(
      projectId: source.projectId,
      worktreeId: source.worktreeId,
      id: attempt.tabId,
      title: source.title,
    );
  }
}
