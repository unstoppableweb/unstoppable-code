import 'package:flutter/widgets.dart';
import 'package:mobile/data/models/workspace_context.dart';

/// Most rows per computer the drawer shows before older history is cut off.
const int recentChatsLimit = 30;

/// Why a row carries the attention dot, if it does.
enum RecentChatAttention { none, unread, awaitingAnswer }

/// One row of the drawer's Recents list.
final class HomeRecentChat {
  const HomeRecentChat({
    required this.key,
    required this.title,
    required this.computerName,
    required this.attention,
    required this.activityAt,
    required this.open,
    required this.isCurrent,
    this.locationLabel,
  });

  /// Stable identity across computers, safe for widget keys.
  final String key;

  /// Reads the live selection, including conversation switches inside the page.
  final bool Function() isCurrent;
  final String title;

  /// The computer the chat runs on, which the row is announced with.
  final String computerName;
  final String? locationLabel;
  final RecentChatAttention attention;

  /// Sort key; null when the computer does not say when it was last active.
  final DateTime? activityAt;

  /// Opens the chat from [context], which must outlive the drawer. The shell
  /// hosts [showChat]'s page until another destination is selected; completing
  /// this future releases the chat's selection before the next chat opens.
  /// Network cleanup retires in the background with selection ownership checks.
  final Future<void> Function(
    BuildContext context,
    Future<void> Function(Widget page) showChat,
  )
  open;
}

/// What the drawer shows for the selected workspace context.
typedef HomeRecentChatsSnapshot = ({
  List<HomeRecentChat> chats,

  /// Whether any connected computer is still reading its first inventory.
  bool loading,

  /// Whether any computer is connected, so an empty list means no chats.
  bool connected,
});

/// App composition supplies the drawer's Recents, so the shell owns only
/// navigation and never reaches a computer connection itself.
abstract interface class HomeRecentChatsSource implements Listenable {
  HomeRecentChatsSnapshot read(WorkspaceContext context);

  /// Re-reads the drawer's inventory without changing the selected chat.
  Future<void> refresh();
}
