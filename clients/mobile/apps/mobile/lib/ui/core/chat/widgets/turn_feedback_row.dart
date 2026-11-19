import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/data/models/turn_feedback.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/widgets/chat_glyph.dart';

/// Thumbs up/down for one completed turn. Display only: [onRate] receives the
/// next rating, null when the selected thumb is tapped again to clear it.
///
/// The labels match the desktop `TurnFeedbackControl` aria labels.
class TurnFeedbackRow extends StatelessWidget {
  const TurnFeedbackRow({
    super.key,
    required this.rating,
    required this.onRate,
  });

  final TurnFeedbackRating? rating;

  /// Null disables both thumbs.
  final ValueChanged<TurnFeedbackRating?>? onRate;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final onRate = this.onRate;
    Widget thumb({
      required TurnFeedbackRating value,
      required String label,
      required ChatGlyph glyph,
      required ChatGlyph selectedGlyph,
    }) {
      final selected = rating == value;
      return Semantics(
        selected: selected,
        child: CanopyIconButton.custom(
          key: ValueKey('turn-feedback-${turnFeedbackRatingWire(value)}'),
          tooltip: label,
          size: CanopyIconButtonSize.small,
          tint: selected ? colors.foreground : null,
          glyphSize: 16,
          onPressed: onRate == null
              ? null
              : () => onRate(selected ? null : value),
          iconBuilder: (tint, size) => ChatIcon(
            glyph: selected ? selectedGlyph : glyph,
            size: size,
            color: tint,
          ),
        ),
      );
    }

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        thumb(
          value: TurnFeedbackRating.up,
          label: 'Good response',
          glyph: ChatGlyph.thumbsUp,
          selectedGlyph: ChatGlyph.thumbsUpFilled,
        ),
        thumb(
          value: TurnFeedbackRating.down,
          label: 'Bad response',
          glyph: ChatGlyph.thumbsDown,
          selectedGlyph: ChatGlyph.thumbsDownFilled,
        ),
      ],
    );
  }
}
