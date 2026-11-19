import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'models.dart';

/// Adapts canonical desktop blocks to the transport-neutral mobile feed.
/// The wire messages stay intact in the repository. No Portal state is used.
/// [endReasons] (see `deviceTurnEndReasons`) marks the completed timer of
/// each turn that failed, was stopped or was interrupted.
List<ChatMessage> deviceChatPresentation(
  String chatId,
  Iterable<DeviceChatMessage> messages, {
  Map<String, String> endReasons = const {},
}) => [
  for (final message in messages)
    if (!message.hidden)
      ChatMessage(
        messageId: message.id,
        chatId: chatId,
        role: ChatRole.fromWire(message.role),
        status: message.raw['isStreaming'] == true
            ? ChatMessageStatus.streaming
            : ChatMessageStatus.fromWire(message.raw['status'] as String?) ??
                  ChatMessageStatus.complete,
        text: _visibleText(message),
        watcherFired: ChatWatcherFiredInfo.fromJsonOrNull(
          message.raw['watcherFired'],
        ),
        attachments: _attachments(message),
        occurredAt: message.raw['timestamp'] is num
            ? DateTime.fromMillisecondsSinceEpoch(
                (message.raw['timestamp'] as num).toInt(),
              )
            : null,
        continuesTurn:
            message.role == 'user' &&
            ((message.blocks.isNotEmpty &&
                    message.blocks.every((b) => b['type'] == 'tool_result')) ||
                message.blocks.any(
                  (b) =>
                      b['type'] == 'text' &&
                      ((b['steering'] is Map &&
                              (b['steering'] as Map)['startsTurn'] == false) ||
                          (b['asyncQuestionAnswer'] is Map &&
                              (b['asyncQuestionAnswer'] as Map)['startsTurn'] ==
                                  false)),
                )),
        parts: [
          for (final block in message.blocks) ..._parts(block, endReasons),
        ],
      ),
];

Iterable<ChatPart> _parts(
  Map<String, dynamic> block,
  Map<String, String> endReasons,
) sync* {
  final type = block['type'];
  switch (type) {
    case 'thinking':
      yield ChatPart(kind: 'thinking', data: {'text': block['text']});
    case 'tool_use':
      final display = block['display'] is Map ? block['display'] as Map : block;
      final name = display['toolName'] ?? block['toolName'] ?? block['name'];
      yield ChatPart(
        kind: 'tool_use',
        toolFamily: _toolFamily(name),
        data: {
          'toolUseId': block['toolUseId'],
          'toolName': name,
          'input': display['input'] ?? block['input'],
        },
      );
    case 'tool_result':
      yield ChatPart(
        kind: 'tool_result',
        data: {
          'toolUseId': block['toolUseId'],
          'output': block['output'],
          'isError': block['isError'] == true,
        },
      );
    case 'turn_timer':
      yield ChatPart(
        kind: 'turn_timer',
        data: {
          for (final key in [
            'turnId',
            'userMessageId',
            'spawnedBy',
            'startedAt',
            'pausedAt',
            'resumedAt',
            'accumulatedPausedDurationMs',
            'completedAt',
          ])
            if (block[key] != null) key: block[key],
          if (block['completedAt'] != null)
            'endReason': ?endReasons[block['userMessageId']],
        },
      );
    case 'file_references':
      yield ChatPart(
        kind: 'attachment',
        data: {'references': block['references']},
      );
    case 'image':
      // Host filesystem paths cannot be loaded by the phone. The feed keeps
      // a visible attachment marker until scoped byte reads are implemented.
      yield const ChatPart(kind: 'image');
    case 'text':
      break;
    default:
      yield ChatPart(
        kind: type is String ? type : 'unknown',
        data: {'text': 'Additional content is available on your computer.'},
      );
  }
  if (block['textRef'] != null ||
      block['blocksRef'] != null ||
      block['fullOutputRef'] != null) {
    yield const ChatPart(
      kind: 'content_reference',
      data: {'text': 'Additional content is available on your computer.'},
    );
  }
}

String? _toolFamily(Object? name) => switch (name) {
  'Read' || 'ReadLines' || 'read_file' => 'read',
  'Edit' || 'MultiEdit' || 'file_change' || 'apply_patch' => 'edit',
  'Write' || 'write_file' => 'write',
  'Bash' ||
  'PowerShell' ||
  'command' ||
  'exec_command' ||
  'shell_command' => 'bash',
  'Grep' || 'grep' => 'grep',
  'Glob' || 'glob' => 'glob',
  'AskUserQuestion' => 'ask-user',
  'TodoWrite' ||
  'TaskCreate' ||
  'TaskUpdate' ||
  'TaskList' ||
  'TaskGet' ||
  'TaskStop' => 'todo',
  'Agent' || 'Task' || 'SendMessage' || 'Workflow' || 'TaskOutput' => 'agent',
  'Skill' => 'skill',
  'EnterPlanMode' || 'ExitPlanMode' => 'plan',
  'WebSearch' || 'WebFetch' => 'web',
  _ => null,
};

const _rendered = {
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'turn_timer',
  'file_references',
  'image',
};
String _visibleText(DeviceChatMessage message) {
  final additional = message.blocks.any(
    (b) =>
        !_rendered.contains(b['type']) ||
        b['textRef'] != null ||
        b['blocksRef'] != null ||
        b['fullOutputRef'] != null,
  );
  return [
    message.text,
    if (additional) 'Additional content is available on your computer.',
  ].where((text) => text.isNotEmpty).join('\n\n');
}

/// Each attachment is named by its path on the computer, the key a phone
/// that sent the file keeps its thumbnail under.
List<ChatMessageAttachment> _attachments(DeviceChatMessage message) => [
  for (final path
      in (message.raw['attachmentPaths'] as List? ?? []).whereType<String>())
    ChatMessageAttachment(
      attachmentId: path,
      filename: path.split(RegExp(r'[/\\]')).last,
      mediaType:
          chatAttachmentMediaTypeForFilename(
            path.split(RegExp(r'[/\\]')).last,
          ) ??
          'application/octet-stream',
    ),
];
