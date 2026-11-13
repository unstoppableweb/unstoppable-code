import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/ui/core/workspace_context_label.dart';
import 'package:mobile/ui/core/widgets/chat_list_notice.dart';
import 'package:mobile/ui/core/navigation/home_recent_chats.dart';

/// Reads the drawer's Recents from the app-composed [HomeRecentChatsSource],
/// rebuilding only the drawer subtree when it changes.
class HomeRecentChatsBuilder extends StatelessWidget {
  const HomeRecentChatsBuilder({super.key, required this.builder});

  /// Builds the drawer from Recents and loading or empty feedback.
  final Widget Function(
    BuildContext context,
    List<HomeRecentChat> recentChats,
    Widget? notice,
  )
  builder;

  @override
  Widget build(BuildContext context) {
    final source = context.watch<HomeRecentChatsSource?>();
    final workspaceContext = context.watch<WorkspaceContext?>();
    if (source == null) return builder(context, const [], null);
    final recents = source.read(
      workspaceContext ?? const WorkspaceContext.personal(),
    );
    final label =
        context.watch<WorkspaceContextLabel?>()?.value ??
        WorkspaceContextLabel.fallback(workspaceContext);
    final Widget? notice;
    if (recents.chats.isNotEmpty || !recents.connected) {
      notice = null;
    } else if (recents.loading) {
      notice = const ChatListNotice(
        message: 'Loading chats from your computers…',
      );
    } else {
      notice = ChatListNotice(message: 'No recent chats in $label.');
    }
    return builder(context, recents.chats, notice);
  }
}
