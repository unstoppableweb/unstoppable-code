import 'dart:async';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_control_exception.dart';
import 'remote_control_view_model.dart';

/// Portal's legacy fork has no destination receipt. Follow only a
/// confirmed destination, never an unrelated projected tab or delivery ack.
Future<String> forkRemoteResponse(
  RemoteControlViewModel model,
  RemoteWorktreeChatTarget source,
  String turnKey, {
  Duration timeout = const Duration(seconds: 30),
}) async {
  final generation = model.sessionGeneration;
  List<RemoteChatSummary> rows() => model.chatSummariesFor(
    workspaceLocalId: source.workspaceLocalId,
    worktreeLocalId: source.worktreeLocalId,
  );
  String? destinationId;
  final completion = Completer<String>();
  String? commandId;
  void observe() {
    if (completion.isCompleted) return;
    if (model.sessionGeneration != generation || !model.isConnected) {
      completion.completeError(
        const RemoteControlException('The paired session ended.'),
      );
      return;
    }
    if (commandId == null) return;
    if (model.hasCommandFailed(commandId)) {
      completion.completeError(
        const RemoteControlException('The desktop could not fork this chat.'),
      );
      return;
    }
    final destination = rows()
        .where((row) => row.chatId == destinationId)
        .firstOrNull;
    if (destination != null) completion.complete(destination.chatId);
  }

  model.addListener(observe);
  try {
    // Attach an error listener before the HTTP request can yield to a session change.
    final result = completion.future.timeout(timeout);
    unawaited(result.then<void>((_) {}, onError: (Object _) {}));
    commandId = await model.submitResponseFork(
      source,
      turnKey,
      onCompleted: (receipt) {
        final id = receipt?['entityId'];
        if (completion.isCompleted) return;
        if (id is! String || id.isEmpty) {
          completion.completeError(
            const RemoteControlException(
              'Could not confirm the fork. Check the chat list before trying again.',
            ),
          );
          return;
        }
        destinationId = id;
        observe();
      },
      onFailed: (message) {
        if (!completion.isCompleted) {
          completion.completeError(RemoteControlException(message));
        }
      },
    );
    observe();
    return await result;
  } finally {
    model.removeListener(observe);
    // A rejected HTTP submission must also retire the timeout's pending future.
    if (!completion.isCompleted) completion.complete('');
  }
}
