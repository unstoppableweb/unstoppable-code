/// Wire model for turn-level thumbs up/down feedback (CAN-1957).
///
/// Mirrors `packages/protocol/src/turn-feedback/index.ts`. The wire strings
/// here are the server's stored enum values and must match it exactly.
///
/// Unknown decoding is deliberately asymmetric between the two enums:
/// - An unrecognized `reason` decodes to `null` rather than throwing, so a
///   newer server taxonomy degrades to "no reason shown" instead of breaking
///   the transcript. `reason` is optional and expected to grow over time.
/// - An unrecognized `rating` makes [TurnFeedbackSummary.fromJson] throw a
///   [FormatException] instead. `rating` is a mandatory, closed two-value
///   axis (`up`/`down`) — the row cannot exist without one, so a value
///   outside that set means the payload is corrupt, not "a newer kind of
///   rating we don't render yet".
library;

enum TurnFeedbackRating { up, down }

enum TurnFeedbackReason {
  incorrectOrDidntWork,
  ignoredInstructions,
  changedMoreThanAsked,
  brokeSomething,
  gotStuck,
  missedContext,
  unsafeAction,
  other,
}

/// Local sync status of a rating. A `failed` rating still renders as selected —
/// a rejected upload must never silently revert the user's tap.
enum TurnFeedbackSyncState { pending, synced, failed }

String turnFeedbackRatingWire(TurnFeedbackRating rating) => switch (rating) {
  TurnFeedbackRating.up => 'up',
  TurnFeedbackRating.down => 'down',
};

TurnFeedbackRating? turnFeedbackRatingFromWire(Object? value) =>
    switch (value) {
      'up' => TurnFeedbackRating.up,
      'down' => TurnFeedbackRating.down,
      _ => null,
    };

String turnFeedbackReasonWire(TurnFeedbackReason reason) => switch (reason) {
  TurnFeedbackReason.incorrectOrDidntWork => 'incorrect-or-didnt-work',
  TurnFeedbackReason.ignoredInstructions => 'ignored-instructions',
  TurnFeedbackReason.changedMoreThanAsked => 'changed-more-than-asked',
  TurnFeedbackReason.brokeSomething => 'broke-something',
  TurnFeedbackReason.gotStuck => 'got-stuck',
  TurnFeedbackReason.missedContext => 'missed-context',
  TurnFeedbackReason.unsafeAction => 'unsafe-action',
  TurnFeedbackReason.other => 'other',
};

TurnFeedbackReason? turnFeedbackReasonFromWire(Object? value) {
  for (final reason in TurnFeedbackReason.values) {
    if (turnFeedbackReasonWire(reason) == value) return reason;
  }
  return null;
}

/// Chip copy, matching the desktop dialog's `REASON_LABELS` word for word so
/// the two products describe the same category identically.
String turnFeedbackReasonLabel(TurnFeedbackReason reason) => switch (reason) {
  TurnFeedbackReason.incorrectOrDidntWork => "Incorrect or didn't work",
  TurnFeedbackReason.ignoredInstructions => 'Ignored my instructions',
  TurnFeedbackReason.changedMoreThanAsked => 'Changed more than I asked',
  TurnFeedbackReason.brokeSomething => 'Broke something that worked',
  TurnFeedbackReason.gotStuck => 'Got stuck or went in circles',
  TurnFeedbackReason.missedContext => 'Missed important context',
  TurnFeedbackReason.unsafeAction => 'Took an unsafe action',
  TurnFeedbackReason.other => 'Something else',
};

/// Maximum accepted comment length, matching
/// `MAX_TURN_FEEDBACK_COMMENT_LENGTH` in the protocol package.
const int maxTurnFeedbackCommentLength = 4000;

/// A rating as the server reports it. Never carries the comment body.
final class TurnFeedbackSummary {
  const TurnFeedbackSummary({
    required this.feedbackId,
    required this.clientUserMessageId,
    required this.rating,
    required this.hasComment,
    this.reason,
  });

  final String feedbackId;
  final String clientUserMessageId;
  final TurnFeedbackRating rating;
  final TurnFeedbackReason? reason;
  final bool hasComment;

  factory TurnFeedbackSummary.fromJson(Map<String, dynamic> json) {
    final rating = turnFeedbackRatingFromWire(json['rating']);
    if (rating == null) {
      throw const FormatException('Unrecognized turn feedback rating');
    }
    final id = json['feedbackId'];
    final messageId = json['clientUserMessageId'];
    if (id is! String || messageId is! String) {
      throw const FormatException('Turn feedback row is missing its ids');
    }
    return TurnFeedbackSummary(
      feedbackId: id,
      clientUserMessageId: messageId,
      rating: rating,
      reason: turnFeedbackReasonFromWire(json['reason']),
      hasComment: json['hasComment'] == true,
    );
  }
}

/// The renderer's per-turn state: what is selected and whether it reached the
/// server yet.
final class TurnFeedbackEntry {
  const TurnFeedbackEntry({
    required this.rating,
    required this.syncState,
    this.feedbackId,
    this.reason,
  });

  final TurnFeedbackRating rating;
  final TurnFeedbackSyncState syncState;
  final String? feedbackId;
  final TurnFeedbackReason? reason;

  TurnFeedbackEntry copyWith({
    TurnFeedbackRating? rating,
    TurnFeedbackSyncState? syncState,
    String? feedbackId,
    TurnFeedbackReason? reason,
  }) => TurnFeedbackEntry(
    rating: rating ?? this.rating,
    syncState: syncState ?? this.syncState,
    feedbackId: feedbackId ?? this.feedbackId,
    reason: reason ?? this.reason,
  );

  static TurnFeedbackEntry fromSummary(TurnFeedbackSummary summary) =>
      TurnFeedbackEntry(
        rating: summary.rating,
        syncState: TurnFeedbackSyncState.synced,
        feedbackId: summary.feedbackId,
        reason: summary.reason,
      );
}
