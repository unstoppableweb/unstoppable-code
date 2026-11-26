import 'package:flutter/widgets.dart';

/// The live transcript has reached its initial scroll position.
class ChatTranscriptLanded extends Notification {
  const ChatTranscriptLanded();
}

/// Keeps the transcript in layout so it can find its scroll position.
class ChatTranscriptLandingGate extends StatelessWidget {
  const ChatTranscriptLandingGate({
    super.key,
    required this.landed,
    required this.child,
  });

  final bool landed;
  final Widget child;

  @override
  Widget build(BuildContext context) => ExcludeFocus(
    excluding: !landed,
    child: IgnorePointer(
      ignoring: !landed,
      child: Opacity(
        key: const ValueKey('remote-chat-transcript-visibility'),
        opacity: landed ? 1 : 0,
        child: child,
      ),
    ),
  );
}
