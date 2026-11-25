import 'package:mobile/data/models/chat_tab_item.dart';
import '../worktree_ref.dart';

final class DeviceChatRef implements ChatTabItem, DeviceWorktreeRef {
  const DeviceChatRef({
    required this.projectId,
    required this.worktreeId,
    required this.id,
    required this.title,
  });
  @override
  final String projectId;
  @override
  final String worktreeId;
  final String id, title;
  @override
  String get chatId => id;
  @override
  String get displayTitle => title;
  String get key => '$projectId/$worktreeId/$id';
  Map<String, dynamic> get scope => {
    'projectId': projectId,
    'worktreeId': worktreeId,
  };
  Map<String, dynamic> get target => {...scope, 'chatId': id};
  bool matchesScope(Map<String, dynamic> value) =>
      value['projectId'] == projectId && value['worktreeId'] == worktreeId;
}

/// The search catalog's live chats and the computer's chat workspaces.
typedef DeviceChatCatalog = ({
  List<DeviceChatRef> chats,
  List<DeviceChatWorkspace> workspaces,
});

final class DeviceChatWorkspace {
  DeviceChatWorkspace(this.id, this.name);
  final String id, name;
}
