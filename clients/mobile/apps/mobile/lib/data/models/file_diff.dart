/// Which diff the desktop should read for a file
/// (`RemoteControlDiffReadPayload.source`).
enum RemoteDiffSource {
  /// Working-tree changes against the index/HEAD.
  uncommitted('uncommitted'),

  /// Commits on the worktree branch against its base.
  committed('committed'),

  /// Both, as one patch.
  combined('combined');

  const RemoteDiffSource(this.wireValue);

  /// Serialized value sent in the `diff/read` request body.
  final String wireValue;
}

/// One file's unified diff as read through the Portal
/// (`RemoteControlDiffSnapshotPayload` from `POST .../diff/read`).
class RemoteFileDiff {
  const RemoteFileDiff({
    required this.filePath,
    required this.patch,
    this.repoId,
    this.rangeLabel,
    this.insertions,
    this.deletions,
  });

  /// Relative path of the changed file.
  final String filePath;

  /// Unified-diff patch text; empty when the desktop had nothing to show
  /// (binary file, or a change that no longer exists).
  final String patch;

  /// Owning repo in a multi-repo worktree; absent on single-repo projections.
  final String? repoId;

  /// Human-readable range (e.g. `abc123..def456`) for committed reads.
  final String? rangeLabel;

  /// Per-file line counts from the roster row matching [filePath], when the
  /// desktop projects them.
  final int? insertions;
  final int? deletions;

  /// Parses the wire snapshot. Every field except [filePath] degrades to a
  /// benign default so a partial payload from an older desktop still renders.
  factory RemoteFileDiff.fromJson(Map<String, dynamic> json) {
    final filePath = json['filePath'];
    final patch = json['patch'];
    final repoId = json['repoId'];
    final rangeLabel = json['rangeLabel'];
    final resolvedPath = filePath is String ? filePath : '';
    int? insertions;
    int? deletions;
    final files = json['files'];
    if (files is List) {
      for (final row in files.whereType<Map<String, dynamic>>()) {
        if (row['filePath'] != resolvedPath) continue;
        final rowInsertions = row['insertions'];
        final rowDeletions = row['deletions'];
        if (rowInsertions is num) insertions = rowInsertions.toInt();
        if (rowDeletions is num) deletions = rowDeletions.toInt();
        break;
      }
    }
    return RemoteFileDiff(
      filePath: resolvedPath,
      patch: patch is String ? patch : '',
      repoId: repoId is String && repoId.isNotEmpty ? repoId : null,
      rangeLabel: rangeLabel is String && rangeLabel.isNotEmpty
          ? rangeLabel
          : null,
      insertions: insertions,
      deletions: deletions,
    );
  }
}
