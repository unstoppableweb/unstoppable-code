import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/chat/view_models/transcript_projection.dart';

/// The Rust transcript rows and expansion intents for the selected chat.
abstract interface class ComputerChatFeed {
  /// The presented messages, oldest first.
  List<ChatMessage> get messages;

  /// Every presented message's [FeedMessageOutline], oldest first, whether
  /// or not [messages] holds it in full.
  List<FeedMessageOutline> get outline;

  /// The rows [ChatFeed] draws; null lets it group [messages] itself.

  /// Open turns and step runs, by key. Cleared when the chat is left.
  void toggleTurn(String key);

  /// Returns the current rows and reports which turns have a footer.
  List<TranscriptRow> project({Set<String> footerTurns = const {}});
  void dispose();
}

/// What turn grouping reads of a presented message: its id, whether it is
/// a user message, whether that continues the turn, and
/// [hasRenderableContent].
typedef FeedMessageOutline = ({
  String messageId,
  bool user,
  bool continuesTurn,
  bool renderable,
});
