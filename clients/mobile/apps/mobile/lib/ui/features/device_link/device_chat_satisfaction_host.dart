import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile/services/satisfaction/satisfaction_policy.dart';
import 'package:mobile/ui/features/satisfaction/view_models/satisfaction_prompt_controller.dart';
import 'package:mobile/ui/features/satisfaction/views/satisfaction_prompt_host.dart';
import 'package:provider/provider.dart';

import 'chats_view_model.dart';
import 'turn_completion_watcher.dart';

/// True when nothing on a computer chat competes with a prompt: connected,
/// with a transcript, idle, nothing being sent, nothing awaiting the user, and
/// no error or delivery notice showing.
bool deviceChatIsQuiet(DeviceChatsViewModel model) {
  final state = model.state;
  return state != null &&
      model.online &&
      state.messages.isNotEmpty &&
      !state.closed &&
      !state.running &&
      !state.awaitingInput &&
      model.pendingQuestionsFor(state.ref.id).isEmpty &&
      !model.chats.loading &&
      !model.chats.sending &&
      model.chats.pendingSend == null &&
      model.error == null &&
      model.chats.error == null &&
      state.runtimeError == null;
}

/// Counts the computer chat's successful turns toward the satisfaction prompt
/// and presents it (surface `remote_chat`) once the chat is quiet and its
/// route is on top. A pass-through when no [SatisfactionPromptController] is
/// provided.
class DeviceChatSatisfactionHost extends StatefulWidget {
  const DeviceChatSatisfactionHost({
    super.key,
    required this.model,
    required this.child,
  });

  final DeviceChatsViewModel model;
  final Widget child;

  @override
  State<DeviceChatSatisfactionHost> createState() =>
      _DeviceChatSatisfactionHostState();
}

class _DeviceChatSatisfactionHostState
    extends State<DeviceChatSatisfactionHost> {
  SatisfactionPromptController? _controller;
  TurnCompletionWatcher? _watcher;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final controller = Provider.of<SatisfactionPromptController?>(
      context,
      listen: false,
    );
    if (!identical(controller, _controller)) {
      _controller = controller;
      _watch();
    }
  }

  @override
  void didUpdateWidget(DeviceChatSatisfactionHost oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.model, widget.model)) _watch();
  }

  void _watch() {
    _watcher?.dispose();
    final controller = _controller;
    final model = widget.model;
    _watcher = controller == null
        ? null
        : TurnCompletionWatcher(
            source: model,
            read: () => deviceTurnCompletionSample(
              online: model.online,
              state: model.state,
            ),
            onSuccessfulTurn: (key) =>
                unawaited(controller.recordSuccessfulTurn(key)),
          );
  }

  @override
  void dispose() {
    _watcher?.dispose();
    super.dispose();
  }

  @override
  // One tree shape with or without a controller, so the chat keeps its state;
  // without one, SatisfactionPromptHost is inert.
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.model,
    builder: (context, child) => SatisfactionPromptHost(
      surface: SatisfactionSurface.remoteChat,
      isQuiet: deviceChatIsQuiet(widget.model),
      child: child!,
    ),
    child: widget.child,
  );
}
