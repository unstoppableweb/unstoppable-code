import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import '../chat/widgets/chat_body.dart';
import '../chat/widgets/chat_input.dart';
import '../chat/widgets/chat_location_subtitle.dart';
import '../chat/widgets/chat_provisioning.dart';
import 'home_navigation_scope.dart';
import 'home_recent_chats.dart';

/// The selected chat owns the pane from the tap, before old routes finish
/// disposing or the connection releases its previous selection.
class HomeRecentChatLoading extends StatefulWidget {
  const HomeRecentChatLoading({required this.chat, super.key});
  final HomeRecentChat chat;
  @override
  State<HomeRecentChatLoading> createState() => _HomeRecentChatLoadingState();
}

class _HomeRecentChatLoadingState extends State<HomeRecentChatLoading> {
  final _draft = TextEditingController();
  @override
  void dispose() {
    _draft.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => CanopyScaffold(
    appBar: CanopyAppBar(
      leading: HomeMenuButton.maybeOf(context, designSystem: true),
      content: Text(
        widget.chat.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: ChatLocationSubtitle(
        glyph: CanopyGlyph.macbook,
        location: 'Computer chat',
        text: widget.chat.locationLabel,
        computer: widget.chat.computerName,
      ),
    ),
    body: Builder(
      builder: (context) => Padding(
        padding: CanopyScaffold.contentPaddingOf(context),
        child: ChatBody(
          transcript: const ChatTranscriptLoading(
            label: 'Loading conversation…',
          ),
          composer: ChatInput(
            controller: _draft,
            enabled: false,
            sending: false,
            onSend: () {},
          ),
        ),
      ),
    ),
  );
}
