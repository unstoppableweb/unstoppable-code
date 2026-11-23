import 'dart:async';

import 'package:mobile/device_link/desktop/ipc.dart';
import 'package:mobile/device_link/store.dart';

final class MemoryDeviceLinkStore implements DeviceLinkStore {
  String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String value) async => this.value = value;
}

/// The project and worktree every fake chat lives in.
const fakeProjectId = 'ws-app';
const fakeWorktreeId = 'wt-feature-auth';

/// One canonical transcript message as `chat:get-transcript-page` returns it.
Map<String, dynamic> fakeMessage(
  String id,
  String role,
  List<Map<String, dynamic>> blocks, {
  bool streaming = false,
  List<String>? attachmentPaths,
}) => {
  'id': id,
  'role': role,
  'timestamp': 1767225600000,
  'blocks': blocks,
  if (streaming) 'isStreaming': true,
  'attachmentPaths': ?attachmentPaths,
};

Map<String, dynamic> fakeText(String text) => {'type': 'text', 'text': text};

/// One tab in `tabsFile.tabs`. The per-turn records are keyed by the user
/// message id that started each turn, as the desktop persists them.
Map<String, dynamic> fakeTab(
  String id,
  String title, {
  String model = 'host-model',
  String providerType = 'codex',
  Map<String, Object?>? turnFeedback,
  Map<String, Object?>? turnEnds,
  Map<String, Object?>? unacceptedTurnEnds,
  Map<String, Object?>? interruptedTurns,
  bool? readOnly,
  Map<String, Object?> extra = const {},
}) => {
  'id': id,
  'title': title,
  'model': model,
  'providerType': providerType,
  'approvalMode': 'bypassPermissions',
  'turnFeedback': ?turnFeedback,
  'turnEnds': ?turnEnds,
  'unacceptedTurnEnds': ?unacceptedTurnEnds,
  'interruptedTurns': ?interruptedTurns,
  'readOnly': ?readOnly,
  ...extra,
};

Map<String, dynamic> fakeRuntime(String status) => {
  'status': status,
  'queuedMessageIds': <Object?>[],
};

final _defaultTabs = [
  fakeTab('chat-pkce', 'PKCE implementation'),
  fakeTab('chat-cleanup', 'Widget test cleanup'),
];

final _defaultTranscripts = <String, List<Map<String, dynamic>>>{
  'chat-pkce': [
    fakeMessage('seed-1', 'user', [
      fakeText('Add PKCE to the mobile OAuth flow'),
    ]),
    fakeMessage('seed-2', 'assistant', [
      {
        'type': 'tool_use',
        'toolUseId': 'tool-1',
        'name': 'Bash',
        'input': {
          'command': 'npm test -- auth',
          'description': 'Run the auth tests',
        },
      },
    ]),
    fakeMessage('seed-3', 'user', [
      {
        'type': 'tool_result',
        'toolUseId': 'tool-1',
        'output': '42 passing (3.1s)',
      },
    ]),
    fakeMessage('seed-4', 'assistant', [
      fakeText('PKCE is in place. All 42 auth tests pass.'),
    ]),
  ],
  'chat-cleanup': [
    fakeMessage('clean-1', 'user', [fakeText('Remove the flaky widget tests')]),
    fakeMessage('clean-2', 'assistant', [
      fakeText('Removed three flaky tests.'),
    ]),
  ],
};

const _defaultModelRegistry = {
  'claude': <Object?>[],
  'codex': [
    {'id': 'host-model', 'label': 'Host model'},
  ],
  'ollama': <Object?>[],
  'aliases': <String, Object?>{},
};

/// Answers for screens that read the computer's inventory: one single-repo
/// project, owned by Personal, holding the fake worktree on [branch]. Spread
/// into [FakeDesktopComputer.answers].
Map<String, Object? Function(List<Object?> args)> fakeInventoryAnswers({
  String branch = 'feature/auth',
  String? label,
  String? notificationSpaceId,
}) => {
  'projects:load': (_) => {
    'items': [
      {
        'id': fakeProjectId,
        'name': 'acme-app',
        'type': 'single-repo',
        'worktrees': [
          {'id': fakeWorktreeId, 'branchName': branch},
        ],
      },
    ],
  },
  'desktop:session-snapshot': (_) => {
    'workspaces': [
      {'localId': fakeProjectId, 'name': 'acme-app'},
    ],
    'worktrees': [
      {
        'localId': fakeWorktreeId,
        'workspaceLocalId': fakeProjectId,
        'branch': branch,
        'label': ?label,
        'notificationSpaceId': ?notificationSpaceId,
      },
    ],
  },
};

