import '../protocol.dart';
import 'attachments.dart';
import 'models.dart';

enum DeviceChatSendOutcome { accepted, uncertain }

/// The initial task creation was refused locally; no task mutation was sent.
final class DeviceChatCreationNotSent extends DeviceLinkException {
  const DeviceChatCreationNotSent(super.message);
}

final class DeviceChatPendingSend {
  DeviceChatPendingSend(
    this.ref,
    this.id,
    this.text, {
    this.dictated = false,
    this.attachmentPaths = const [],
  });
  final bool dictated;
  final DeviceChatRef ref;
  final String id, text;

  /// Files already stored on the computer; a retry sends the same paths.
  final List<String> attachmentPaths;
}

/// One computer's chat writes as [DeviceChatsRepository] exposes them: sends
/// with their pending and confirmed attempt, chat and tab creation, stop,
/// and the attachment store. A send is written at most once; an uncertain
/// one stays pending until the transcript confirms it or the user retries
/// the same attempt.
///
abstract interface class DeviceChatSender {
  /// Fires after every change of the members below and of the read path.
  Stream<void> get updates;

  /// The unconfirmed send of this computer (one at a time).
  DeviceChatPendingSend? get pendingSend;

  /// The last send the computer accepted or the transcript confirmed.
  DeviceChatPendingSend? get confirmedSend;

  /// A send request is in flight.
  bool get sending;

  /// Files stored in a chat scope's attachments folder on the computer.
  DeviceChatAttachments get attachments;

  /// The computer's chat workspaces changed (the catalog was read).
  void catalogChanged(List<DeviceChatWorkspace> workspaces);

  /// Creates a work entry in [workspaceId] and its first chat, calls
  /// [onCreated], then opens it.
  Future<DeviceChatRef> createChat(
    String workspaceId, {
    String? title,
    void Function(DeviceChatRef)? onCreated,
  });

  /// Creates a chat tab in the worktree and opens it; [onCreated] runs once
  /// the selection is established, before the open finishes.
  Future<void> createTab(
    String projectId,
    String worktreeId, {
    void Function(DeviceChatRef)? onCreated,
  });

  /// Sends [text] to the selected chat, or with [retry] the pending attempt
  /// again with the same ids and files. Throws when nothing was sent,
  /// including when [chat] is given and another chat is selected.
  Future<DeviceChatSendOutcome> send(
    String text, {
    DeviceChatRef? chat,
    bool retry = false,
    bool dictated = false,
    List<String> attachmentPaths = const [],
  });

  /// Cancels [chat]'s turn and re-reads it while it stays selected.
  Future<void> stop(DeviceChatRef chat);
  Future<void> dispose();
}
