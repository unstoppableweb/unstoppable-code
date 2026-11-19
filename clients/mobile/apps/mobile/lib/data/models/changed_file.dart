/// A single changed file (uncommitted or committed) in a worktree.
class RemoteChangedFile {
  const RemoteChangedFile({
    required this.filePath,
    required this.status,
    required this.committed,
    this.repoId,
    this.repoName,
    this.revision,
    this.insertions,
    this.deletions,
  });

  /// Per-file line counts (`RemoteControlChangedFile.insertions`/`deletions`),
  /// absent on older desktops.
  final int? insertions;
  final int? deletions;

  final String filePath;

  /// Git status token (`modified`, `added`, `deleted`, …).
  final String status;

  /// Owning-repo identity in multi-repo worktrees
  /// (`RemoteControlChangedFile.repoId`/`repoName`); absent on single-repo
  /// projections and older desktops.
  final String? repoId;
  final String? repoName;

  /// Relay projection revision; absent on older servers.
  final String? revision;

  /// True for committed changes, false for uncommitted working-tree changes.
  final bool committed;
}
