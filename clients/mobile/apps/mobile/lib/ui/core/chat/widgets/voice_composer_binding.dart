import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/services/speech_recognizer.dart';
import 'package:mobile/services/speech_to_text_recognizer.dart';
import 'package:mobile/ui/core/navigation/app_route_scope.dart';
import '../view_models/voice_dictation_controller.dart';
import 'voice_dictation_dialog.dart';

/// Owns local dictation for one visible draft. Speech never belongs to the
/// computer transport, and a late recognizer result cannot follow navigation.
class VoiceComposerBinding extends StatefulWidget {
  const VoiceComposerBinding({
    super.key,
    required this.draft,
    required this.target,
    required this.active,
    required this.builder,
    this.recognizer,
  });
  final TextEditingController draft;
  final Object? target;
  final bool active;
  final SpeechRecognizer? recognizer;
  final Widget Function(BuildContext, VoiceDictationController) builder;
  @override
  State<VoiceComposerBinding> createState() => _VoiceComposerBindingState();
}

class _VoiceComposerBindingState extends State<VoiceComposerBinding>
    with WidgetsBindingObserver {
  late final VoiceDictationController _voice;
  @override
  void initState() {
    super.initState();
    _voice = VoiceDictationController(
      draft: widget.draft,
      recognizer: widget.recognizer ?? SpeechToTextRecognizer(),
    )..addListener(_changed);
    WidgetsBinding.instance.addObserver(this);
  }

  void _changed() {
    final issue = _voice.takeIssue();
    if (issue == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (issue == VoiceDictationIssue.failed) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(
            const SnackBar(
              content: Text('Voice dictation stopped. Try again.'),
            ),
          );
      } else {
        unawaited(showVoiceDictationIssueDialog(context, issue));
      }
    });
  }

  @override
  void didUpdateWidget(VoiceComposerBinding old) {
    super.didUpdateWidget(old);
    if (old.target != widget.target || !widget.active) {
      unawaited(_voice.abandon());
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!AppRouteScope.isCurrentOf(context)) unawaited(_voice.abandon());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      unawaited(_voice.abandon());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _voice.removeListener(_changed);
    unawaited(_voice.abandon());
    _voice.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(context, _voice);
}
