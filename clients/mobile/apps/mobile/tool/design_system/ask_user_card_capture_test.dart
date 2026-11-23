// Agent input card on a Computer connect chat: ASK_USER_STAGE=after
// flutter test tool/design_system/ask_user_card_capture_test.dart --update-goldens
//
// The awaiting AskUserQuestion card is a transcript row below the agent's
// last message, so it scrolls with the conversation. It mirrors the shared
// desktop/web card: radio rows with wrapping labels, "Other" as a selectable
// choice whose field only appears once picked, and Submit/Dismiss buttons.
//
// The question arrives in the computer's `tabsFile.pendingQuestions`. Both
// color modes are captured on each run; `after` is the default stage. Bundled
// fonts, no network, and reduce-motion, so every frame is deterministic.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/chat/widgets/pending_question_card.dart';
import 'package:mobile/ui/features/device_link/chats_screen.dart';

import '../../test/support/device_chat_harness.dart';
import '../../test/support/fake_attachment_picker.dart';
import '../../test/support/fake_desktop_computer.dart';
import '../../test/support/reduced_motion.dart';

final _question = {
  'chatId': 'chat-1',
  'requestId': 'req-1',
  'questions': [
    {
      'id': 'q-1',
      'question':
          'What should each row in the tab list sheet carry? '
          "Today's chips have title + close X + streaming spinner "
          '+ unread dot.',
      'options': [
        'Everything the chips had: title, unread dot, working spinner',
        'Title, unread dot and spinner only — drop the close X',
        'Title, unread dot, spinner, plus a swipe-to-close gesture',
      ],
    },
  ],
};

final _transcript = [
  fakeMessage('u-1', 'user', [fakeText('Move the chat tabs into a sheet.')]),
  fakeMessage('a-1', 'assistant', [
    fakeText(
      'For cowork/standalone chats the app bar already shows the chat '
      "title, so I'll simply drop the synthetic one-tab strip there and "
      "show no FAB (there's only ever one chat and no new-chat action). "
      'Next:',
    ),
  ]),
  fakeMessage('u-1:turn-timer', 'system', [
    {
      'type': 'turn_timer',
      'userMessageId': 'u-1',
      'startedAt': 100000,
      'completedAt': 163000,
    },
  ]),
];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  useReducedMotion();
  final stage = Platform.environment['ASK_USER_STAGE'] ?? 'after';

  setUpAll(() async {
    await (FontLoader(
      'Inter',
    )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
    await (FontLoader('JetBrainsMono')..addFont(
          rootBundle.load(
            'assets/fonts/jetbrains-mono/JetBrainsMonoVariable.ttf',
          ),
        ))
        .load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });

  for (final dark in [false, true]) {
    final mode = dark ? 'dark' : 'light';
    testWidgets('agent input card $mode', (tester) async {
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      final harness = await buildDeviceChatHarness(
        tester,
        computer: FakeDesktopComputer(
          tabs: [fakeTab('chat-1', 'Chat tabs')],
          pendingQuestions: [_question],
          transcripts: {'chat-1': _transcript},
        ),
      );
      addTearDown(harness.dispose);
      await harness.open(
        tester,
        'chat-1',
        mode: dark ? ThemeMode.dark : ThemeMode.light,
        screen: (model) => DeviceChatScreen(
          model: model,
          attachmentPicker: FakeAttachmentPicker(),
        ),
      );

      Future<void> capture(String name) async {
        expect(tester.takeException(), isNull);
        await expectLater(
          find.byType(DeviceChatScreen),
          matchesGoldenFile(
            '../../../../.playwright/mobile-ask-user-card/$name-$stage-$mode.png',
          ),
        );
      }

      expect(find.byType(PendingQuestionCard), findsOneWidget);
      await capture('at-rest');

      // Pick "Other" to show the conditional multi-line field.
      final other = find.text('Other');
      expect(other, findsOneWidget);
      await tester.tap(other);
      await harness.settle(tester);
      expect(
        find.descendant(
          of: find.byType(PendingQuestionCard),
          matching: find.byType(TextField),
        ),
        findsOneWidget,
      );
      await capture('other-selected');
      await tester.tap(other);
      await harness.settle(tester);

      // The card travels with the conversation when the transcript scrolls.
      await tester.drag(
        find.byKey(const ValueKey('remote-chat-transcript')),
        const Offset(0, 220),
      );
      await harness.settle(tester);
      expect(find.byType(PendingQuestionCard), findsOneWidget);
      await capture('scrolled');
      await tester.pumpWidget(const SizedBox());
    });
  }
}
