/// Cleanup for the chat tails the retired Remote tab cached (CAN-3373).
///
/// Transcripts can contain code and secrets, so the cache is deleted rather
/// than left behind once nothing reads it.
library;

import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// Deletes the cache directory inside application support, if an earlier
/// build created it. Best-effort: a failure is logged and retried on the next
/// launch.
Future<void> deleteRetiredRemoteTranscripts({
  Future<Directory> Function() applicationSupport =
      getApplicationSupportDirectory,
}) async {
  try {
    final root = await applicationSupport();
    final directory = Directory(p.join(root.path, 'remote-transcripts'));
    if (await directory.exists()) await directory.delete(recursive: true);
  } catch (error) {
    debugPrint('Retired transcript cache cleanup failed: $error');
  }
}
