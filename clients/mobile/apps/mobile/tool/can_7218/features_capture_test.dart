// CAN-7218 restored features on Computer connect: CAN_7218_STAGE=after
// flutter test tool/can_7218/features_capture_test.dart --update-goldens
// Thumbs rated up and down, the thumbs-down sheet, the notification choices
// sheet (writable and read-only) and the satisfaction prompt over a quiet
// chat, all through the fake computer with bundled fonts and no network.
// These surfaces only exist with their feature scopes mounted, so there is
// no `before` stage; see baseline_capture_test.dart for the render without
// them. Both color modes are captured on each run.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/space_notification_policy.dart';
import 'package:mobile/data/models/turn_feedback.dart';
import 'package:mobile/data/repositories/space_notifications_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/satisfaction_prompt_store.dart';
import 'package:mobile/services/analytics/product_analytics.dart';
import 'package:mobile/services/satisfaction/satisfaction_policy.dart';
import 'package:mobile/services/store_review_launcher.dart';
import 'package:mobile/ui/core/chat/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/device_link/chats_screen.dart';
import 'package:mobile/ui/features/device_link/chats_view_model.dart';
import 'package:mobile/ui/features/device_link/computer_connect/worktree_archive_row.dart';
import 'package:mobile/ui/features/device_link/space_notifications/space_notification_menu.dart';
import 'package:mobile/ui/features/device_link/space_notifications/space_notifications_view_model.dart';
import 'package:mobile/ui/features/satisfaction/view_models/satisfaction_prompt_controller.dart';
import 'package:provider/provider.dart';

import '../../test/support/device_chat_harness.dart';
import '../../test/support/fake_attachment_picker.dart';
import '../../test/support/fake_desktop_computer.dart';
import '../../test/support/reduced_motion.dart';

const _root = ValueKey('can-7218-root');

/// Serves one fixed policy.
final class _Policies implements SpaceNotificationsRepository {
  _Policies({required bool writesEnabled})
    : _policy = SpaceNotificationPolicy(
        spaceId: 'space-wt',
        revision: 1,
        override: SpaceNotificationLevel.attention,
        writesEnabled: writesEnabled,
      );
  final SpaceNotificationPolicy _policy;
  @override
  Future<SpaceNotificationPolicy> load(String spaceId) async => _policy;
  @override
  Future<SpaceNotificationPolicy> save(
    String spaceId, {
    required int expectedRevision,
    required SpaceNotificationLevel? override,
  }) async => _policy;
}

final class _Launcher implements StoreReviewLauncher {
  @override
  Future<StoreReviewRequestResult> request() async =>
      StoreReviewRequestResult.requested;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  useReducedMotion();
  final stage = Platform.environment['CAN_7218_STAGE'] ?? 'after';

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

  /// The whole app, overlays included, so sheets are captured.
  Future<void> capture(WidgetTester tester, String name, String mode) async {
    expect(tester.takeException(), isNull);
    await expectLater(
      find.byKey(_root),
      matchesGoldenFile(
        '../../../../.playwright/can-7218/$name-$stage-$mode.png',
      ),
    );
  }

  Widget chatScreen(DeviceChatsViewModel model) => DeviceChatScreen(
    model: model,
    locationLabel: 'feature/auth',
    attachmentPicker: FakeAttachmentPicker(),
  );

