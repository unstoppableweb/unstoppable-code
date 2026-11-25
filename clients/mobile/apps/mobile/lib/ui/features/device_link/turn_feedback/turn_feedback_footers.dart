import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/data/models/turn_feedback.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/ui/core/chat/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/core/chat/widgets/turn_feedback_row.dart';
import 'package:mobile/ui/core/chat/widgets/turn_feedback_sheet.dart';
import 'package:provider/provider.dart';

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
    required this.header,
    required this.workspaceKind,
    required this.footers,
    required this.builder,
  });

  final DeviceChatRef ref;

  final core.ChatHeaderView? header;
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
    final header = widget.header;
    final provider = header?.providerType, model = header?.model;
    return TurnFeedbackContext(
      provider: provider != null && provider.isNotEmpty ? provider : null,
      model: model != null && model.isNotEmpty ? model : null,
      chatMode: header?.terminalMode == true ? 'terminal' : 'canopy',
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
    final header = widget.header;
    if (controller == null ||
        header == null ||
        header.readOnly ||
        header.feedbackTurns.isEmpty) {
      return widget.builder(widget.footers);
    }
    final seed = <String, TurnFeedbackEntry>{
      for (final row in header.feedbackSeeds)
        if (turnFeedbackRatingFromWire(row.rating) case final rating?)
          row.turn: TurnFeedbackEntry(
            rating: rating,
            syncState: switch (row.syncState) {
              'synced' => TurnFeedbackSyncState.synced,
              'failed' => TurnFeedbackSyncState.failed,
              _ => TurnFeedbackSyncState.pending,
            },
            feedbackId: row.feedbackId,
            reason: turnFeedbackReasonFromWire(row.reason),
          ),
    };
    final chatId = widget.ref.id;
    return widget.builder(
      mergeTurnFooters(widget.footers, {
        for (final core.FeedbackTurnView(:footer, :turn)
            in header.feedbackTurns)
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
