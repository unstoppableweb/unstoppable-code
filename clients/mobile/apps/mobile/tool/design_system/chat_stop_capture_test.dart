// Running chat stop state on a Computer connect chat: COMPOSER_STAGE=after
// flutter test tool/design_system/chat_stop_capture_test.dart --update-goldens
// Fake computer and bundled fonts, no network. Both color modes.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/device_link/chats_screen.dart';

import '../../test/support/device_chat_harness.dart';
import '../../test/support/fake_attachment_picker.dart';
import '../../test/support/fake_desktop_computer.dart';
import '../../test/support/reduced_motion.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // The running turn puts an always-on spinner on screen; reduce-motion keeps
  // pumpAndSettle able to settle.
  useReducedMotion();
  final stage = Platform.environment['COMPOSER_STAGE'] ?? 'after';

  setUpAll(() async {
    await (FontLoader(
      'Inter',
    )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });

  for (final dark in [false, true]) {
    final mode = dark ? 'dark' : 'light';
    testWidgets('composer stop $mode', (tester) async {
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      final harness = buildDeviceChatHarness(
        computer: FakeDesktopComputer(
          tabs: [fakeTab('chat-1', 'Chat A')],
          transcripts: {
            'chat-1': [
              fakeMessage('m-1', 'assistant', [fakeText('Working on it…')]),
            ],
          },
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
      final stop = find.byKey(const ValueKey('composer-stop'));

      Future<void> capture(String name) async {
        expect(tester.takeException(), isNull);
        await expectLater(
          find.byKey(const ValueKey('chat-composer')),
          matchesGoldenFile(
            '../../../../.playwright/mobile-chat-stop/$name-$stage-$mode.png',
          ),
        );
      }

      expect(stop, findsNothing);
      await capture('idle');

      harness.computer.push({
        'type': 'runtime.patched',
        'chatId': 'chat-1',
        'runtime': fakeRuntime('streaming'),
      });
      await tester.pumpAndSettle();
      expect(stop, findsOneWidget);
      await capture('running-empty');

      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'Follow up',
      );
      await tester.pumpAndSettle();
      expect(find.text('Follow up'), findsOneWidget);
      await capture('running-draft');
      await tester.pumpWidget(const SizedBox());
    });
  }
}
