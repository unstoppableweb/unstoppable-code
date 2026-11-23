// Chat input on a Computer connect chat: COMPOSER_STAGE=after flutter test
// tool/design_system/chat_input_capture_test.dart --update-goldens
// Fake computer and bundled fonts, no network. Both color modes.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/device_link/chats_screen.dart';

import '../../test/support/composer_driver.dart';
import '../../test/support/device_chat_harness.dart';
import '../../test/support/fake_attachment_picker.dart';
import '../../test/support/fake_desktop_computer.dart';
import '../../test/support/reduced_motion.dart';

const _levels = ['off', 'low', 'medium', 'high'];

/// The registry the computer serves: a Claude model, Codex models from
/// several vendors and one model that uses AI Credits.
const _registry = {
  'claude': [
    {
      'id': 'claude-sonnet',
      'label': 'Claude Sonnet 4.5',
      'vendor': 'anthropic',
      'supportedThinkingLevels': _levels,
    },
    {
      'id': 'premium-model',
      'label': 'Premium Model',
      'vendor': 'anthropic',
      'extraChargeOnly': true,
      'extraChargeMessage': 'Uses AI Credits.',
      'supportedThinkingLevels': _levels,
    },
  ],
  'codex': [
    {
      'id': 'gpt-5-codex',
      'label': 'GPT-5 Codex',
      'vendor': 'openai',
      'supportedThinkingLevels': _levels,
    },
    {
      'id': 'kimi-k3',
      'label': 'Kimi K3',
      'vendor': 'moonshot',
      'supportedThinkingLevels': _levels,
    },
    {
      'id': 'minimax-m3',
      'label': 'MiniMax M3',
      'vendor': 'minimax',
      'supportedThinkingLevels': _levels,
    },
  ],
  'ollama': <Object?>[],
  'aliases': <String, Object?>{},
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // The streaming stage puts an always-on spinner on screen; reduce-motion
  // keeps pumpAndSettle able to settle.
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
    testWidgets('composer capture $mode', (tester) async {
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      final harness = await buildDeviceChatHarness(
        tester,
        computer: FakeDesktopComputer(
          tabs: [fakeTab('chat-1', 'Chat A', model: 'gpt-5-codex')],
          transcripts: {
            'chat-1': [
              fakeMessage('m-1', 'assistant', [fakeText('Working on it…')]),
            ],
          },
          modelRegistry: _registry,
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
      final draft = find.byKey(const ValueKey('composer-draft'));

      Future<void> capture(String name, [Finder? subject]) async {
        expect(tester.takeException(), isNull);
        await expectLater(
          subject ?? find.byKey(const ValueKey('chat-composer')),
          matchesGoldenFile(
            '../../../../.playwright/mobile-chat-input-glyphs/$name-$stage-$mode.png',
          ),
        );
      }

      expect(find.text('GPT-5 Codex'), findsOneWidget);
      await capture('composer');

      await tester.enterText(
        draft,
        List.generate(7, (index) => 'Draft line ${index + 1}').join('\n'),
      );
      await harness.settle(tester);
      expect(find.textContaining('Draft line 7'), findsOneWidget);
      await capture('seven-lines');
      await tester.enterText(draft, '');
      await harness.settle(tester);

      await toggleComposerPlan(tester);
      await harness.settle(tester);
      await chooseComposerOption(tester, 'effort');
      await harness.settle(tester);
      await chooseComposerOption(tester, 'fast');
      await harness.settle(tester);
      await tester.enterText(
        draft,
        'Review the computer chat input.\nKeep the existing controls.',
      );
      await harness.settle(tester);
      final tab = harness.model.composer.tab;
      expect(tab['planMode'], isTrue);
      await capture('active');

      harness.computer.push({
        'type': 'runtime.patched',
        'chatId': 'chat-1',
        'runtime': fakeRuntime('streaming'),
      });
      await tester.enterText(draft, '');
      await harness.settle(tester);
      expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);
      await capture('stop');

      await tester.tap(find.byKey(const ValueKey('composer-model')));
      await harness.settle(tester);
      expect(find.text('Kimi K3'), findsWidgets);
      await capture('picker', find.byType(MaterialApp));
      await tester.pumpWidget(const SizedBox());
    });
  }
}
