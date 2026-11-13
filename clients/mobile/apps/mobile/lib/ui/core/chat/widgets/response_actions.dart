import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';
import 'package:mobile/ui/core/chat/view_models/response_action_target.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/widgets/chat_list_notice.dart';

/// The quiet reply footer, shared by every native chat transport. Controls
/// retain the design system's 48px touch targets even though the glyphs are small.
class ResponseActions extends StatefulWidget {
  const ResponseActions({
    super.key,
    required this.text,
    required this.target,
    this.occurredAt,
    this.onFork,
    this.forkEnabled = true,
    this.createTimer = Timer.new,
  });

  final String text;
  final ResponseActionTarget target;
  final DateTime? occurredAt;
  final ForkResponse? onFork;
  final bool forkEnabled;
  final Timer Function(Duration, void Function()) createTimer;

  @override
  State<ResponseActions> createState() => _ResponseActionsState();
}

class _ResponseActionsState extends State<ResponseActions> {
  bool _copied = false, _copying = false, _forking = false;
  String? _error;
  Timer? _resetCopy;

  @override
  void dispose() {
    _resetCopy?.cancel();
    super.dispose();
  }

  Future<void> _copy() async {
    if (_copying) return;
    setState(() {
      _copying = true;
      _error = null;
    });
    try {
      await Clipboard.setData(ClipboardData(text: widget.text));
      if (!mounted) return;
      _resetCopy?.cancel();
      setState(() => _copied = true);
      _resetCopy = widget.createTimer(const Duration(seconds: 2), () {
        if (mounted) setState(() => _copied = false);
      });
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Could not copy the response. Try again.');
      }
    } finally {
      if (mounted) setState(() => _copying = false);
    }
  }

  Future<void> _fork() async {
    final fork = widget.onFork;
    if (fork == null || !widget.forkEnabled || _forking) return;
    setState(() {
      _forking = true;
      _error = null;
    });
    try {
      await fork(widget.target);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'Could not confirm the fork. Check the chat list before trying again.',
        );
      }
    } finally {
      if (mounted) setState(() => _forking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final time = widget.occurredAt;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            CanopyIconButton(
              glyph: _copied
                  ? CanopyGlyph.checkmark1
                  : CanopyGlyph.squareBehindSquare1,
              tooltip: _copied ? 'Copied' : 'Copy response',
              size: CanopyIconButtonSize.small,
              glyphSize: 16,
              tint: colors.foregroundMuted,
              onPressed: _copying ? null : _copy,
            ),
            if (widget.onFork != null)
              CanopyIconButton.custom(
                iconBuilder: (tint, size) => _forking
                    ? CometSpinner(
                        semanticsLabel: 'Forking chat',
                        size: size,
                        color: tint,
                      )
                    : RotatedBox(
                        quarterTurns: 1,
                        child: CanopyIcon(
                          glyph: CanopyGlyph.forkSplit,
                          size: size,
                          tint: tint,
                        ),
                      ),
                tooltip: _forking ? 'Forking chat…' : 'Fork chat',
                size: CanopyIconButtonSize.small,
                glyphSize: 16,
                tint: colors.foregroundMuted,
                onPressed: widget.forkEnabled && !_forking ? _fork : null,
              ),
            if (time != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Text(
                  MaterialLocalizations.of(context).formatTimeOfDay(
                    TimeOfDay.fromDateTime(time.toLocal()),
                    alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(
                      context,
                    ),
                  ),
                  style: AppTypography.bodySmall.copyWith(
                    color: colors.foregroundMuted,
                  ),
                ),
              ),
          ],
        ),
        if (_error case final message?) ChatListNotice(message: message),
      ],
    );
  }
}
