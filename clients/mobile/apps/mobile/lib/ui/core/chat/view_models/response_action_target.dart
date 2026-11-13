/// A completed response's desktop-owned fork point. The canonical snapshot
/// uses the last message; Portal's renderer identifies the turn by its head.
final class ResponseActionTarget {
  const ResponseActionTarget({
    required this.chatId,
    required this.turnKey,
    required this.atMessageId,
  });

  final String chatId;
  final String turnKey;
  final String atMessageId;
}

typedef ForkResponse = Future<void> Function(ResponseActionTarget target);
