import 'package:flutter/widgets.dart';
import 'package:mobile/ui/core/chat/view_models/response_action_target.dart';
import 'package:mobile/ui/core/chat/widgets/chat_feed.dart';

import 'chat_feed_model.dart';

/// Renders the Rust core's transcript rows.
class ComputerChatFeedView extends StatelessWidget {
  const ComputerChatFeedView({
    super.key,
    required this.feed,
    required this.chatId,
    required this.onToggleTurn,
    this.onLoadOlder,
    this.loadingOlder = false,
    this.trailing = const [],
    this.turnFooters = const {},
    this.topContentInset = 0,
    this.bottomActionInset = 0,
    this.onForkResponse,
    this.forkEnabled = true,
  });

  final ComputerChatFeed feed;
  final String chatId;
  final ValueChanged<String> onToggleTurn;
  final VoidCallback? onLoadOlder;
  final bool loadingOlder;
  final List<Widget> trailing;
  final Map<String, Widget> turnFooters;
  final double topContentInset;
  final double bottomActionInset;
  final ForkResponse? onForkResponse;
  final bool forkEnabled;

  @override
  Widget build(BuildContext context) => ChatFeed(
    chatId: chatId,
    messages: feed.messages,
    rows: (footers) => feed.project(footerTurns: footers),
    onToggleTurn: onToggleTurn,
    onLoadOlder: onLoadOlder,
    loadingOlder: loadingOlder,
    trailing: trailing,
    turnFooters: turnFooters,
    topContentInset: topContentInset,
    bottomActionInset: bottomActionInset,
    onForkResponse: onForkResponse,
    forkEnabled: forkEnabled,
  );
}
