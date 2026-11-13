import 'package:flutter/material.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/core/design-system/search-field/canopy_search_field.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/navigation/home_recent_chats.dart';
import 'package:mobile/ui/core/widgets/chat_list_notice.dart';
import 'home_recent_chat_row.dart';
import 'home_recent_chats_builder.dart';
import 'workspace_context_switcher.dart';

/// The same searchable history stays mounted while moving between a compact
/// list and the leading pane. Navigation belongs to the adjacent rail.
class HomeChatSidebar extends StatefulWidget {
  const HomeChatSidebar({
    super.key,
    required this.onOpenChat,
    required this.showsRecentChat,
  });
  final ValueChanged<HomeRecentChat> onOpenChat;
  final bool showsRecentChat;
  @override
  State<HomeChatSidebar> createState() => HomeChatSidebarState();
}

class HomeChatSidebarState extends State<HomeChatSidebar> {
  final _search = TextEditingController();
  final _searchKey = GlobalKey();

  void focusSearch() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final context = _searchKey.currentContext;
      if (context != null) FocusScope.of(context).requestFocus(_focus);
    });
  }

  final _focus = FocusNode();

  @override
  void dispose() {
    _search.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Material(
    key: const ValueKey('home-chat-sidebar'),
    color: AppColors.of(context).surface,
    child: SafeArea(
      child: LayoutBuilder(
        builder: (context, constraints) => Column(
          children: [
            Expanded(
              child: HomeRecentChatsBuilder(
                builder: (context, chats, notice) {
                  final query = _search.text.trim().toLowerCase();
                  final matches = chats
                      .where(
                        (chat) => '${chat.title} ${chat.computerName}'
                            .toLowerCase()
                            .contains(query),
                      )
                      .toList();
                  return ListView(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 8,
                    ),
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                        child: Align(
                          alignment: AlignmentDirectional.centerStart,
                          child: Text(
                            Brand.shortName,
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                        ),
                      ),
                      const WorkspaceContextRow(),

                      if (matches.isEmpty)
                        (query.isEmpty ? notice : null) ??
                            ChatListNotice(
                              message: query.isEmpty
                                  ? 'No recent chats. Start a chat or connect a computer.'
                                  : 'No chats match your search.',
                            ),
                      for (final chat in matches)
                        HomeRecentChatRow(
                          key: ValueKey('home-recent-${chat.key}'),
                          entry: chat,
                          maxLines: 2,
                          selected: widget.showsRecentChat && chat.isCurrent(),
                          onTap: () => widget.onOpenChat(chat),
                        ),
                    ],
                  );
                },
              ),
            ),
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: constraints.maxHeight),
              child: SingleChildScrollView(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: CanopySearchField(
                    key: _searchKey,
                    controller: _search,
                    focusNode: _focus,
                    hintText: 'Search recent chats',
                    onChanged: (_) => setState(() {}),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
