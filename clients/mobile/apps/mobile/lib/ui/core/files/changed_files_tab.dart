import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';
import 'package:mobile/data/models/changed_file.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'changed_files_grouping.dart';
import 'changed_files_load_status.dart';

/// Shown while the changed-file list is unknown (CAN-3644).
const kChangedFilesLoadingLabel = 'Loading changed files…';

/// Shown above a cached list while its refresh is outstanding.
const kChangedFilesRefreshingLabel = 'Checking for changes…';

/// The activity sidebar's Files tab: the worktree's changed files grouped by
/// section and directory. [status] decides what an empty list means: still
/// loading, failed to load, or a worktree without changes. A cached list
/// stays visible, with a compact status line, while it is refreshed.
class ChangedFilesTab extends StatelessWidget {
  const ChangedFilesTab({
    super.key,
    required this.onOpenDiff,
    required this.status,
    this.onRetry,
    required this.sections,
  });

  final ValueChanged<RemoteChangedFile> onOpenDiff;
  final ChangedFilesLoadStatus status;

  /// Starts a fresh load after a failure. Offered only when [status] can
  /// be retried; offline, the message explains how to recover instead.
  final VoidCallback? onRetry;

  final List<ChangedFilesSection> sections;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final error = status.error;
    final loading =
        status.phase != ChangedFilesLoadPhase.loaded && error == null;
    final retry = status.canRetry ? onRetry : null;
    if (sections.isEmpty) {
      if (loading) return const _ChangedFilesLoading();
      if (error != null) {
        return _ChangedFilesFailed(message: error, onRetry: retry);
      }
      return Center(
        child: Text(
          'No changed files.',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      );
    }
    // Web parity: uncommitted working-tree changes first, committed changes
    // under their own header. Within a section, files sit under one header
    // per directory so rows show short names instead of repeating a long,
    // truncated prefix. Flattened into one row list so the builder stays
    // lazy — a large refactor can carry hundreds of files.
    final rows = <Object>[
      for (final section in sections) ...[
        _SectionHeader(
          section.committed ? 'Committed' : 'Uncommitted',
          section.summary,
        ),
        for (final group in section.groups) ...[
          _DirectoryHeader(group),
          ...group.files,
        ],
      ],
    ];
    final list = ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 4),
      itemCount: rows.length,
      itemBuilder: (context, index) => switch (rows[index]) {
        final _SectionHeader header => header,
        final _DirectoryHeader header => header,
        final ChangedFileEntry entry => _ChangedFileRow(
          entry: entry,
          onTap: () => onOpenDiff(entry.file),
        ),
        _ => const SizedBox.shrink(),
      },
    );
    return Column(
      children: [
        if (loading)
          const _ChangedFilesRefreshing()
        else if (error != null)
          _ChangedFilesRefreshFailed(message: error, onRetry: retry),
        // Keyed so the list, and its scroll position, survive the status
        // line coming and going.
        Expanded(key: const ValueKey('changed-files-list'), child: list),
      ],
    );
  }
}