/// Channels the chat screen and its repositories poll in the background.
/// Null reads as "nothing to show", which is what an idle computer answers.
const _quietChannels = {
  'activity:list-live-bg-tasks',
  'app-advisor:watchers-completed-list',
  'app-advisor:watchers-list',
  'chat:queue-get-snapshot',
  'chat:set-interest',
  'chat:set-state-scopes',
  'desktop:session-snapshot',
  'managed-delegation:activity-list',
  'managed-delegation:tree',
  'pipelines:discover-project',
  'pipelines:list',
  'pipelines:list-executions',
  'preferences:load',
  'projects:load',
  'worktree:get-path',
};

/// Thrown, and recorded in [FakeDesktopComputer.unanswered], for a channel
/// the fake has no answer for.
final class UnansweredChannel implements Exception {
  const UnansweredChannel(this.channel);
  final String channel;
  @override
  String toString() => 'FakeDesktopComputer has no answer for $channel';
}

/// A connected computer behind the tunneled IPC boundary. It answers the
/// desktop channels the chat reads, and answers a sent message with the
/// change pushes the desktop sends while its agent replies.
///
/// Every fixture is optional; the defaults are two idle Codex chats in one
/// worktree. [answers] answers further channels and takes precedence over the
/// built-in answers.
final class FakeDesktopComputer implements DesktopIpc {
  FakeDesktopComputer({
    List<Map<String, dynamic>>? tabs,
    Map<String, Map<String, dynamic>>? runtimeByChatId,
    this.pendingQuestions = const [],
    Map<String, List<Map<String, dynamic>>>? transcripts,
    this.heldSend,
    this.answers = const {},
    Map<String, Object?>? modelRegistry,
  }) : tabs = tabs ?? [..._defaultTabs],
       transcripts = transcripts ?? _defaultTranscripts,
       modelRegistry = modelRegistry ?? _defaultModelRegistry,
       runtimeByChatId =
           runtimeByChatId ??
           {
             for (final tab in tabs ?? _defaultTabs)
               tab['id']: fakeRuntime('idle'),
           };

  final _pushes = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final calls = <({String channel, List<Object?> args})>[];
  final unanswered = <String>[];
  final replied = Completer<void>();
  final partialReply = Completer<void>();
  Completer<void>? heldReply;
  var _revision = 1;

  /// The scope's tabs; a test that pushes `tab.upserted` adds the tab here
  /// too, so a later `chat:get-state` agrees with the push.
  final List<Map<String, dynamic>> tabs;
  final Map<String, Map<String, dynamic>> runtimeByChatId;
  final List<Map<String, dynamic>> pendingQuestions;
  final Map<String, List<Map<String, dynamic>>> transcripts;
  final Map<String, Object?> modelRegistry;

  /// When set, `chat:send-message` waits for it before the computer accepts
  /// the message and replies.
  final Completer<void>? heldSend;
  final Map<String, Object? Function(List<Object?> args)> answers;

  Map<String, dynamic> get _snapshot => {
    'schemaVersion': 1,
    'projectId': fakeProjectId,
    'worktreeId': fakeWorktreeId,
    'revision': _revision,
    'tabsFile': {
      'tabs': tabs,
      if (pendingQuestions.isNotEmpty) 'pendingQuestions': pendingQuestions,
    },
    'runtimeByChatId': runtimeByChatId,
  };

  @override
  Stream<Map<String, dynamic>> get events => _pushes.stream;

