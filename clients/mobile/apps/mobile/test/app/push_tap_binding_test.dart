// Notification taps (CAN-5986, CAN-7218): a cloud run's tap opens the run on
// the web; any other tap returns to the shell and opens the Chat home, or the
// first destination of a shell without it (a guest's). A tap that names a
// chat on a computer then asks the push chat router for it and hands the
// chat to the shell; a newer tap wins over one still resolving. A break
// strands a tap on a screen above the shell, opens a link that is not the
// app's own, or opens the wrong tap's chat.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/app/push_tap_binding.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/services/push_messaging.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/services/push_message_coordinator.dart';
import 'package:mobile/ui/core/navigation/home_chat_open_request.dart';
import 'package:mobile/ui/core/navigation/home_recent_chats.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:provider/provider.dart';

const _appOrigin = 'https://app.example.test';
const _computerId = 'AAAAAAAAAAAAAAAAAAAAAA';

HomeRecentChat _chat(String key) => HomeRecentChat(
  key: key,
  title: key,
  computerName: 'Studio',
  attention: RecentChatAttention.none,
  activityAt: null,
  isCurrent: () => false,
  open: (_, _) async {},
);

/// Answers each resolve with a completer the test completes.
class _FakeRouter implements PushChatRouter {
  final calls = <({String computerId, String clientChatId})>[];
  final answers = <Completer<HomeRecentChat?>>[];

  @override
  Future<HomeRecentChat?> resolve({
    required String computerId,
    required String clientChatId,
    required WorkspaceContext? workspaceContext,
  }) {
    calls.add((computerId: computerId, clientChatId: clientChatId));
    final answer = Completer<HomeRecentChat?>();
    answers.add(answer);
    return answer.future;
  }
}

PushMessage _chatTap(String chatId) => PushMessage(
  data: {
    'type': 'run_completed',
    'worktreeId': 'server-worktree',
    'clientChatId': chatId,
    'computerId': _computerId,
  },
);

HomeChatOpenRequests _requests(WidgetTester tester) =>
    tester.element(find.text('open a chat')).read<HomeChatOpenRequests>();

class _Harness {
  _Harness(this.coordinator, this.opened);

  final PushMessageCoordinator coordinator;
  final List<String> opened;
}

