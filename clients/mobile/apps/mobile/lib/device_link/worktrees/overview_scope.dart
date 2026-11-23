import 'package:mobile/data/models/remote_overview_sections.dart';
import '../chats/models.dart';
import 'models.dart';

/// One workspace context's slice of a computer's inventory: what the project
/// browser, search, Home and Recents may list and open. The Dart
/// `DeviceContextScope` and the Rust-backed scope both implement it.
abstract interface class DeviceOverviewScope {
  List<DeviceProject> get projects;

  /// Visible worktrees: the project browser, search and Recents.
  List<DeviceWorktree> get worktrees;

  /// Hidden worktrees too, for attention.
  List<DeviceWorktree> get allWorktrees;
  bool get hasUnknownOwners;
  AttentionSectionsData get attention;
  bool includesWorktree(DeviceWorktree worktree);
  bool includesChat(DeviceChatRef chat);
  List<DeviceChatRef> chats(Iterable<DeviceChatRef> catalog);
}

/// A scope that lists nothing: while ownership is pending, or for a
/// computer that is not the active one.
final class EmptyOverviewScope implements DeviceOverviewScope {
  const EmptyOverviewScope();
  @override
  List<DeviceProject> get projects => const [];
  @override
  List<DeviceWorktree> get worktrees => const [];
  @override
  List<DeviceWorktree> get allWorktrees => const [];
  @override
  bool get hasUnknownOwners => false;
  @override
  AttentionSectionsData get attention => const AttentionSectionsData(
    awaitingApproval: [],
    unreadChats: [],
    inProgress: [],
    pipelinesRunning: [],
    pipelinesFinished: [],
  );
  @override
  bool includesWorktree(DeviceWorktree worktree) => false;
  @override
  bool includesChat(DeviceChatRef chat) => false;
  @override
  List<DeviceChatRef> chats(Iterable<DeviceChatRef> catalog) => const [];
}
