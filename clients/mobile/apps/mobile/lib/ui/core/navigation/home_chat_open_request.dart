import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'home_recent_chats.dart';

/// Finds the chat a notification names on the computer that owns it.
/// Provided by the destination that knows the phone's computers, such as
/// Computer connect; absent in shells that cannot open such a chat.
abstract interface class PushChatRouter {
  /// The chat's row, ready for the shell to open, or null when the computer
  /// is not saved on this phone, stays offline, or does not list the chat.
  /// Never throws.
  Future<HomeRecentChat?> resolve({
    required String computerId,
    required String clientChatId,
    required WorkspaceContext? workspaceContext,
  });
}

/// One chat waiting for the shell to open it. A notification tap can resolve
/// before the shell mounts on a cold start, so the request waits here until
/// [take] reads it. A newer request replaces one that was never taken.
final class HomeChatOpenRequests extends ChangeNotifier {
  HomeRecentChat? _pending;
  int _navigation = 0;

  /// Counts what the user opened in the shell (a detail screen or a Recents
  /// chat). A tap reads it before it waits and passes it to [request].
  int get navigation => _navigation;

  /// Called by the shell when the user opens something there.
  void noteNavigation() => _navigation++;

  /// Asks the shell to open [chat]. Dropped when the user opened something
  /// after [since], so a slow tap never replaces what they chose.
  void request(HomeRecentChat chat, {int? since}) {
    if (since != null && since != _navigation) return;
    _pending = chat;
    notifyListeners();
  }

  HomeRecentChat? take() {
    final chat = _pending;
    _pending = null;
    return chat;
  }
}
