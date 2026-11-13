import 'dart:async';

import 'package:flutter/widgets.dart';

import 'home_recent_chats.dart';
import 'home_recent_chat_loading.dart';

/// Reveals the chosen chat immediately, then binds its live page after the
/// outgoing screen unmounts. A newer choice cancels an unfinished open.
class HomeRecentChatController extends ChangeNotifier {
  Widget? get page => _page;
  bool get preparing => _page is HomeRecentChatLoading;
  Widget? _page;
  Completer<void>? _closed;
  Future<void>? _opening;
  int _generation = 0;
  bool _disposed = false;

  Future<void> open(
    HomeRecentChat chat,
    BuildContext context, {
    Future<void> Function()? prepare,
  }) async {
    _close(notify: false);
    final generation = _generation;
    final loading = HomeRecentChatLoading(chat: chat);
    _page = loading;
    notifyListeners();
    await prepare?.call();
    await _opening;
    if (_disposed || generation != _generation || !context.mounted) return;
    final opening = chat.open(context, (page) {
      if (_disposed || generation != _generation || !context.mounted) {
        return Future.value();
      }
      final closed = Completer<void>();
      _closed = closed;
      _page = page;
      notifyListeners();
      return closed.future;
    });
    _opening = opening;
    try {
      await opening;
    } finally {
      if (identical(_opening, opening)) _opening = null;
      if (!_disposed &&
          generation == _generation &&
          identical(_page, loading)) {
        _page = null;
        notifyListeners();
      }
    }
  }

  void close() => _close();

  void _close({bool notify = true}) {
    _generation++;
    final closed = _closed;
    _closed = null;
    final hadPage = _page != null;
    _page = null;
    if (notify && hadPage && !_disposed) notifyListeners();
    if (closed != null) {
      // Unmount the outgoing screen before releasing its model's selection.
      // Its dispose must not hide a new chat using the same connection.
      unawaited(
        WidgetsBinding.instance.endOfFrame.then((_) => closed.complete()),
      );
    }
  }

  @override
  void dispose() {
    _disposed = true;
    close();
    super.dispose();
  }
}
