import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/navigation/home_recent_chats.dart';

/// One line of chat history: where it runs, its title, and an attention dot.
class HomeRecentChatRow extends StatelessWidget {
  const HomeRecentChatRow({
    required this.entry,
    this.onTap,
    this.selected = false,
    this.maxLines = 1,
    super.key,
  });

  final HomeRecentChat entry;
  final VoidCallback? onTap;
  final bool selected;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final status = StatusColors.of(context);
    const glyph = CanopyGlyph.macbook;
    final location = 'Chat on ${entry.computerName}';
    final (dotColor, dotLabel) = switch (entry.attention) {
      RecentChatAttention.none => (null, null),
      RecentChatAttention.unread => (status.unread, 'Unread'),
      RecentChatAttention.awaitingAnswer => (
        status.warning,
        'Needs your answer',
      ),
    };
    return ListTile(
      selected: selected,
      selectedTileColor: colorScheme.surfaceContainerHighest,
      dense: true,
      visualDensity: VisualDensity.compact,
      minTileHeight: 44,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      leading: Semantics(
        label: location,
        child: CanopyIcon(
          glyph: glyph,
          size: 20,
          tint: colorScheme.onSurfaceVariant,
        ),
      ),
      title: Text(
        entry.title,
        maxLines: maxLines,
        overflow: TextOverflow.ellipsis,
        style: Theme.of(context).textTheme.bodyMedium,
      ),
      trailing: dotColor == null
          ? null
          : Tooltip(
              message: dotLabel,
              child: Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: dotColor,
                  shape: BoxShape.circle,
                ),
              ),
            ),
      onTap: onTap,
    );
  }
}
