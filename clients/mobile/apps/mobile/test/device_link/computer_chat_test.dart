import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/device_link/chats_view_model.dart';

import '../support/device_chat_harness.dart';
import '../support/fake_desktop_computer.dart';

// Golden: a Computer connect chat on a connected computer shows the chat's
// transcript and its sibling chats, a sent message reaches the computer and
// the reply the computer streams back renders in the transcript, and the tabs
// sheet switches to another chat's transcript. Everything below the tunneled
// IPC boundary is real: the repository, the view model and the screen.
void main() {
  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    group('Computer connect chat ($mode)', () {
      late DeviceChatHarness harness;
      late FakeDesktopComputer computer;
      late DeviceChatsViewModel model;

      setUp(() {
        harness = buildDeviceChatHarness();
        computer = harness.computer;
        model = harness.model;
      });

      tearDown(() => harness.dispose());

      Future<void> openChat(WidgetTester tester, String id) =>
          harness.open(tester, id, mode: mode);

      testWidgets('renders the transcript and the worktree chats', (
        tester,
      ) async {
        await openChat(tester, 'chat-pkce');

        expect(find.text('Add PKCE to the mobile OAuth flow'), findsOneWidget);
        expect(find.textContaining('All 42 auth tests pass'), findsOneWidget);
        expect(find.byKey(const ValueKey('composer-stop')), findsNothing);

        // The agent's tool steps collapse behind one summary row until it is
        // expanded.
        final semantics = tester.ensureSemantics();
        expect(find.bySemanticsLabel('Agent steps: 1 bash'), findsOneWidget);
        semantics.dispose();
        expect(find.text('Run the auth tests'), findsNothing);
        await tester.tap(find.byKey(const ValueKey('turn-steps-seed-1')));
        await tester.pumpAndSettle();
        expect(find.text('Run the auth tests'), findsOneWidget);
        expect(find.text('npm test -- auth'), findsOneWidget);

        await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('chat-tab-chat-pkce')),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byType(BottomSheet),
            matching: find.text('Widget test cleanup'),
          ),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      });

      testWidgets('sends a message and streams the reply', (tester) async {
        await openChat(tester, 'chat-pkce');

        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Deploy the fix',
        );
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.runAsync(() => computer.replied.future);
        await tester.pumpAndSettle();

        final send = computer.calls
            .lastWhere((c) => c.channel == 'chat:send-message')
            .args
            .single;
        expect(send, isA<Map<String, dynamic>>());
        final request = send as Map<String, dynamic>;
        expect(request['chatId'], 'chat-pkce');
        expect(request['text'], 'Deploy the fix');
        expect(find.text('Deploy the fix'), findsOneWidget);
        expect(
          find.textContaining('the diff is ready for review'),
          findsOneWidget,
        );
        expect(find.byKey(const ValueKey('composer-stop')), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      });

      testWidgets('switches chats from the tabs sheet', (tester) async {
        await openChat(tester, 'chat-pkce');

        await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('chat-tab-chat-cleanup')));
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 20)),
        );
        await tester.pumpAndSettle();

        expect(model.state?.ref.id, 'chat-cleanup');
        expect(find.text('Remove the flaky widget tests'), findsOneWidget);
        expect(find.text('Add PKCE to the mobile OAuth flow'), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      });
    });
  }
}
