import 'package:flutter/foundation.dart';

import 'models.dart';

/// A created worktree, ready for its first chat.
final class DeviceCreatedWorktree {
  const DeviceCreatedWorktree(this.projectId, this.id, this.name);
  final String projectId, id, name;
}

/// One UI attempt to create a worktree. It owns its receipt: the create IPC
/// is not idempotent, so a missing reply never causes a second create.
abstract interface class DeviceWorktreeAttempt {
  String get projectId;

  /// The created worktree, once the computer answered.
  String? get worktreeId;

  /// A worktree exists to check, or no create left the phone.
  bool get canRetry;
}

/// One computer's worktree creation, as the new task screen drives it. The
/// Dart [DeviceWorktreeCreator] and the Rust-backed one both implement it.
abstract interface class DeviceWorktreeCreation {
  /// A new attempt in [projectId]. [onChanged] runs when the computer
  /// answered its create.
  DeviceWorktreeAttempt attempt(
    String projectId, {
    String? baseBranch,
    VoidCallback? onChanged,
  });

  /// Sends at most one create for [attempt] and waits for the worktree's
  /// setup. A call while one runs shares its outcome; after a success it
  /// answers the same worktree.
  Future<DeviceCreatedWorktree> create(DeviceWorktreeAttempt attempt);

  /// [attempt]'s owner left.
  void release(DeviceWorktreeAttempt attempt);

  /// The computer's connection changed. The Rust-backed implementation
  /// follows the core's connection itself.
  void setConnected(bool value);
  Future<void> dispose();
}

/// One computer's worktree archive, as the overview's rows drive it.
abstract interface class DeviceWorktreeArchive implements Listenable {
  /// The row stays archiving until a roster re-read drops it.
  bool isArchiving(DeviceWorktree worktree);

  /// Archives [worktree] through the computer's own archive call, then
  /// re-reads the roster. Does nothing while the row is archiving.
  Future<void> archive(DeviceWorktree worktree);
  void dispose();
}
