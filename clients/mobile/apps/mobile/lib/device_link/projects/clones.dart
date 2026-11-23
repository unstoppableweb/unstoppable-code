import 'package:computer_connect_core/computer_connect_core.dart';

export 'package:computer_connect_core/computer_connect_core.dart'
    show CloneRowView, ClonePhaseView;

/// Adds Personal projects on one connected computer: its pending project
/// rows and the add flow, as the projects overview reads them. The Dart
/// [DeviceProjectCloneRepository] and the Rust-backed one both implement it;
/// both build the core's [CloneRowView].
///
/// A clone is not idempotent: each attempt sends exactly one request with
/// its own job id, and a lost answer is read back, never resent.
abstract interface class DeviceProjectClones {
  /// Pending project rows, oldest first.
  List<CloneRowView> get clones;

  /// The oldest unknown result that still blocks another clone, even when
  /// its row is hidden.
  CloneRowView? get unconfirmed;

  /// Sends one clone of [remoteUrl] into the computer's default folder.
  /// Resolves to a message when nothing was sent, or null once the pending
  /// row took over. [stillAllowed] rechecks the caller's context just
  /// before the request is sent.
  Future<String?> add(
    String remoteUrl, {
    required bool Function() stillAllowed,
  });

  /// The user checked Projects on the computer and accepted that another
  /// clone might duplicate [jobId]'s. Sends nothing. False when [jobId] is
  /// no longer unknown.
  Future<bool> acknowledgeUnknown(String jobId);

  /// Removes a settled row, or hides an unknown one. Sends nothing.
  void dismiss(String jobId);

  /// Reads the computer's clone jobs for answers that were lost or are
  /// unknown.
  void readBack();

  /// Drops rows whose created project the inventory now lists.
  void retireListed(Set<String> projectIds);

  /// The computer's connection changed. The Rust-backed implementation
  /// follows the core's connection itself.
  void setConnected(bool value);
  void dispose();
}