Future<_Harness> _pumpShell(
  WidgetTester tester, {
  required List<HomeTab> tabs,
  required HomeTab initialTab,
  PushChatRouter? router,
}) async {
  final coordinator = PushMessageCoordinator(messaging: FakePushMessaging());
  final opened = <String>[];
  await tester.pumpWidget(
    MaterialApp(
      home: HomeTabControllerProvider(
        tabs: tabs,
        initialTab: initialTab,
        child: Provider<PushChatRouter?>.value(
          value: router,
          child: PushTapBinding(
            coordinator: coordinator,
            openUrl: (url) async => opened.add(url),
            child: Builder(
              builder: (context) => Scaffold(
                body: Column(
                  children: [
                    Text(
                      'tab:${context.watch<HomeTabController>().value.name}',
                    ),
                    TextButton(
                      onPressed: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) =>
                              const Scaffold(body: Text('an open chat')),
                        ),
                      ),
                      child: const Text('open a chat'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return _Harness(coordinator, opened);
}

void main() {
  setUp(() {
    AppConfig.configureEnvironmentController(
      ApiEnvironmentController(
        productionBaseUrl: _appOrigin,
        stagingBaseUrl: _appOrigin,
        initialEnvironment: ApiEnvironment.production,
        preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
      ),
    );
  });

  testWidgets('a cloud run tap opens the run on the web and stays put', (
    tester,
  ) async {
    final shell = await _pumpShell(
      tester,
      tabs: const [HomeTab.chat, HomeTab.account],
      initialTab: HomeTab.account,
    );
    shell.coordinator.pendingTap.value = const PushMessage(
      data: {'type': 'cloud_run', 'url': '$_appOrigin/runs/run-1'},
    );
    await tester.pumpAndSettle();

    expect(shell.opened, ['$_appOrigin/runs/run-1']);
    expect(find.text('tab:account'), findsOneWidget);
    expect(shell.coordinator.pendingTap.value, isNull);
  });

  testWidgets(
    'any other tap returns to the shell and opens the Chat home, even a run link on another origin',
    (tester) async {
      final shell = await _pumpShell(
        tester,
        tabs: const [HomeTab.chat, HomeTab.account],
        initialTab: HomeTab.account,
      );
      await tester.tap(find.text('open a chat'));
      await tester.pumpAndSettle();
      expect(find.text('an open chat'), findsOneWidget);

      for (final data in [
        {'type': 'chat_turn', 'chatId': 'chat-1'},
        {'type': 'cloud_run', 'url': 'https://elsewhere.test/runs/run-1'},
      ]) {
        shell.coordinator.pendingTap.value = PushMessage(data: data);
        await tester.pumpAndSettle();
        expect(find.text('an open chat'), findsNothing);
        expect(find.text('tab:chat'), findsOneWidget);
        expect(shell.coordinator.pendingTap.value, isNull);
      }
      expect(shell.opened, isEmpty);
    },
  );

  testWidgets('a shell without the Chat home opens its first destination', (
    tester,
  ) async {
    final shell = await _pumpShell(
      tester,
      tabs: const [HomeTab.account, HomeTab.advisor],
      initialTab: HomeTab.advisor,
    );
    shell.coordinator.pendingTap.value = const PushMessage(
      data: {'type': 'chat_turn', 'chatId': 'chat-1'},
    );
    await tester.pumpAndSettle();

    expect(find.text('tab:account'), findsOneWidget);
    expect(shell.coordinator.pendingTap.value, isNull);
  });

  testWidgets(
    'a tap naming a chat on a computer shows the Chat home, then hands the routed chat to the shell',
    (tester) async {
      final router = _FakeRouter();
      final shell = await _pumpShell(
        tester,
        tabs: const [HomeTab.chat, HomeTab.account],
        initialTab: HomeTab.account,
        router: router,
      );
      shell.coordinator.pendingTap.value = _chatTap('chat-1');
      await tester.pumpAndSettle();

      expect(find.text('tab:chat'), findsOneWidget);
      expect(router.calls, [(computerId: _computerId, clientChatId: 'chat-1')]);
      expect(_requests(tester).take(), isNull);

      final chat = _chat('chat-1');
      router.answers.single.complete(chat);
      await tester.pumpAndSettle();

      expect(_requests(tester).take(), same(chat));
      expect(shell.coordinator.pendingTap.value, isNull);
    },
  );

  testWidgets(
    'a tap the router cannot resolve stays on the Chat home and clears the tap',
    (tester) async {
      final router = _FakeRouter();
      final shell = await _pumpShell(
        tester,
        tabs: const [HomeTab.chat, HomeTab.account],
        initialTab: HomeTab.account,
        router: router,
      );
      shell.coordinator.pendingTap.value = _chatTap('chat-1');
      await tester.pumpAndSettle();
      router.answers.single.complete(null);
      await tester.pumpAndSettle();

      expect(find.text('tab:chat'), findsOneWidget);
      expect(_requests(tester).take(), isNull);
      expect(shell.coordinator.pendingTap.value, isNull);

      // A payload without a relay device id never asks the router.
      shell.coordinator.pendingTap.value = const PushMessage(
        data: {'type': 'run_completed', 'clientChatId': 'chat-2'},
      );
      await tester.pumpAndSettle();
      expect(router.calls, hasLength(1));
      expect(shell.coordinator.pendingTap.value, isNull);
    },
  );

  testWidgets(
    'a newer tap wins over one still resolving; the older result is discarded',
    (tester) async {
      final router = _FakeRouter();
      final shell = await _pumpShell(
        tester,
        tabs: const [HomeTab.chat, HomeTab.account],
        initialTab: HomeTab.account,
        router: router,
      );
      shell.coordinator.pendingTap.value = _chatTap('chat-1');
      await tester.pumpAndSettle();
      final second = _chatTap('chat-2');
      shell.coordinator.pendingTap.value = second;
      await tester.pumpAndSettle();
      expect(router.calls.map((call) => call.clientChatId), [
        'chat-1',
        'chat-2',
      ]);

      router.answers.first.complete(_chat('chat-1'));
      await tester.pumpAndSettle();
      expect(_requests(tester).take(), isNull);
      // The stale result does not clear the newer tap.
      expect(shell.coordinator.pendingTap.value, same(second));

      final chat = _chat('chat-2');
      router.answers.last.complete(chat);
      await tester.pumpAndSettle();
      expect(_requests(tester).take(), same(chat));
      expect(shell.coordinator.pendingTap.value, isNull);
    },
  );
}
