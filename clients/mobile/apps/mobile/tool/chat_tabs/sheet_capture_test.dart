// Computer connect chat tabs: the conversations FAB and its bottom sheet.
//
// A small FAB in the transcript's bottom-right corner carries a dot when any
// conversation in the worktree is unread, and opens a bottom sheet listing
// every tab (title, unread dot or working spinner, per-row close) with a
// pinned "New chat" action. Replaces the Portal-era
// tool/remote_tabs/sheet_capture_test.dart and keeps its output slug.
//
// Run from apps/mobile; both color modes run together:
//   REMOTE_TAB_SHEET_STAGE=after flutter test \
//     tool/chat_tabs/sheet_capture_test.dart --update-goldens
//
// Deterministic: fixed tabs from the fake computer, bundled fonts, a pinned
// viewport, and no network or live agents.
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

const _longTitle = 'Rewrite the onboarding copy for non-technical users';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // The running tab's spinner would otherwise keep animating.
  useReducedMotion();
  final stage = Platform.environment['REMOTE_TAB_SHEET_STAGE'] ?? 'after';

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
    testWidgets('chat tabs $mode', (tester) async {
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      final harness = await buildDeviceChatHarness(
        tester,
        computer: FakeDesktopComputer(
          tabs: [
            fakeTab('idle', 'Idle'),
            fakeTab('running', 'Running'),
            fakeTab('unread', 'Unread', extra: {'unread': true}),
            fakeTab('long', _longTitle),
          ],
          runtimeByChatId: {
            for (final id in ['idle', 'unread', 'long'])
              id: fakeRuntime('idle'),
            'running': fakeRuntime('streaming'),
          },
          transcripts: {
            'idle': [
              fakeMessage('idle-1', 'user', [
                fakeText('Where did the tab strip go?'),
              ]),
              fakeMessage('idle-2', 'assistant', [
                fakeText(
                  'It moved behind the conversations button in the corner.',
                ),
              ]),
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

      // The app, not just the screen: the sheet is a route in the
      // navigator's overlay.
      Future<void> capture(String name) async {
        expect(tester.takeException(), isNull);
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile(
            '../../../../.playwright/remote-tab-sheet/$name-$stage-$mode.png',
          ),
        );
      }

      expect(find.byKey(const ValueKey('chat-tabs-fab')), findsOneWidget);
      expect(find.textContaining('conversations button'), findsOneWidget);
      await capture('screen');

      await tester.openTabsSheet();
      for (final id in ['idle', 'running', 'unread', 'long']) {
        expect(find.byKey(ValueKey('chat-tab-$id')), findsOneWidget);
      }
      expect(find.byKey(const ValueKey('new-chat-button')), findsOneWidget);
      await capture('sheet');
      await tester.dismissTabsSheet();
      await tester.pumpWidget(const SizedBox());
    });
  }
}
