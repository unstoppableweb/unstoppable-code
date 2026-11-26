import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile/core/design-system/overlay-action/canopy_overlay_action.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/recent_chat.dart';
import 'package:mobile/ui/core/chat/widgets/cached_chat_transcript.dart';
import 'package:mobile/ui/core/chat/widgets/chat_provisioning.dart';
import 'package:mobile/ui/core/navigation/home_recent_chats.dart';
import '../chats_screen.dart';
import 'account_model.dart';

/// Builds the shell's row for one computer chat. The drawer's Recents and
/// notification taps share it, so a chat opens the same way from either.
final class ComputerChatRows {
  ComputerChatRows(this.account);
  final ComputerAccountModel account;
  bool _opening = false;

  HomeRecentChat row(
    String computerId,
    String computerName,
    DeviceRecentChat chat,
  ) => HomeRecentChat(
    key: 'computer-$computerId-${chat.ref.key}',
    isCurrent: () =>
        account.sessions.selectedId == computerId &&
        account.sessions.sessions[computerId]?.chats.state?.ref.key ==
            chat.ref.key,
    title: chat.ref.title,
    computerName: computerName,
    locationLabel: chat.worktreeName,
    activityAt: chat.activityAt,
    attention: switch (chat.attention) {
      DeviceRecentAttention.none => RecentChatAttention.none,
      DeviceRecentAttention.unread => RecentChatAttention.unread,
      DeviceRecentAttention.awaitingAnswer =>
        RecentChatAttention.awaitingAnswer,
    },
    open: (context, showChat) =>
        _open(context, computerId, chat.ref, chat.worktreeName, showChat),
    cachedTranscript: () {
      final cached = _cachedTranscript(computerId, chat.ref);
      if (cached == null) return null;
      return Padding(
        padding: EdgeInsets.only(bottom: cached.bottomInset),
        child: cached.preview,
      );
    },
  );

  ({Widget preview, double bottomInset})? _cachedTranscript(
    String computerId,
    DeviceChatRef ref,
  ) {
    final owner = account.sessions.sessions[computerId];
    final transcript = owner?.chats.feed.cachedTranscript(ref.key);
    if (owner == null || transcript == null || transcript.rows.isEmpty) {
      return null;
    }
    final preview = ListenableBuilder(
      listenable: account,
      builder: (context, _) {
        final workspaceContext =
            context.watch<WorkspaceContext?>() ??
            const WorkspaceContext.personal();
        if (!identical(account.sessions.sessions[computerId], owner) ||
            !owner.chats.online ||
            owner.scopePending ||
            !owner.overview.scope(workspaceContext).includesChat(ref)) {
          return const ChatTranscriptLoading(label: 'Loading conversation…');
        }
        return CachedChatTranscript(rows: transcript.rows);
      },
    );
    return (
      preview: preview,
      bottomInset: transcript.hasTabs ? CanopyOverlayAction.stackOffset : 0,
    );
  }

  /// Switches to the chat's computer, so its overview and Home follow, then
  /// lets the shell host the chat with its navigation menu.
  Future<void> _open(
    BuildContext context,
    String computerId,
    DeviceChatRef ref,
    String? worktreeName,
    Future<void> Function(Widget page) showChat,
  ) async {
    final controller = account.sessions.sessions[computerId];
    if (_opening || controller == null || !controller.chats.online) return;
    final workspaceContext = context.read<WorkspaceContext?>();
    _opening = true;
    try {
      // The Rust core selects when its service answers; the Dart account
      // selects at once and then persists the next cold-start choice, which
      // must not hold up the chat page on secure storage I/O.
      final selecting = account.select(computerId);
      if (!identical(account.sessions.selected, controller)) await selecting;
      // Open only what the current context still shows after switching
      // computers; selection listeners may have changed the shell, and a
      // later selection may have replaced this one.
      if (!context.mounted ||
          !identical(account.sessions.selected, controller) ||
          context.read<WorkspaceContext?>() != workspaceContext ||
          !controller.scopeFor(workspaceContext).includesChat(ref)) {
        return;
      }
      controller.enterChat();
      final preview = _cachedTranscript(computerId, ref);
      final opening = controller.chats.open(ref);
      var generation = controller.chats.chats.selectionGeneration;
      try {
        await showChat(
          DeviceChatScreen(
            model: controller.chats,
            locationLabel: worktreeName,
            worktree: controller.activityContext(ref),
            cachedTranscript: preview == null
                ? null
                : (
                    chatKey: ref.key,
                    preview: preview.preview,
                    bottomInset: preview.bottomInset,
                  ),
          ),
        );
        // The page owned the selection, including tab switches and reconnects
        // inside it. Read it as the shell leaves the page:
        // a chat opened after that, while this open finishes, keeps its own.
        generation = controller.chats.chats.selectionGeneration;
      } finally {
        // Navigation must not wait for hydration or a full overview refresh.
        // Generation checks keep retiring work off the next chat's selection.
        unawaited(opening.then((_) => controller.restoreOverview(generation)));
      }
    } finally {
      _opening = false;
    }
  }
}
