import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:mobile/ui/core/chat/view_models/transcript_projection.dart';

/// One row of the feed's list: a transcript row or the feed's own chrome.
sealed class TranscriptItem {
  const TranscriptItem();
}

/// A message, steps summary or timer row of the transcript itself.
final class FeedRowItem extends TranscriptItem {
  const FeedRowItem(this.row);

  final TranscriptRow row;
}

/// Progress row pinned above the oldest message while an older-history page
/// is being fetched.
final class HistoryLoadingItem extends TranscriptItem {
  const HistoryLoadingItem();
}

/// A caller-supplied widget appended after the last turn (today: the awaiting
/// AskUserQuestion cards). It rides inside the same scrollable as the
/// transcript so an agent's question reads as the tail of its answer rather
/// than a shelf pinned above the composer.
final class TrailingItem extends TranscriptItem {
  const TrailingItem(this.child);

  final Widget child;
}

/// The first transcript row. It clears the overlaid app bar while still
/// allowing messages to scroll beneath that chrome after the user scrolls.
final class TopInsetSpacerItem extends TranscriptItem {
  const TopInsetSpacerItem(this.height);

  final double height;
}

/// The builder key for an item that carries one, so `findChildIndexCallback`
/// can remap its element when appended rows shift every index. Items without a
/// stable identity (the history spinner, the top inset) return null.
String? _itemKey(TranscriptItem item) => switch (item) {
  FeedRowItem(:final row) => row.key,
  TrailingItem(:final child) => switch (child.key) {
    ValueKey<String>(:final value) => value,
    _ => null,
  },
  _ => null,
};

/// Keeps offscreen row metadata and child-index lookup stable when only
/// composer/chrome state rebuilds the feed. Trailing widgets are compared by
/// identity, while the projection owns transcript and expansion invalidation.
class FeedItemsCache {
  List<TranscriptRow>? _rows;
  List<Widget> _trailing = const [];
  bool? _loadingOlder;
  double? _topInset;
  List<TranscriptItem> items = const [];
  Map<String, int> indexByKey = const {};

  bool update({
    required List<TranscriptRow> rows,
    required List<Widget> trailing,
    required bool loadingOlder,
    required double topInset,
  }) {
    if (identical(rows, _rows) &&
        listEquals(trailing, _trailing) &&
        loadingOlder == _loadingOlder &&
        topInset == _topInset) {
      return false;
    }
    _rows = rows;
    _trailing = List.of(trailing);
    _loadingOlder = loadingOlder;
    _topInset = topInset;
    items = [
      TopInsetSpacerItem(topInset + 8),
      if (loadingOlder) const HistoryLoadingItem(),
      for (final row in rows) FeedRowItem(row),
      for (final child in trailing) TrailingItem(child),
    ];
    indexByKey = {
      for (var i = 0; i < items.length; i++)
        if (_itemKey(items[i]) case final String key) key: i,
    };
    return true;
  }
}
