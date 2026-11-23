import 'dart:math';
import 'package:flutter/material.dart';
import 'package:mobile/data/models/changed_file.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'unified_diff_lines.dart';

/// Upper bound on rendered patch lines. The desktop reads a diff with a
/// 16 MB git buffer and no pagination, so one generated file can arrive as
/// a very long string; past this the screen shows a notice instead of
/// inflating a list nobody scrolls to the end of.
const int kRemoteFileDiffMaxLines = 5000;

/// Upper bound on the displayed length of one patch line. This keeps a
/// minified or generated line from creating an enormous horizontal layout.
const int kRemoteFileDiffMaxCharactersPerLine = 1000;

class FileDiffNotice extends StatelessWidget {
  const FileDiffNotice({
    super.key,
    required this.padding,
    required this.message,
    this.action,
  });

  final EdgeInsets padding;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: padding.add(const EdgeInsets.symmetric(horizontal: 24)),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              message,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            if (action case final action?) ...[
              const SizedBox(height: 12),
              action,
            ],
          ],
        ),
      ),
    );
  }
}

class FileDiffView extends StatelessWidget {
  const FileDiffView({
    super.key,
    required this.padding,
    required this.file,
    required this.lines,
    required this.truncated,
    required this.lineLengthTruncated,
    this.cacheNotice,
  });

  final EdgeInsets padding;
  final RemoteChangedFile file;
  final List<UnifiedDiffLine> lines;
  final bool truncated;
  final bool lineLengthTruncated;
  final String? cacheNotice;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = StatusColors.of(context);
    final header = _DiffHeader(
      file: file,
      truncated: truncated,
      lineLengthTruncated: lineLengthTruncated,
      cacheNotice: cacheNotice,
    );
    if (lines.isEmpty) {
      return ListView(
        padding: padding,
        children: [
          header,
          const SizedBox(height: 48),
          Center(
            child: Text(
              'No changes to show.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      );
    }
    // The vertical list stays lazy; the horizontal axis is one scroll view
    // sized from the longest line so long code never wraps into unreadable
    // fragments. Monospace glyphs are ~0.6em wide.
    final lineStyle = AppTypography.code;
    final charWidth = (lineStyle.fontSize ?? 13) * 0.62;
    final longest = lines.fold<int>(0, (m, line) => max(m, line.text.length));
    final contentWidth = longest * charWidth + 32;
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = max(contentWidth, constraints.maxWidth);
        return SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: SizedBox(
            width: width,
            child: ListView.builder(
              padding: padding,
              itemCount: lines.length + 1,
              itemBuilder: (context, index) {
                if (index == 0) {
                  // The list is as wide as the longest line; the header
                  // must wrap at the viewport instead, so loosen the
                  // cross-axis constraint before sizing it.
                  return Align(
                    alignment: Alignment.topLeft,
                    child: SizedBox(width: constraints.maxWidth, child: header),
                  );
                }
                final line = lines[index - 1];
                final (
                  Color? background,
                  Color foreground,
                ) = switch (line.kind) {
                  UnifiedDiffLineKind.add => (
                    status.success.withValues(alpha: 0.12),
                    status.success,
                  ),
                  UnifiedDiffLineKind.del => (
                    status.destructive.withValues(alpha: 0.12),
                    status.destructive,
                  ),
                  UnifiedDiffLineKind.hunk => (
                    status.unread.withValues(alpha: 0.12),
                    status.unread,
                  ),
                  UnifiedDiffLineKind.meta => (
                    null,
                    theme.colorScheme.onSurfaceVariant,
                  ),
                  UnifiedDiffLineKind.context => (
                    null,
                    theme.colorScheme.onSurface,
                  ),
                };
                return Container(
                  color: background,
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Text(
                    line.text,
                    softWrap: false,
                    overflow: TextOverflow.visible,
                    style: lineStyle.copyWith(color: foreground),
                  ),
                );
              },
            ),
          ),
        );
      },
    );
  }
}

class _DiffHeader extends StatelessWidget {
  const _DiffHeader({
    required this.file,
    this.truncated = false,
    this.lineLengthTruncated = false,
    this.cacheNotice,
  });

  final RemoteChangedFile file;

  /// Shown up front (not at the end of a lazy list nobody reaches) when the
  /// patch was clipped to [kRemoteFileDiffMaxLines].
  final bool truncated;
  final bool lineLengthTruncated;
  final String? cacheNotice;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = StatusColors.of(context);
    final insertions = file.insertions ?? 0;
    final deletions = file.deletions ?? 0;
    final details = [
      if (file.repoName case final repoName? when repoName.isNotEmpty) repoName,
      file.committed ? 'committed' : 'uncommitted',
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (cacheNotice case final notice?)
            Text(
              notice,
              key: const ValueKey('file-diff-cache-notice'),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          Text(
            file.filePath,
            style: theme.textTheme.bodySmall?.copyWith(
              fontFamily: AppTypography.monoFamily,
            ),
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              Expanded(
                child: Text(
                  details,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              if (insertions > 0)
                Text(
                  '+$insertions',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: status.success,
                  ),
                ),
              if (insertions > 0 && deletions > 0) const SizedBox(width: 8),
              if (deletions > 0)
                Text(
                  '-$deletions',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: status.destructive,
                  ),
                ),
            ],
          ),
          if (truncated) ...[
            const SizedBox(height: 6),
            Text(
              'Showing the first $kRemoteFileDiffMaxLines lines.',
              style: theme.textTheme.labelSmall?.copyWith(
                color: status.warning,
              ),
            ),
          ],
          if (lineLengthTruncated) ...[
            const SizedBox(height: 6),
            Text(
              'Some lines were shortened to '
              '$kRemoteFileDiffMaxCharactersPerLine characters.',
              style: theme.textTheme.labelSmall?.copyWith(
                color: status.warning,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
