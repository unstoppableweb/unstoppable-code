// Markdown tables in the Computer connect chat feed: TABLE_STAGE=after
// flutter test tool/design_system/markdown_table_capture_test.dart --update-goldens
// Seeds a two-column GFM table plus a five-column table that cannot wrap,
// through the fake computer at a 390-wide phone viewport with bundled fonts
// and no network. Both color modes are captured on each run; `after` is the
// default stage.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/device_link/chats_screen.dart';

import '../../test/support/device_chat_harness.dart';
import '../../test/support/fake_attachment_picker.dart';
import '../../test/support/fake_desktop_computer.dart';
import '../../test/support/reduced_motion.dart';

const _reply =
    'Running tally of what the UI has now handled:\n'
    '| Shape | Result |\n'
    '|---|---|\n'
    '| 2 questions, free-form on one | Free-form arrived as "Additional", no option |\n'
    '| 2 questions, single + multi-select | Both returned verbatim |\n'
    '| 1 question, ~100-char labels | Returned verbatim, no truncation |\n'
    '| 3 questions, dismissed | Whole batch discarded as an error |\n'
    '\n'
    'Per-field timings, which are too wide to wrap:\n'
    '| Field | Parse | Validate | Render | Total |\n'
    '|:--|--:|--:|--:|--:|\n'
    '| `free_form_answer` | 0.4 ms | 1.2 ms | 3.9 ms | 5.5 ms |\n'
    '| `multi_select_answer` | 0.3 ms | 0.8 ms | 4.1 ms | 5.2 ms |';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  useReducedMotion();
  final stage = Platform.environment['TABLE_STAGE'] ?? 'after';

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
    testWidgets('markdown table $mode', (tester) async {
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      final harness = buildDeviceChatHarness(
        computer: FakeDesktopComputer(
          tabs: [fakeTab('chat-1', 'Question shapes')],
          transcripts: {
            'chat-1': [
              fakeMessage('u-1', 'user', [
                fakeText('What has the UI handled so far?'),
              ]),
              fakeMessage('a-1', 'assistant', [fakeText(_reply)]),
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

      Future<void> capture(String name) async {
        expect(tester.takeException(), isNull);
        await expectLater(
          find.byType(DeviceChatScreen),
          matchesGoldenFile(
            '../../../../.playwright/mobile-markdown-table/$name-$stage-$mode.png',
          ),
        );
      }

      final validate = find.textContaining('Validate', findRichText: true);
      expect(validate, findsWidgets);
      // The feed opens scrolled to the newest message.
      await capture('feed');

      // The wide table pans in place, through its own scroll view.
      final wideTable = find.ancestor(
        of: validate,
        matching: find.byType(SingleChildScrollView),
      );
      expect(wideTable, findsWidgets);
      await tester.drag(wideTable.first, const Offset(-200, 0));
      await tester.pumpAndSettle();
      await capture('feed-scrolled');

      // Scroll the feed up so the reply's opening line and the header row of
      // the first table are visible.
      await tester.drag(find.byType(ListView).last, const Offset(0, 260));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Running tally', findRichText: true),
        findsOneWidget,
      );
      await capture('feed-top');
      await tester.pumpWidget(const SizedBox());
    });
  }
}
