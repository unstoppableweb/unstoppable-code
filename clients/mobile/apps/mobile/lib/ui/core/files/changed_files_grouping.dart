import 'package:mobile/data/models/changed_file.dart';

/// One changed file placed under its directory group.
class ChangedFileEntry {
  const ChangedFileEntry({required this.file, required this.fileName});

  final RemoteChangedFile file;

  /// Last path segment, what the row shows once the directory is a header.
  final String fileName;
}

/// Files that share a parent directory (and, in multi-repo worktrees, a repo).
class ChangedFileDirectoryGroup {
  const ChangedFileDirectoryGroup({
    required this.repoId,
    required this.repoName,
    required this.directory,
    required this.files,
  });

  final String? repoId;
  final String? repoName;

  /// Parent directory without a trailing slash; empty for the repo root.
  final String directory;
  final List<ChangedFileEntry> files;
}

/// One Files-tab section (Uncommitted or Committed) grouped elsewhere:
/// Computer Connect's core groups its changed files itself.
class ChangedFilesSection {
  const ChangedFilesSection({
    required this.committed,
    required this.summary,
    required this.groups,
  });

  final bool committed;
  final ChangedFilesSummary summary;
  final List<ChangedFileDirectoryGroup> groups;
}

/// Totals for a section header (`12 files · +386 -10`).
class ChangedFilesSummary {
  const ChangedFilesSummary({
    required this.fileCount,
    required this.insertions,
    required this.deletions,
  });

  final int fileCount;
  final int insertions;
  final int deletions;
}
