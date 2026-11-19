// Computer connect chat feed (desktop-parity transcript): FEED_STAGE=after
// flutter test tool/design_system/chat_feed_capture_test.dart --update-goldens
// Seeded transcript through the fake computer, bundled fonts, no network,
// reduce-motion so the streaming spinner renders a static frame. Both color
// modes are captured on each run; `after` is the default stage.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/device_link/chats_screen.dart';

import '../../test/support/device_chat_harness.dart';
import '../../test/support/fake_attachment_picker.dart';
import '../../test/support/fake_desktop_computer.dart';
import '../../test/support/reduced_motion.dart';

Map<String, dynamic> _tool(
  String id,
  String name,
  Map<String, Object?> input,
) => {'type': 'tool_use', 'toolUseId': id, 'name': name, 'input': input};

final _transcript = [
  fakeMessage('u-1', 'user', [
    fakeText('Fix the login badge so it only shows on the sign-in screen.'),
  ]),
  fakeMessage('a-1', 'assistant', [
    {'type': 'thinking', 'text': 'First I will inspect the auth flow.'},
    _tool('t-1', 'Read', {'file_path': 'lib/auth/login_badge.dart'}),
    _tool('t-2', 'Bash', {
      'command': 'npm test -- auth',
      'description': 'Run the auth tests',
    }),
    _tool('t-3', 'Edit', {'file_path': 'lib/auth/login_badge.dart'}),
  ]),
  fakeMessage('a-2', 'assistant', [
    fakeText(
      'Done. The badge now renders only on the sign-in screen.\n\n'
      '- Moved the visibility check into `LoginBadge`\n'
      '- Added a regression test in `login_badge_test.dart`\n\n'
      'All 42 auth tests pass.',
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
  fakeMessage('u-2', 'user', [
    fakeText('Great, now update the runbook to match.'),
  ]),
  fakeMessage('a-3', 'assistant', [
    {'type': 'thinking', 'text': 'Locating the runbook section on badges.'},
    _tool('t-4', 'Grep', {'pattern': 'login badge', 'path': 'docs'}),
    fakeText('I found the section. Updating it now.'),
  ], streaming: true),
];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  useReducedMotion();
  final stage = Platform.environment['FEED_STAGE'] ?? 'after';

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
    testWidgets('computer chat feed $mode', (tester) async {
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      final harness = buildDeviceChatHarness(
        computer: FakeDesktopComputer(
          tabs: [fakeTab('chat-1', 'Login badge')],
          runtimeByChatId: {'chat-1': fakeRuntime('streaming')},
          transcripts: {'chat-1': _transcript},
        ),
      );
      addTearDown(harness.dispose);
      harness.model.connection.host = {'name': 'Studio Mac'};
      await harness.open(
        tester,
        'chat-1',
        mode: dark ? ThemeMode.dark : ThemeMode.light,
        screen: (model) => DeviceChatScreen(
          model: model,
          locationLabel: 'feature/login-badge',
          attachmentPicker: FakeAttachmentPicker(),
        ),
      );

      Future<void> capture(String name) async {
        expect(tester.takeException(), isNull);
        await expectLater(
          find.byType(DeviceChatScreen),
          matchesGoldenFile(
            '../../../../.playwright/mobile-chat-feed/$name-$stage-$mode.png',
          ),
        );
      }

      expect(find.textContaining('All 42 auth tests pass'), findsOneWidget);
      await capture('collapsed');

      // Expand the first turn's steps.
      await tester.tap(find.byKey(const ValueKey('turn-steps-u-1')));
      await tester.pumpAndSettle();
      expect(find.text('Run the auth tests'), findsOneWidget);
      await capture('expanded');
      await tester.pumpWidget(const SizedBox());
    });
  }
}
