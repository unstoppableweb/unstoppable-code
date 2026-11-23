/// Shared with Remote Control. Computer Connect's load phase comes from
/// the core (`ActivityView.files_status`, cc-app activity); keep both in
/// step until cleanup C5.
library;

/// Shown when a projection request or the read that follows it failed.
const kChangedFilesLoadFailed = "Couldn't load changed files. Try again.";

/// Shown when no authoritative result arrived within the hydration timeout.
const kChangedFilesTimedOut = 'Changed files took too long to load. Try again.';

/// Shown while there is no connection to the paired desktop. Nothing can
/// be requested until the session is reconnected, which reloads the list.
const kChangedFilesOffline =
    'Not connected to your desktop. Go back and reconnect to load changed '
    'files.';

/// Where a worktree's changed-file list stands (CAN-3644).
enum ChangedFilesLoadPhase {
  /// Nothing was requested this session.
  idle,

  /// A requested projection, or the read that follows it, has not settled.
  loading,

  /// The latest request settled: the list is authoritative, even when empty.
  loaded,

  /// The latest request failed or ran out of time; nothing confirms the list.
  failed,
}

/// Immutable, comparable load state of one worktree's changed files.
final class ChangedFilesLoadStatus {
  const ChangedFilesLoadStatus._(this.phase) : error = null, canRetry = false;
  const ChangedFilesLoadStatus.failed(String this.error)
    : phase = ChangedFilesLoadPhase.failed,
      canRetry = true;
  const ChangedFilesLoadStatus._offline()
    : phase = ChangedFilesLoadPhase.failed,
      error = kChangedFilesOffline,
      canRetry = false;

  static const idle = ChangedFilesLoadStatus._(ChangedFilesLoadPhase.idle);
  static const loading = ChangedFilesLoadStatus._(
    ChangedFilesLoadPhase.loading,
  );
  static const loaded = ChangedFilesLoadStatus._(ChangedFilesLoadPhase.loaded);

  /// No connection: nothing to retry until the session reconnects.
  static const offline = ChangedFilesLoadStatus._offline();

  final ChangedFilesLoadPhase phase;

  /// User-presentable reason, when [phase] is [ChangedFilesLoadPhase.failed].
  final String? error;

  /// Whether a fresh load can be started now, so Retry may be offered.
  final bool canRetry;

  @override
  bool operator ==(Object other) =>
      other is ChangedFilesLoadStatus &&
      other.phase == phase &&
      other.error == error &&
      other.canRetry == canRetry;

  @override
  int get hashCode => Object.hash(phase, error, canRetry);

  @override
  String toString() => 'ChangedFilesLoadStatus($phase, $error, $canRetry)';
}