  @override
  Future<Object?> invoke(
    String channel, [
    List<Object?> args = const [],
    Duration? timeout,
  ]) async {
    calls.add((channel: channel, args: args));
    if (answers[channel] case final answer?) return answer(args);
    switch (channel) {
      case 'chat-search:catalog':
        return {
          'entries': [
            for (final tab in tabs)
              {
                'projectId': fakeProjectId,
                'worktreeId': fakeWorktreeId,
                'chatId': tab['id'],
                'title': tab['title'],
                'source': 'live',
              },
          ],
        };
      case 'chat-project:list':
        return {
          'projects': [
            {'id': fakeProjectId, 'name': 'acme-app'},
          ],
        };
      case 'model-registry:get':
        return modelRegistry;
      case 'chat:get-state':
        return _snapshot;
      case 'chat:get-transcript-page':
        final target = args.single as Map<String, dynamic>;
        final messages = transcripts[target['chatId']] ?? const [];
        return {
          'messages': messages,
          'transcriptRevision': 1,
          'totalMessages': messages.length,
        };
      case 'chat:send-message':
        final request = args.single as Map<String, dynamic>;
        if (heldSend case final held?) await held.future;
        scheduleMicrotask(() => _reply(request));
        return {'disposition': 'dispatched'};
      case 'chat:command':
        if (args.singleOrNull case {
          'command': final Map<String, dynamic> command,
        }) {
          return _command(command);
        }
        return {'outcome': 'applied', 'entityId': 'chat-pkce', 'revision': 1};
    }
    if (_quietChannels.contains(channel)) return null;
    unanswered.add(channel);
    throw UnansweredChannel(channel);
  }

  /// Applies a tab settings patch or a new tab the way the desktop does: the
  /// change is pushed, then the receipt names the revision that carries it.
  Map<String, dynamic> _command(Map<String, dynamic> command) {
    final id = command['tabId'];
    switch (command['type']) {
      case 'chat.patch_tab_settings':
        final patch = command['patch'] as Map<String, dynamic>;
        final index = tabs.indexWhere((tab) => tab['id'] == id);
        if (index >= 0) tabs[index] = {...tabs[index], ...patch};
        push({'type': 'tab.metadata_patched', 'tabId': id, 'patch': patch});
        return {'outcome': 'applied', 'entityId': id, 'revision': _revision};
      case 'chat.create_tab':
        final tab = fakeTab(id as String, command['title'] as String);
        tabs.add(tab);
        push({'type': 'tab.upserted', 'tab': tab});
        return {'outcome': 'applied', 'entityId': id, 'revision': _revision};
    }
    return {'outcome': 'applied', 'entityId': 'chat-pkce', 'revision': 1};
  }

  /// Pushes one `chat:state-changed` change for the fake worktree, such as
  /// `tab.upserted` or `tab.metadata_patched`.
  void push(Map<String, dynamic> change) => _change([change]);

  void _change(List<Map<String, dynamic>> changes) => _pushes.add({
    'kind': 'event',
    'name': 'ipc.push',
    'payload': {
      'channel': 'chat:state-changed',
      'args': [
        {
          'projectId': fakeProjectId,
          'worktreeId': fakeWorktreeId,
          'baseRevision': _revision,
          'revision': ++_revision,
          'changes': changes,
        },
      ],
    },
  });

  /// The pushes a desktop sends while its agent answers: the accepted user
  /// message and a running turn, a partial reply, then the finished reply and
  /// an idle turn.
  void _reply(Map<String, dynamic> request) async {
    final chatId = request['chatId'] as String;
    final userId = request['userMessageId'] as String;
    Map<String, dynamic> runtime(String status) => {
      'type': 'runtime.patched',
      'chatId': chatId,
      'runtime': fakeRuntime(status),
    };
    Map<String, dynamic> upsert(Map<String, dynamic> message) => {
      'type': 'message.upserted',
      'chatId': chatId,
      'message': message,
    };
    _change([
      upsert(
        fakeMessage(userId, 'user', [fakeText(request['text'] as String)]),
      ),
      runtime('streaming'),
    ]);
    _change([
      upsert(
        fakeMessage('reply-1', 'assistant', [
          fakeText('Deploying now.'),
        ], streaming: true),
      ),
    ]);
    if (!partialReply.isCompleted) partialReply.complete();
    await heldReply?.future;
    _change([
      upsert(
        fakeMessage('reply-1', 'assistant', [
          fakeText(
            'Deployed. The fix is live and the diff is ready for review.',
          ),
        ]),
      ),
      runtime('idle'),
    ]);
    if (!replied.isCompleted) replied.complete();
  }

  Future<void> dispose() => _pushes.close();
}
