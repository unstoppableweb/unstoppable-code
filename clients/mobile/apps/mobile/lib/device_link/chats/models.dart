import 'package:mobile/data/models/chat_tab_item.dart';
import '../protocol.dart';
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

final class DeviceChatMessage {
  DeviceChatMessage(this.raw);
  final Map<String, dynamic> raw;
  String get id => deviceLinkString(raw, 'id');
  String get role => raw['role'] is String ? raw['role'] as String : 'system';
  bool get hidden =>
      raw['hidden'] == true ||
      raw['parentBlockId'] is String ||
      raw['parentToolUseId'] is String;
  List<Map<String, dynamic>> get blocks => raw['blocks'] is List
      ? (raw['blocks'] as List).whereType<Map<String, dynamic>>().toList()
      : const [];
  String get text => blocks
      .where((block) => block['type'] == 'text')
      .map((block) => block['text'] is String ? block['text'] as String : '')
      .where((text) => text.isNotEmpty)
      .join('\n\n');
  List<String> get activities => blocks
      .where((b) => b['type'] != 'text')
      .map(
        (b) => switch (b['type']) {
          'thinking' => 'Thinking',
          'tool_use' => (b['name'] as String?) ?? 'Tool activity',
          'codex_agent_call' => 'Agent activity',
          _ => 'Agent activity',
        },
      )
      .toSet()
      .toList();
}
