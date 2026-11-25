import 'dart:async';
import 'dart:typed_data';

import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:mobile/device_link/chats/attachments.dart';
import 'package:mobile/device_link/chats/drafts.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/sender.dart';
import 'package:mobile/device_link/protocol.dart';

import 'rust_chats.dart';

DeviceChatRef _chat(core.ChatRefView v) => DeviceChatRef(
  projectId: v.projectId,
  worktreeId: v.worktreeId,
  id: v.id,
  title: v.title,
);

/// The writes of one computer's chats on the core's [core.ChatsService]
/// (P5b): sends with the pending and confirmed attempt, chat and tab
/// creation and stop. The core decides and sends each write once; this
/// model issues the intents, opens what the core created (so the reader's
/// selection generation moves first, as in Dart) and reads the attempts
/// from the core's frames.
final class RustChatSender implements DeviceChatSender {
  RustChatSender(this.reader) : attachments = RustChatAttachments(reader);
  final RustChatReader reader;
  core.ChatsService get service => reader.service;
  @override
  final RustChatAttachments attachments;
  @override
  Stream<void> get updates => reader.updates;

  /// Sends issued here whose frame has not come yet: the composer must not
  /// offer a second send meanwhile (Dart set `sending` before its first
  /// await).
  int _issued = 0;
  @override
  bool get sending => _issued > 0 || (reader.frame?.sending ?? false);

  /// One object per attempt, as Dart kept it.
  final _attempts = <String, (core.PendingSendView, DeviceChatPendingSend)>{};
  DeviceChatPendingSend? _attempt(core.PendingSendView? view) {
    if (view == null) return null;
    if (_attempts[view.id] case (final seen, final attempt) when seen == view) {
      return attempt;
    }
    final attempt = DeviceChatPendingSend(
      _chat(view.chat),
      view.id,
      view.text,
      dictated: view.dictated,
      attachmentPaths: List.unmodifiable(view.attachmentPaths),
    );
    if (_attempts.length > 4) _attempts.remove(_attempts.keys.first);
    _attempts[view.id] = (view, attempt);
    return attempt;
  }

  @override
  DeviceChatPendingSend? get pendingSend => _attempt(reader.frame?.pendingSend);
  @override
  DeviceChatPendingSend? get confirmedSend =>
      _attempt(reader.frame?.confirmedSend);

  @override
  void catalogChanged(List<DeviceChatWorkspace> workspaces) => service.send(
    intent: core.ChatIntent.setWorkspaces(
      ids: [for (final w in workspaces) w.id],
    ),
  );

  @override
  Future<DeviceChatRef> createChat(
    String workspaceId, {
    String? title,
    void Function(DeviceChatRef)? onCreated,
  }) async {
    final generation = reader.selectionGeneration;
    final settled = await reader.settle(
      core.ChatIntent.createChat(workspaceId: workspaceId, title: title),
    );
    final ref = switch (settled.outcome) {
      core.ChatOutcome_Created(:final chat) => _chat(chat),
      _ => throw StateError('A created chat without its ref.'),
    };
    // The core checked the selection before this host saw its outcome; a
    // chat opened since keeps it, as in Dart.
    if (generation != reader.selectionGeneration) {
      throw const DeviceLinkException(
        'Reconnect and refresh the chat list to find the new chat.',
      );
    }
    onCreated?.call(ref);
    await reader.open(ref);
    return ref;
  }

  @override
  Future<void> createTab(
    String projectId,
    String worktreeId, {
    void Function(DeviceChatRef)? onCreated,
  }) async {
    final generation = reader.selectionGeneration;
    final settled = await reader.settle(
      core.ChatIntent.createTab(projectId: projectId, worktreeId: worktreeId),
    );
    if (generation != reader.selectionGeneration) return;
    if (settled.outcome case core.ChatOutcome_Created(:final chat)) {
      final ref = _chat(chat);
      final opening = reader.open(ref);
      // As in Dart: the creation is published once its selection is
      // established, before the open finishes.
      onCreated?.call(ref);
      await opening;
    }
  }

  @override
  Future<DeviceChatSendOutcome> send(
    String text, {
    DeviceChatRef? chat,
    bool retry = false,
    bool dictated = false,
    List<String> attachmentPaths = const [],
  }) async {
    _issued++;
    try {
      final settled = await reader.settle(
        core.ChatIntent.send(
          chat: chat == null ? null : RustChatReader.chatRefView(chat),
          text: text,
          retry: retry,
          dictated: dictated,
          attachmentPaths: attachmentPaths,
        ),
      );
      return switch (settled.outcome) {
        core.ChatOutcome_Sent(accepted: true) => DeviceChatSendOutcome.accepted,
        _ => DeviceChatSendOutcome.uncertain,
      };
    } finally {
      _issued--;
    }
  }

  @override
  Future<void> stop(DeviceChatRef chat) async {
    await reader.settle(
      core.ChatIntent.stop(chat: RustChatReader.chatRefView(chat)),
    );
  }

  @override
  Future<void> dispose() async {}
}

/// Attachments through the core: the bytes the platform picker read go
/// with the intent; the core sends each file once.
final class RustChatAttachments implements DeviceChatAttachments {
  RustChatAttachments(this.reader);
  final RustChatReader reader;

  @override
  Future<DeviceChatAttachment> import(
    DeviceChatRef scope,
    String filename,
    Uint8List bytes,
  ) async {
    final settled = await reader.settle(
      core.ChatIntent.importAttachment(
        scope: RustChatReader.chatRefView(scope),
        filename: filename,
        bytes: bytes,
      ),
    );
    return switch (settled.outcome) {
      core.ChatOutcome_Stored(:final filename, :final path, :final size) =>
        DeviceChatAttachment(filename: filename, path: path, size: size),
      _ => throw StateError('A stored file without its path.'),
    };
  }

  @override
  Future<void> delete(DeviceChatRef scope, String filename) async {
    await reader.settle(
      core.ChatIntent.deleteAttachment(
        scope: RustChatReader.chatRefView(scope),
        filename: filename,
      ),
    );
  }
}

/// The computer's chat drafts in the core's encrypted store (D9; Dart
/// drafts are not imported). Writes apply here at once and go to the core
/// in order; a frame that has applied a write shows the core's text, which
/// the core clears when a send of it is accepted or confirmed.
final class RustChatDrafts implements DeviceChatDrafts {
  RustChatDrafts(this.reader);
  final RustChatReader reader;
  final _local = <String, (String, int)>{};
  int _seq = 0;

  @override
  String draftFor(DeviceChatRef ref) {
    if (_local[ref.key] case (final text, final seq)) {
      if (seq > reader.draftSeq) return text;
      _local.remove(ref.key);
    }
    return reader.drafts[ref.key] ?? '';
  }

  @override
  void setDraft(DeviceChatRef ref, String text) {
    if (draftFor(ref) == text) return;
    // The core's drafts already show every write it applied.
    _local
      ..removeWhere((_, write) => write.$2 <= reader.draftSeq)
      ..[ref.key] = (text, ++_seq);
    reader.service.send(
      intent: core.ChatIntent.setDraft(
        chat: RustChatReader.chatRefView(ref),
        text: text,
        seq: _seq,
      ),
    );
  }

  @override
  void sent(DeviceChatRef ref, String text) => reader.service.send(
    intent: core.ChatIntent.clearSentDraft(
      chat: RustChatReader.chatRefView(ref),
      text: text,
    ),
  );

  /// The core keeps one computer's drafts per account; nothing to bind.
}
