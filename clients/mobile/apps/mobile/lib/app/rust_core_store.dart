import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/services.dart';
import 'package:mobile/device_link/store.dart';
import 'package:path_provider/path_provider.dart';

const _noBackup = MethodChannel(
  'com.unstoppabledomains.canopy/no_backup_directory',
);

/// An app-private directory the OS does not back up: Android's no-backup
/// files, or an Application Support folder excluded from iOS backups.
/// Elsewhere, Application Support.
Future<Directory> noBackupDirectory() async {
  if (!Platform.isIOS && !Platform.isAndroid) {
    return getApplicationSupportDirectory();
  }
  final path = await _noBackup.invokeMethod<String>('path');
  if (path == null) throw StateError('No no-backup directory.');
  return Directory(path);
}

/// Readies the Rust core's databases under [root] and returns the key that
/// wraps them.
///
/// The key never leaves the device, so [root] must be a directory the OS
/// does not back up: a restored database could not be opened. A store kept
/// in [legacy], the backed-up directory used before, moves to [root] while
/// its key is present. A key that is absent means every store left was
/// wrapped by a key that is gone, so both directories are removed before a
/// new key is made. A key that fails to read leaves both untouched.
Future<String> openRustCoreStore({
  required Directory root,
  required Directory legacy,
  required DeviceLinkStore key,
}) async {
  final existing = await key.read();
  if (existing == null) {
    for (final directory in {root.path, legacy.path}.map(Directory.new)) {
      if (await directory.exists()) await directory.delete(recursive: true);
    }
    final random = Random.secure();
    final created = base64Url
        .encode(List.generate(32, (_) => random.nextInt(256)))
        .replaceAll('=', '');
    await key.write(created);
    return created;
  }
  if (legacy.path != root.path &&
      await legacy.exists() &&
      !await root.exists()) {
    await root.parent.create(recursive: true);
    await legacy.rename(root.path);
  }
  return existing;
}
