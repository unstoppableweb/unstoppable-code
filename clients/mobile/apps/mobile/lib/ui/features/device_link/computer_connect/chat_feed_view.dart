import 'package:flutter/widgets.dart';
import 'package:mobile/ui/core/chat/view_models/response_action_target.dart';
import 'package:mobile/ui/core/chat/widgets/chat_feed.dart';
import 'package:mobile/ui/core/chat/widgets/chat_transcript_landing.dart';

import 'chat_feed_model.dart';

/// Renders the Rust core's transcript rows.
class ComputerChatFeedView extends StatefulWidget {
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
    this.landingPlaceholder,
    this.onInitialLanding,
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
  final Widget? landingPlaceholder;

  final VoidCallback? onInitialLanding;

  @override
  State<ComputerChatFeedView> createState() => _ComputerChatFeedViewState();
}

class _ComputerChatFeedViewState extends State<ComputerChatFeedView> {
  bool _landed = false;

  bool _initialLanding(ChatTranscriptLanded _) {
    if (_landed) return false;
    if (widget.landingPlaceholder != null) {
      setState(() => _landed = true);
    } else {
      _landed = true;
    }
    widget.onInitialLanding?.call();
    return false;
  }

  @override
  Widget build(BuildContext context) => Stack(
    fit: StackFit.expand,
    children: [
      if (!_landed)
        if (widget.landingPlaceholder case final preview?)
          Padding(
            padding: EdgeInsets.only(
              top: widget.topContentInset,
              bottom: widget.bottomActionInset,
            ),
            child: preview,
          ),
      IgnorePointer(
        key: const ValueKey('live-transcript'),
        ignoring: !_landed && widget.landingPlaceholder != null,
        child: NotificationListener<ChatTranscriptLanded>(
          onNotification: _initialLanding,
          child: ChatFeed(
            chatId: widget.chatId,
            messages: widget.feed.messages,
            rows: (footers) => widget.feed.project(footerTurns: footers),
            onToggleTurn: widget.onToggleTurn,
            onLoadOlder: widget.onLoadOlder,
            loadingOlder: widget.loadingOlder,
            trailing: widget.trailing,
            turnFooters: widget.turnFooters,
            topContentInset: widget.topContentInset,
            bottomActionInset: widget.bottomActionInset,
            onForkResponse: widget.onForkResponse,
            forkEnabled: widget.forkEnabled,
          ),
        ),
      ),
    ],
  );
}
