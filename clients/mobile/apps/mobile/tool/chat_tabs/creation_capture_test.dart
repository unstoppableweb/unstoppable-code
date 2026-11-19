// New chat tabs on a Computer connect chat, light and dark evidence.
// REMOTE_TAB_CREATION_STAGE=after flutter test
// tool/chat_tabs/creation_capture_test.dart --update-goldens, from apps/mobile.
// Replaces the Portal-era tool/remote_tabs/creation_capture_test.dart and
// keeps its output slug. Fixed tabs, bundled fonts, no network or live agents.
//
// The tab is created from the conversations sheet's "New chat" action; the
// fake computer applies the command and pushes `tab.upserted`, as the desktop
// does. The capture is of the screen right after the sheet dismisses, showing
// the new empty conversation open.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/device_link/chats_screen.dart';

import '../../test/support/chat_tabs_sheet_driver.dart';
import '../../test/support/device_chat_harness.dart';
import '../../test/support/fake_attachment_picker.dart';
import '../../test/support/fake_desktop_computer.dart';
import '../../test/support/reduced_motion.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  useReducedMotion();
  final stage = Platform.environment['REMOTE_TAB_CREATION_STAGE'] ?? 'after';

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
    testWidgets('chat tab creation $mode', (tester) async {
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      final harness = buildDeviceChatHarness(
        computer: FakeDesktopComputer(
          tabs: [fakeTab('idle', 'Idle')],
          transcripts: {
            'idle': [
              fakeMessage('idle-1', 'user', [fakeText('Tidy the README')]),
              fakeMessage('idle-2', 'assistant', [fakeText('Done.')]),
            ],
          },
        ),
      );
      addTearDown(harness.dispose);
      await harness.open(
        tester,
        'idle',
        mode: dark ? ThemeMode.dark : ThemeMode.light,
        screen: (model) => DeviceChatScreen(
          model: model,
          attachmentPicker: FakeAttachmentPicker(),
        ),
      );

      await tester.startNewChatFromSheet();
      await tester.finishSheetDismiss();
      await tester.pumpAndSettle();

      expect(harness.computer.tabs, hasLength(2));
      final created = harness.computer.tabs.last['id'];
      expect(harness.model.state?.ref.id, created);
      expect(find.text('Tidy the README'), findsNothing);
      expect(tester.takeException(), isNull);
      await expectLater(
        find.byType(DeviceChatScreen),
        matchesGoldenFile(
          '../../../../.playwright/remote-tab-creation/tabs-$stage-$mode.png',
        ),
      );
      await tester.pumpWidget(const SizedBox());
    });
  }
}