/// Spinner and label while no list is known yet.
class _ChangedFilesLoading extends StatelessWidget {
  const _ChangedFilesLoading();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      // One announcement for the state; the spinner's own label would repeat
      // it.
      child: Semantics(
        liveRegion: true,
        label: kChangedFilesLoadingLabel,
        excludeSemantics: true,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const LoadingSpinner(size: 20),
            const SizedBox(height: 12),
            Text(
              kChangedFilesLoadingLabel,
              key: const ValueKey('changed-files-loading'),
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A failed load with no list to show: never the empty state.
class _ChangedFilesFailed extends StatelessWidget {
  const _ChangedFilesFailed({required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CanopyIcon(
              glyph: CanopyGlyph.warningSign,
              tint: theme.colorScheme.error,
              size: 32,
            ),
            const SizedBox(height: 12),
            Semantics(
              liveRegion: true,
              child: Text(
                message,
                key: const ValueKey('changed-files-error'),
                textAlign: TextAlign.center,
              ),
            ),
            if (onRetry case final onRetry?) ...[
              const SizedBox(height: 12),
              FilledButton.tonal(
                key: const ValueKey('retry-changed-files'),
                onPressed: onRetry,
                child: const Text('Retry'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// One compact line above a cached list while it is refreshed.
class _ChangedFilesRefreshing extends StatelessWidget {
  const _ChangedFilesRefreshing();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Semantics(
      liveRegion: true,
      label: kChangedFilesRefreshingLabel,
      excludeSemantics: true,
      child: Padding(
        key: const ValueKey('changed-files-refreshing'),
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 2),
        child: Row(
          children: [
            const LoadingSpinner(),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                kChangedFilesRefreshingLabel,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A failed refresh above the cached list it could not confirm.
class _ChangedFilesRefreshFailed extends StatelessWidget {
  const _ChangedFilesRefreshFailed({required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 8, 0),
      child: Row(
        children: [
          CanopyIcon(
            glyph: CanopyGlyph.warningSign,
            tint: theme.colorScheme.error,
            size: 14,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Semantics(
              liveRegion: true,
              child: Text(
                message,
                key: const ValueKey('changed-files-error'),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          ),
          if (onRetry case final onRetry?)
            TextButton(
              key: const ValueKey('retry-changed-files'),
              onPressed: onRetry,
              child: const Text('Retry'),
            ),
        ],
      ),
    );
  }
}

/// `UNCOMMITTED` / `COMMITTED` with the section's file count and totals.
class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.label, this.summary);

  final String label;
  final ChangedFilesSummary summary;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final count = summary.fileCount;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 2),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                fontWeight: AppTypography.emphasisWeight,
                fontVariations: AppTypography.emphasisVariations,
              ),
            ),
          ),
          Text(
            '$count file${count == 1 ? '' : 's'}',
            style: theme.textTheme.labelSmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          if (summary.insertions > 0 || summary.deletions > 0) ...[
            const SizedBox(width: 8),
            _LineCounts(
              insertions: summary.insertions,
              deletions: summary.deletions,
            ),
          ],
        ],
      ),
    );
  }
}

/// Directory (and owning repo in multi-repo worktrees) shared by the rows
/// below it. The root directory reads as `/`.
class _DirectoryHeader extends StatelessWidget {
  const _DirectoryHeader(this.group);

  final ChangedFileDirectoryGroup group;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final label = [
      if (group.repoName case final repoName? when repoName.isNotEmpty)
        repoName,
      group.directory.isEmpty ? '/' : group.directory,
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      child: Text(
        label,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

/// One compact file row: status dot, file name over its status word, line
/// counts.
class _ChangedFileRow extends StatelessWidget {
  const _ChangedFileRow({required this.entry, required this.onTap});

  final ChangedFileEntry entry;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = StatusColors.of(context);
    final file = entry.file;
    final statusLabel = _statusLabel(file.status);
    return Semantics(
      button: true,
      excludeSemantics: true,
      label: '${entry.fileName}, $statusLabel',
      onTap: onTap,
      child: InkWell(
        key: ValueKey('changed-file:${file.repoId ?? ''}:${file.filePath}'),
        onTap: onTap,
        // DESIGN.md: touch targets at least 44 x 44.
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 7, 16, 7),
            child: Row(
              children: [
                // A colored status DOT, not an action glyph — matches the
                // desktop changed-files section. The status word under the
                // name keeps the status readable without color.
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: _statusColor(file.status, status),
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        entry.fileName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall,
                      ),
                      Text(
                        statusLabel,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                _LineCounts(
                  insertions: file.insertions ?? 0,
                  deletions: file.deletions ?? 0,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _LineCounts extends StatelessWidget {
  const _LineCounts({required this.insertions, required this.deletions});

  final int insertions;
  final int deletions;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = StatusColors.of(context);
    if (insertions == 0 && deletions == 0) return const SizedBox.shrink();
    return Text.rich(
      TextSpan(
        children: [
          if (insertions > 0)
            TextSpan(
              text: '+$insertions',
              style: TextStyle(
                color: status.success,
                fontWeight: AppTypography.emphasisWeight,
                fontVariations: AppTypography.emphasisVariations,
              ),
            ),
          if (insertions > 0 && deletions > 0) const TextSpan(text: '  '),
          if (deletions > 0)
            TextSpan(
              text: '-$deletions',
              style: TextStyle(
                color: status.failed,
                fontWeight: AppTypography.emphasisWeight,
                fontVariations: AppTypography.emphasisVariations,
              ),
            ),
        ],
      ),
      style: theme.textTheme.labelSmall,
    );
  }
}

/// Both status vocabularies are live on the wire (`RemoteControlChangedFile.status`):
/// word statuses (`'modified'`) from the snapshot path and porcelain codes
/// (`'M'`) from other producers. Accept both everywhere.
Color _statusColor(String status, StatusColors colors) => switch (status) {
  'added' || 'A' || 'untracked' || '?' || '??' => colors.success,
  'deleted' || 'D' => colors.destructive,
  'renamed' || 'R' => colors.special,
  _ => colors.neutral,
};

String _statusLabel(String status) => switch (status) {
  'added' || 'A' => 'Added',
  'deleted' || 'D' => 'Deleted',
  'modified' || 'M' => 'Modified',
  'renamed' || 'R' => 'Renamed',
  'untracked' || '?' || '??' => 'Untracked',
  _ => status,
};
