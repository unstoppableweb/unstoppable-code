// Pending send on a Computer connect chat: SEND_STAGE=after
// flutter test tool/design_system/chat_send_capture_test.dart --update-goldens
// Captures both themes while the fake computer holds the send open. No
// network.
import 'dart:async';
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
  useReducedMotion();
  final stage = Platform.environment['SEND_STAGE'] ?? 'after';

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
    testWidgets('pending send $mode', (tester) async {
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      final held = (await tester.runAsync(() async => Completer<void>()))!;
      final harness = await buildDeviceChatHarness(
        tester,
        computer: FakeDesktopComputer(heldSend: held),
      );
      addTearDown(harness.dispose);
      await harness.open(
        tester,
        'chat-pkce',
        mode: dark ? ThemeMode.dark : ThemeMode.light,
        screen: (model) => DeviceChatScreen(
          model: model,
          attachmentPicker: FakeAttachmentPicker(),
        ),
      );

      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'Deploy the fix',
      );
      await harness.settle(tester);
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pump(const Duration(milliseconds: 100));

      // Computer connect keeps the draft until the computer accepts the
      // message, so the pending frame shows it beside the sending control.
      expect(harness.model.chats.sending, isTrue);
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
            .controller
            ?.text,
        'Deploy the fix',
      );
      expect(tester.takeException(), isNull);
      await expectLater(
        find.byKey(const ValueKey('chat-composer')),
        matchesGoldenFile(
          '../../../../.playwright/mobile-send-clear/pending-$stage-$mode.png',
        ),
      );

      held.complete();
      await harness.settle(tester);
      expect(harness.computer.replied.isCompleted, isTrue);
      await tester.pumpWidget(const SizedBox());
    });
  }
}
