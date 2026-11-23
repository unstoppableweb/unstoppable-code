import 'models.dart';

/// Why a recent chat carries the attention dot, if it does.
enum DeviceRecentAttention { none, unread, awaitingAnswer }

/// One chat in a computer's Recents.
final class DeviceRecentChat {
  const DeviceRecentChat({
    required this.ref,
    required this.worktreeName,
    required this.activityAt,
    required this.attention,
  });
  final DeviceChatRef ref;

  /// The worktree's name; null for Cowork chats.
  final String? worktreeName;

  /// Null when the computer does not say when the chat was last active.
  final DateTime? activityAt;
  final DeviceRecentAttention attention;
}
