import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/data/models/turn_feedback.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/ui/features/device_link/computer_connect/chat_feed_model.dart';
import 'package:mobile/ui/core/chat/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/core/chat/widgets/turn_feedback_row.dart';
import 'package:mobile/ui/core/chat/widgets/turn_feedback_sheet.dart';
import 'package:provider/provider.dart';

/// Turns that get thumbs, as feed footer key to feedback turn key.
///
/// The feedback key is the turn's opening user message id, the
/// `clientUserMessageId` desktop rates. The footer key is the feed's key for
/// the turn's last segment: the feed starts a segment at every user row,
/// including tool results and steering that continue a turn, so the thumbs
/// sit at the end of the whole turn.
///
/// A turn qualifies when it has assistant content (a failed or cancelled turn
/// counts, as on desktop) and is not the in-flight turn.
Map<String, String> completedTurnKeys(
  List<FeedMessageOutline> messages,
  bool running,
) {
  final result = <String, String>{};
  String? opener, footer;
  var content = false;
  void close({required bool last}) {
    if (opener case final opener? when content && !(last && running)) {
      result[footer ?? opener] = opener;
    }
  }

  for (final message in messages) {
    if (message.user) {
      if (!message.continuesTurn) {
        close(last: false);
        opener = message.messageId;
        footer = message.messageId;
        content = false;
      } else if (opener != null) {
        footer = message.messageId;
      }
      continue;
    }
    if (opener != null && message.renderable) content = true;
  }
  close(last: true);
  return result;
}

/// The `eventType` desktop sends for a chat's scope (`eventTypeForTarget` in
/// the desktop turn-feedback slice), or null when this phone cannot tell.
String? deviceTurnFeedbackEventType(String projectId, String? workspaceKind) {
  if (projectId == 'app-advisor' || projectId.startsWith('bot--')) {
    return 'app_advisor';
  }
  if (projectId == 'pipeline-editor') return 'pipeline_editor';
  if (projectId == 'standalone-chat' || workspaceKind == 'cowork') {
    return 'standalone_chat';
  }
  if (workspaceKind == 'single-repo' || workspaceKind == 'multi-repo') {
    return 'worktree_chat';
  }
  return null;
}

/// Adds turn feedback to existing turn footers. Where a turn already has
/// one, both stack, the existing footer first.
Map<String, Widget> mergeTurnFooters(
  Map<String, Widget> footers,
  Map<String, Widget> feedback,
) => {
  ...footers,
  for (final MapEntry(:key, :value) in feedback.entries)
    key: switch (footers[key]) {
      final existing? => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [existing, value],
      ),
      null => value,
    },
};

/// Binds the thumbs row to a Computer connect chat. Same builder shape as
/// `DevicePipelineChatActivity`; with no [TurnFeedbackController] in scope
/// it passes [footers] through unchanged.
class DeviceTurnFeedbackFooters extends StatefulWidget {
  const DeviceTurnFeedbackFooters({
    super.key,
    required this.ref,
    required this.messages,
    required this.running,
    required this.tab,
    required this.workspaceKind,
    required this.footers,
    required this.builder,
  });

  final DeviceChatRef ref;

  /// The transcript as the feed presents it, so turns key the same way.
  final List<FeedMessageOutline> messages;
  final bool running;

  /// The desktop tab: its `turnFeedback` seeds ratings, `readOnly` hides the
  /// thumbs, and `providerType`, `model` and `interfaceMode` describe a
  /// rating the way desktop does.
  final Map<String, dynamic> tab;
  final String? workspaceKind;
  final Map<String, Widget> footers;
  final Widget Function(Map<String, Widget>) builder;

  @override
  State<DeviceTurnFeedbackFooters> createState() =>
      _DeviceTurnFeedbackFootersState();
}

class _DeviceTurnFeedbackFootersState extends State<DeviceTurnFeedbackFooters> {
  TurnFeedbackController? _controller;
  String? _chatId;
  bool _sheetOpen = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _bind(context.read<TurnFeedbackController?>(), widget.ref.id);
  }

  @override
  void didUpdateWidget(DeviceTurnFeedbackFooters oldWidget) {
    super.didUpdateWidget(oldWidget);
    _bind(_controller, widget.ref.id);
  }

  void _bind(TurnFeedbackController? controller, String chatId) {
    if (identical(controller, _controller) && chatId == _chatId) return;
    if (_chatId case final previous?) _controller?.detach(previous);
    _controller = controller;
    _chatId = chatId;
    controller?.attach(chatId);
  }

  @override
  void dispose() {
    if (_chatId case final chatId?) _controller?.detach(chatId);
    super.dispose();
  }

  TurnFeedbackContext get _context {
    final tab = widget.tab;
    final provider = tab['providerType'], model = tab['model'];
    return TurnFeedbackContext(
      provider: provider is String && provider.isNotEmpty ? provider : null,
      model: model is String && model.isNotEmpty ? model : null,
      chatMode: tab['interfaceMode'] == 'claude-code' ? 'terminal' : 'canopy',
      eventType: deviceTurnFeedbackEventType(
        widget.ref.projectId,
        widget.workspaceKind,
      ),
    );
  }

  void _rate(
    TurnFeedbackController controller,
    String turn,
    TurnFeedbackRating? next,
    TurnFeedbackEntry? shown,
  ) {
    final chatId = widget.ref.id;
    // Recorded first and independently of the sheet, so skipping or
    // dismissing the sheet never undoes the rating.
    unawaited(
      controller.setRating(
        chatId: chatId,
        clientUserMessageId: turn,
        rating: next,
        context: _context,
        fallback: shown,
      ),
    );
    if (next != TurnFeedbackRating.down || _sheetOpen) return;
    _sheetOpen = true;
    unawaited(
      showTurnFeedbackSheet(
        context,
        onSubmit: (detail) => controller.submitDetail(
          chatId: chatId,
          clientUserMessageId: turn,
          reason: detail.reason,
          comment: detail.comment,
        ),
      ).whenComplete(() => _sheetOpen = false),
    );
  }

  @override
  Widget build(BuildContext context) {
    final controller = context.watch<TurnFeedbackController?>();
    if (controller == null || widget.tab['readOnly'] == true) {
      return widget.builder(widget.footers);
    }
    final turns = completedTurnKeys(widget.messages, widget.running);
    if (turns.isEmpty) return widget.builder(widget.footers);
    final seed = turnFeedbackTabSeed(widget.tab['turnFeedback']);
    final chatId = widget.ref.id;
    return widget.builder(
      mergeTurnFooters(widget.footers, {
        for (final MapEntry(key: footer, value: turn) in turns.entries)
          footer: Align(
            key: ValueKey('turn-feedback:$turn'),
            alignment: AlignmentDirectional.centerStart,
            child: TurnFeedbackRow(
              rating: controller.resolve(chatId, turn, seed)?.rating,
              onRate: (next) => _rate(
                controller,
                turn,
                next,
                controller.resolve(chatId, turn, seed),
              ),
            ),
          ),
      }),
    );
  }
}
