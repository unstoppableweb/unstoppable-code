import 'package:flutter/material.dart';
import 'package:mobile/data/models/turn_feedback.dart';

/// Reason + optional free-text comment collected after a thumbs-down.
///
/// The rating itself is already recorded before this sheet ever opens (see
/// `TurnFeedbackRow.onThumbsDown`) — this only ever amends it. A `null`
/// [reason] and [comment] pair (returned when both fields are empty) is not
/// reachable through Submit, since Submit disables itself in that state; it
/// is reachable through Skip or a dismiss, both of which are represented by
/// [showTurnFeedbackSheet] returning `null` for the whole detail instead.
final class TurnFeedbackDetail {
  const TurnFeedbackDetail({this.reason, this.comment});

  final TurnFeedbackReason? reason;
  final String? comment;
}

/// Opens the thumbs-down detail sheet: a [Wrap] of reason chips plus an
/// optional comment field. Returns `null` when the user skips or dismisses
/// the sheet (swipe-down, tap-outside, back/Escape) — none of those paths
/// touch the rating already recorded by the caller.
///
/// When [onSubmit] is provided, the sheet stays open until it accepts the
/// detail. A rejected submit leaves the selected reason and typed comment in
/// place and shows an actionable retry message instead of silently discarding
/// either value.
Future<TurnFeedbackDetail?> showTurnFeedbackSheet(
  BuildContext context, {
  Future<bool> Function(TurnFeedbackDetail detail)? onSubmit,
}) {
  return showModalBottomSheet<TurnFeedbackDetail>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (sheetContext) => Padding(
      // Keeps Submit above the keyboard once the comment field is focused —
      // without this the on-screen keyboard covers the actions on a real
      // phone.
      padding: EdgeInsets.only(
        bottom: MediaQuery.viewInsetsOf(sheetContext).bottom,
      ),
      child: _TurnFeedbackSheetBody(onSubmit: onSubmit),
    ),
  );
}

class _TurnFeedbackSheetBody extends StatefulWidget {
  const _TurnFeedbackSheetBody({this.onSubmit});

  final Future<bool> Function(TurnFeedbackDetail detail)? onSubmit;

  @override
  State<_TurnFeedbackSheetBody> createState() => _TurnFeedbackSheetBodyState();
}

class _TurnFeedbackSheetBodyState extends State<_TurnFeedbackSheetBody> {
  TurnFeedbackReason? _reason;
  final TextEditingController _commentController = TextEditingController();
  bool _submitting = false;
  bool _submitFailed = false;

  @override
  void initState() {
    super.initState();
    // Submit's enabled state depends on comment text, not just the reason.
    _commentController.addListener(_onCommentChanged);
  }

  @override
  void dispose() {
    _commentController.removeListener(_onCommentChanged);
    _commentController.dispose();
    super.dispose();
  }

  void _onCommentChanged() => setState(() {});

  Future<void> _submit() async {
    final comment = _commentController.text.trim();
    final detail = TurnFeedbackDetail(
      reason: _reason,
      comment: comment.isEmpty ? null : comment,
    );
    final onSubmit = widget.onSubmit;
    if (onSubmit == null) {
      Navigator.of(context).pop(detail);
      return;
    }

    setState(() {
      _submitting = true;
      _submitFailed = false;
    });
    // Deliberately caught rather than allowed to escape. `_submitting`
    // disables the TextField, Skip AND Submit, and is cleared only on the two
    // paths below — so a throw here leaves the sheet permanently inert with
    // the modal barrier as its only exit and the typed comment destroyed on
    // dismissal. That is the same wedge the stalled-submit rounds fixed, it
    // contradicts this file's own promise that a rejected submit "leaves the
    // selected reason and typed comment in place", and the sibling
    // `feedback_report_sheet.dart` already guards the identical call.
    //
    // A throw and a `false` are the same outcome to the user: the detail did
    // not land. No live caller throws today — `TurnFeedbackController` returns
    // a bool — so this is a latent guard, kept because the callback's type is
    // what a future caller will read, and nothing in it forbids throwing.
    bool accepted;
    try {
      accepted = await onSubmit(detail);
    } catch (_) {
      accepted = false;
    }
    if (!mounted) return;
    if (accepted) {
      Navigator.of(context).pop(detail);
      return;
    }
    setState(() {
      _submitting = false;
      _submitFailed = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final canSubmit =
        _reason != null || _commentController.text.trim().isNotEmpty;

    return SingleChildScrollView(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('What went wrong?', style: theme.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
              'Optional, but it helps us fix it faster.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 16),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final reason in TurnFeedbackReason.values)
                  ChoiceChip(
                    label: Text(turnFeedbackReasonLabel(reason)),
                    selected: _reason == reason,
                    // ChoiceChip passes the toggled-to state, not the tapped
                    // chip's identity, so tapping the already-selected chip
                    // arrives here as `selected: false` — clear to null
                    // rather than re-select it.
                    onSelected: (selected) => setState(() {
                      _reason = selected ? reason : null;
                    }),
                  ),
              ],
            ),
            const SizedBox(height: 16),
            TextField(
              key: const ValueKey('turn-feedback-comment'),
              controller: _commentController,
              enabled: !_submitting,
              autofocus: true,
              maxLines: 4,
              maxLength: maxTurnFeedbackCommentLength,
              textInputAction: TextInputAction.newline,
              decoration: const InputDecoration(
                hintText: 'Add a comment (optional)',
                border: OutlineInputBorder(),
              ),
            ),
            if (_submitFailed) ...[
              const SizedBox(height: 8),
              Text(
                'Could not submit feedback. Please try again.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
            ],
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: _submitting
                      ? null
                      : () => Navigator.of(context).pop(),
                  child: const Text('Skip'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  key: const ValueKey('turn-feedback-submit'),
                  onPressed: canSubmit && !_submitting ? _submit : null,
                  child: const Text('Submit'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
