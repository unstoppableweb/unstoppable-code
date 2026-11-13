import 'package:mobile/data/models/remote_session.dart';

/// Where a tapped push notification should navigate.
sealed class PushDeepLinkTarget {
  const PushDeepLinkTarget();
}

final class PushWorktreeChatTarget extends PushDeepLinkTarget {
  const PushWorktreeChatTarget({required this.worktree, this.chatId});
  final RemoteWorktree worktree;
  final String? chatId;
}

final class PushStandaloneChatTarget extends PushDeepLinkTarget {
  const PushStandaloneChatTarget({required this.chat});
  final RemoteStandaloneChat chat;
}

final class PushFeedFallback extends PushDeepLinkTarget {
  const PushFeedFallback();
}

/// Resolves a push payload (`worktreeId`, `clientChatId`) against the current
/// remote-control snapshot. Pure: all lookups are injected so this is
/// unit-testable without the view model. Returns [PushFeedFallback] whenever
/// the ids don't resolve (stale payload, unpaired desktop, workspace gone).
///
/// Namespace note: the web push sender puts the server-minted
/// `Worktree.externalId` (a UUID) in the payload's `worktreeId` field — see
/// `apps/web/src/lib/push/run-lifecycle-notifier.ts`. That id has no
/// intersection with [RemoteWorktree.localId], which is the *desktop's*
/// locally-generated id for the same worktree (e.g. `wt-1`, `leopard`). The
/// direct `worktreeId` match below is kept only as a harmless no-op for a
/// hypothetical future where the namespaces are aligned; in production it
/// never matches. The real resolution path is `clientChatId` ->
/// [worktreeForChatId], which looks the chat up in the client's own hydrated
/// chat-summary projection (keyed by the client's own worktree local ids) and
/// so never needs the server's UUID at all. Do not "simplify" this by
/// dropping either the direct match or the chat-id lookup — the direct match
/// is intentionally inert today, and the chat-id lookup is the one that
/// actually works.
PushDeepLinkTarget resolvePushDeepLink({
  required Map<String, String> data,
  required List<RemoteWorkspace> workspaces,
  required List<RemoteWorktree> Function(String workspaceLocalId) worktreesFor,
  required RemoteWorktree? Function(String chatId) worktreeForChatId,
  required RemoteStandaloneChat? Function(String chatId) standaloneChatById,
}) {
  final worktreeId = data['worktreeId'];
  final rawChatId = data['clientChatId'];
  final chatId = rawChatId == null || rawChatId.isEmpty ? null : rawChatId;
  if (worktreeId != null && worktreeId.isNotEmpty) {
    for (final workspace in workspaces) {
      for (final worktree in worktreesFor(workspace.localId)) {
        if (worktree.localId == worktreeId) {
          return PushWorktreeChatTarget(worktree: worktree, chatId: chatId);
        }
      }
    }
  }
  if (chatId != null) {
    final worktree = worktreeForChatId(chatId);
    if (worktree != null) {
      return PushWorktreeChatTarget(worktree: worktree, chatId: chatId);
    }
  }
  if (chatId != null) {
    final chat = standaloneChatById(chatId);
    if (chat != null) {
      return PushStandaloneChatTarget(chat: chat);
    }
  }
  return const PushFeedFallback();
}

/// The web link a cloud workflow run's push carries (`type: cloud_run`, sent by
/// `apps/web/src/lib/web-core/cloud-run-notice-delivery.ts`), when it opens
/// the run on [appOrigin]. Null for any other push, and for a link to another
/// origin, so a tap never opens a site the app doesn't serve.
String? cloudRunPushUrl(Map<String, String> data, String appOrigin) {
  if (data['type'] != 'cloud_run') return null;
  final url = Uri.tryParse(data['url'] ?? '');
  final app = Uri.tryParse(appOrigin);
  if (url == null || app == null) return null;
  bool web(Uri uri) =>
      (uri.scheme == 'https' || uri.scheme == 'http') && uri.host.isNotEmpty;
  if (!web(url) || !web(app) || url.origin != app.origin) return null;
  return url.toString();
}