  for (final dark in [false, true]) {
    final mode = dark ? 'dark' : 'light';
    final themeMode = dark ? ThemeMode.dark : ThemeMode.light;

    testWidgets('turn feedback thumbs and sheet $mode', (tester) async {
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      final feedback = TurnFeedbackController(
        repository: MockTurnFeedbackRepository(),
      );
      addTearDown(feedback.dispose);
      final harness = await buildDeviceChatHarness(
        tester,
        wrap: (app) => RepaintBoundary(
          key: _root,
          child: ChangeNotifierProvider<TurnFeedbackController>.value(
            value: feedback,
            child: app,
          ),
        ),
      );
      addTearDown(harness.dispose);

      await harness.open(
        tester,
        'chat-pkce',
        mode: themeMode,
        screen: chatScreen,
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Good response'));
      await tester.pumpAndSettle();
      expect(
        feedback.entryFor('chat-pkce', 'seed-1')?.rating,
        TurnFeedbackRating.up,
      );
      await capture(tester, 'thumbs-up', mode);

      await tester.tap(find.byTooltip('Bad response'));
      await tester.pumpAndSettle();
      expect(find.text('What went wrong?'), findsOneWidget);
      await capture(tester, 'thumbs-down-sheet', mode);

      await tester.tap(find.text('Skip'));
      await tester.pumpAndSettle();
      expect(find.text('What went wrong?'), findsNothing);
      expect(
        feedback.entryFor('chat-pkce', 'seed-1')?.rating,
        TurnFeedbackRating.down,
      );
      await capture(tester, 'thumbs-down', mode);
      await tester.pumpWidget(const SizedBox());
    });

    for (final writable in [true, false]) {
      final name = writable
          ? 'notifications-sheet-writable'
          : 'notifications-sheet-read-only';
      testWidgets('$name $mode', (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        final harness = await buildDeviceChatHarness(
          tester,
          computer: FakeDesktopComputer(
            answers: fakeInventoryAnswers(
              label: 'Auth flow',
              notificationSpaceId: 'space-wt',
            ),
          ),
        );
        await tester.runAsync(harness.controller.refresh);
        final controller = harness.controller;
        final notifications = SpaceNotificationsViewModel(
          repository: _Policies(writesEnabled: writable),
        );
        addTearDown(() async {
          notifications.dispose();

          await harness.dispose();
        });
        await tester.pumpWidget(
          RepaintBoundary(
            key: _root,
            child: ChangeNotifierProvider<SpaceNotificationsViewModel>.value(
              value: notifications,
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: AppTheme.light,
                darkTheme: AppTheme.dark,
                themeMode: themeMode,
                home: Scaffold(
                  body: SafeArea(
                    child: DeviceWorktreeArchiveRow(
                      controller: controller,
                      worktree: controller.overview.worktrees.single,
                      onTap: () {},
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pump();
        await tester.longPress(find.text('Auth flow'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Notifications'));
        await tester.pumpAndSettle();

        expect(
          find.byKey(const ValueKey('space-notify-sheet-space-wt')),
          findsOneWidget,
        );
        expect(find.text('Needs my attention'), findsOneWidget);
        expect(
          find.text(SpaceNotificationCopy.writesClosed),
          writable ? findsNothing : findsOneWidget,
        );
        await capture(tester, name, mode);
        await tester.pumpWidget(const SizedBox());
      });
    }

    testWidgets('satisfaction prompt over a quiet chat $mode', (tester) async {
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      final prompt = SatisfactionPromptController(
        store: InMemorySatisfactionPromptStore(),
        analytics: NoopProductAnalytics(),
        reviewLauncher: _Launcher(),
        isActive: () => true,
        thresholds: () => SatisfactionThresholds.verification,
      );
      addTearDown(prompt.dispose);
      final harness = await buildDeviceChatHarness(
        tester,
        wrap: (app) => RepaintBoundary(
          key: _root,
          child: ChangeNotifierProvider<SatisfactionPromptController>.value(
            value: prompt,
            child: app,
          ),
        ),
      );
      addTearDown(harness.dispose);

      await harness.open(
        tester,
        'chat-pkce',
        mode: themeMode,
        screen: chatScreen,
      );
      await _completeTurn(tester, harness);
      await harness.settle(tester);
      await tester.pumpAndSettle();

      expect(find.text('Rotation is wired up.'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('satisfaction-prompt-sheet')),
        findsOneWidget,
      );
      await capture(tester, 'satisfaction-prompt', mode);
      await tester.pumpWidget(const SizedBox());
    });
  }
}

/// Runs one successful turn on `chat-pkce` the way the desktop reports it:
/// the prompt and reply, a completed turn timer, the runtime going idle, then
/// the turn's `completed` end record.
Future<void> _completeTurn(
  WidgetTester tester,
  DeviceChatHarness harness,
) async {
  final computer = harness.computer;
  Map<String, dynamic> timer({bool done = false}) => {
    'type': 'turn_timer',
    'turnId': 't-u1',
    'userMessageId': 'u1',
    'startedAt': 1000,
    if (done) 'completedAt': 9000,
  };
  void upsert(Map<String, dynamic> message) => computer.push({
    'type': 'message.upserted',
    'chatId': 'chat-pkce',
    'message': message,
  });
  void runtime(String status) => computer.push({
    'type': 'runtime.patched',
    'chatId': 'chat-pkce',
    'runtime': fakeRuntime(status),
  });

  upsert(fakeMessage('u1', 'user', [fakeText('Rotate the refresh token too')]));
  runtime('streaming');
  upsert(fakeMessage('r1', 'assistant', [timer(), fakeText('Working')]));
  await harness.settle(tester);
  upsert(
    fakeMessage('r1', 'assistant', [
      timer(done: true),
      fakeText('Rotation is wired up.'),
    ]),
  );
  runtime('idle');
  await harness.settle(tester);
  computer.push({
    'type': 'tab.metadata_patched',
    'tabId': 'chat-pkce',
    'patch': {
      'turnEnds': {
        'u1': {'outcome': 'completed', 'endedAt': 9000},
      },
    },
  });
  await harness.settle(tester);
  // The controller can schedule the quiet delay from a Rust frame on the
  // real clock, while Flutter's route animations still use the test clock.
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 1600)),
  );
  await tester.pump(const Duration(seconds: 2));
}
