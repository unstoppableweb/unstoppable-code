import 'package:flutter/widgets.dart';
import 'package:mobile/ui/core/chat/view_models/transcript_projection.dart';

import 'chat_transcript_row.dart';

/// A read-only transcript that can paint the latest cached rows immediately.
class CachedChatTranscript extends StatelessWidget {
  const CachedChatTranscript({super.key, required this.rows});

  final List<TranscriptRow> rows;

  @override
  Widget build(BuildContext context) => ExcludeFocus(
    child: IgnorePointer(
      child: Align(
        alignment: Alignment.topCenter,
        child: ListView.builder(
          reverse: true,
          shrinkWrap: true,
          primary: false,
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
          itemCount: rows.length,
          itemBuilder: (_, index) =>
              ChatTranscriptRow(row: rows[rows.length - 1 - index]),
        ),
      ),
    ),
  );
}
