import 'dart:typed_data';

import 'models.dart';

/// A file stored in a chat scope's attachments folder on the computer.
final class DeviceChatAttachment {
  const DeviceChatAttachment({
    required this.filename,
    required this.path,
    required this.size,
  });

  /// The name the computer stored the file under, unique in its folder.
  final String filename;

  /// The computer's absolute path, which a send names in `attachmentPaths`.
  final String path;
  final int size;
}

/// Files a phone attaches, stored on the computer the way a remote desktop
/// window's dropped files are: bytes travel through the tunneled
/// workspace-items import, which picks the worktree or Cowork folder. The
/// platform part (picking and reading the file) stays with the caller.
///
abstract interface class DeviceChatAttachments {
  /// Stores [bytes] as [filename] in [scope]'s folder: one file per request,
  /// sent once. Throws a [DeviceLinkException] when the computer did not
  /// store it.
  Future<DeviceChatAttachment> import(
    DeviceChatRef scope,
    String filename,
    Uint8List bytes,
  );

  Future<void> delete(DeviceChatRef scope, String filename);
}
