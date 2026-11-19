// Chat attachments on a Computer connect chat: captures the attach control,
// the staged strip's uploading and failed states, and the transcript's
// filename chips.
//
// Run: (cd apps/mobile && flutter test
// tool/design_system/chat_attachments_capture_test.dart --update-goldens)
//
// Deterministic: every computer call goes through the fake computer (no
// network) and every file pick goes through `FakeAttachmentPicker` (no
// platform channel). Files reach the computer through the real
// `DeviceChatAttachmentUploader`. The "uploading" chip is held open with a
// `Completer` this test controls, and the "failed" chip comes from the
// computer refusing the import. Bundled fonts.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/ui/core/chat/widgets/attachment_strip.dart';
import 'package:mobile/ui/features/device_link/chats_screen.dart';

import '../../test/support/composer_driver.dart';
import '../../test/support/device_chat_harness.dart';
import '../../test/support/fake_attachment_picker.dart';
import '../../test/support/fake_desktop_computer.dart';
import '../../test/support/reduced_motion.dart';
import '../../test/support/tiny_png.dart';

const _folder = '/Users/sam/acme-app/.canopy/attachments';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  useReducedMotion();

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
    final themeMode = dark ? ThemeMode.dark : ThemeMode.light;

    Future<void> capture(
      WidgetTester tester,
      Finder subject,
      String name,
    ) async {
      expect(tester.takeException(), isNull);
      await expectLater(
        subject,
        matchesGoldenFile(
          '../../../../.playwright/mobile-attachments/$name-$mode.png',
        ),
      );
    }

    testWidgets('composer states $mode', (tester) async {
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      final uploadGate = Completer<Object?>();
      final harness = buildDeviceChatHarness(
        computer: FakeDesktopComputer(
          answers: {
            'workspace-items:import-attachments': (args) {
              final request = args.single as Map<String, dynamic>;
              final item = (request['clipboardItems'] as List).single as Map;
              if (item['filename'] == 'notes.pdf') {
                throw const DeviceLinkException(
                  'Attach files of 10 MB or smaller.',
                );
              }
              return uploadGate.future;
            },
            'workspace-items:delete-attachment': (_) => null,
          },
        ),
      );
      addTearDown(harness.dispose);
      final picker = FakeAttachmentPicker();
      await harness.open(
        tester,
        'chat-pkce',
        mode: themeMode,
        screen: (model) =>
            DeviceChatScreen(model: model, attachmentPicker: picker),
      );
      final composer = find.byKey(const ValueKey('chat-composer'));

      // The attach control is offered and nothing is staged yet.
      expect(await composerAttachRowEnabled(tester), isTrue);
      expect(find.byType(AttachmentStrip), findsNothing);
      await capture(tester, composer, 'composer-idle-after');

      // One file the computer refuses (Retry shown), then one still
      // uploading. Uploads run one at a time, so the refusal comes first.
      Future<void> attach(PickedAttachment file) async {
        picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
          file,
        ]);
        await openComposerActions(tester);
        await tester.tap(
          find.byKey(const ValueKey('composer-action-attach-files')),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
      }

      await attach(
        FakeAttachmentPicker.file(
          'notes.pdf',
          mediaType: 'application/pdf',
          size: 8,
        ),
      );
      // The refusal's snack bar would cover the composer's + control.
      ScaffoldMessenger.of(tester.element(composer)).removeCurrentSnackBar();
      await tester.pump();
      await attach(
        PickedAttachment(
          filename: 'screenshot.png',
          mediaType: 'image/png',
          bytes: tinyPngBytes,
        ),
      );
      // A fixed spinner frame so the uploading ring reads clearly.
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(AttachmentStrip), findsOneWidget);
      expect(find.byTooltip('Retry upload'), findsOneWidget);
      await capture(tester, composer, 'composer-staged-after');

      uploadGate.complete({
        'attachments': [
          {
            'filename': 'screenshot.png',
            'absolutePath': '$_folder/screenshot.png',
            'sizeBytes': tinyPngBytes.length,
          },
        ],
      });
      await tester.pump();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('transcript chips $mode', (tester) async {
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      final harness = buildDeviceChatHarness(
        computer: FakeDesktopComputer(
          tabs: [fakeTab('chat-a', 'Chat A')],
          transcripts: {
            'chat-a': [
              fakeMessage(
                'u-1',
                'user',
                [fakeText('Here are the two files from the design review.')],
                attachmentPaths: [
                  '$_folder/design-notes.pdf',
                  '$_folder/homescreen.png',
                ],
              ),
              fakeMessage(
                'u-2',
                'user',
                const [],
                attachmentPaths: ['$_folder/crash-log.txt'],
              ),
            ],
          },
        ),
      );
      addTearDown(harness.dispose);
      await harness.open(
        tester,
        'chat-a',
        mode: themeMode,
        screen: (model) => DeviceChatScreen(
          model: model,
          attachmentPicker: FakeAttachmentPicker(),
        ),
      );

      for (final name in [
        'design-notes.pdf',
        'homescreen.png',
        'crash-log.txt',
      ]) {
        expect(find.text(name), findsOneWidget);
      }
      await capture(
        tester,
        find.byType(DeviceChatScreen),
        'transcript-chips-after',
      );
      await tester.pumpWidget(const SizedBox());
    });
  }
}
