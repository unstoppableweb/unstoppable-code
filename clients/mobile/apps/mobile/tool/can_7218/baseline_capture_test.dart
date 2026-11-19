// CAN-7218 baseline: the turn footer of a completed Computer connect turn and
// the worktree row's long-press menu.
// CAN_7218_STAGE=before|after flutter test tool/can_7218/baseline_capture_test.dart --update-goldens
// `before` renders without the turn feedback and space notification scopes,
// `after` mounts them through the harness wrapper. Both color modes are
// captured on each run; `after` is the default stage.
//
// Caveat: this file names the feature scopes, so it cannot compile on the
// tree from before they were restored. `before` is the render without the
// providers, which is what the shipped UI shows when they are not mounted,
// not a capture of the older tree.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/space_notification_policy.dart';
import 'package:mobile/data/repositories/space_notifications_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/device_link/worktrees/models.dart';
import 'package:mobile/ui/core/chat/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/device_link/chats_screen.dart';
import 'package:mobile/ui/features/device_link/computer_connect/controller.dart';
import 'package:mobile/ui/features/device_link/computer_connect/worktree_archive_row.dart';
import 'package:mobile/ui/features/device_link/space_notifications/space_notifications_view_model.dart';
import 'package:provider/provider.dart';

import '../../test/support/device_chat_harness.dart';
import '../../test/support/fake_attachment_picker.dart';
import '../../test/support/fake_desktop_computer.dart';
import '../../test/support/reduced_motion.dart';

const _root = ValueKey('can-7218-root');

/// Serves one writable policy; the menu never loads it.
final class _Policies implements SpaceNotificationsRepository {
  static final _policy = SpaceNotificationPolicy(
    spaceId: 'space-wt',
    revision: 1,
    override: SpaceNotificationLevel.attention,
    writesEnabled: true,
  );
  @override
  Future<SpaceNotificationPolicy> load(String spaceId) async => _policy;
  @override
  Future<SpaceNotificationPolicy> save(
    String spaceId, {
    required int expectedRevision,
    required SpaceNotificationLevel? override,
  }) async => _policy;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  useReducedMotion();
  final stage = Platform.environment['CAN_7218_STAGE'] ?? 'after';
  final scoped = stage != 'before';

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

  /// The whole app, overlays included, so menus and sheets are captured.
  Future<void> capture(WidgetTester tester, String name, String mode) async {
    expect(tester.takeException(), isNull);
    await expectLater(
      find.byKey(_root),
      matchesGoldenFile(
        '../../../../.playwright/can-7218/$name-$stage-$mode.png',
      ),
    );
  }

  for (final dark in [false, true]) {
    final mode = dark ? 'dark' : 'light';
    final themeMode = dark ? ThemeMode.dark : ThemeMode.light;

    testWidgets('completed turn footer $mode', (tester) async {
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      final feedback = TurnFeedbackController(
        repository: MockTurnFeedbackRepository(),
      );
      addTearDown(feedback.dispose);
      final harness = buildDeviceChatHarness(
        wrap: (app) => RepaintBoundary(
          key: _root,
          child: scoped
              ? ChangeNotifierProvider<TurnFeedbackController>.value(
                  value: feedback,
                  child: app,
                )
              : app,
        ),
      );
      addTearDown(harness.dispose);
      harness.model.connection.host = {'name': 'Studio Mac'};
      await harness.open(
        tester,
        'chat-pkce',
        mode: themeMode,
        screen: (model) => DeviceChatScreen(
          model: model,
          locationLabel: 'feature/auth',
          attachmentPicker: FakeAttachmentPicker(),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('All 42 auth tests pass'), findsOneWidget);
      expect(
        find.byTooltip('Good response'),
        scoped ? findsOneWidget : findsNothing,
      );
      await capture(tester, 'turn-footer', mode);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('worktree row long-press menu $mode', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final harness = buildDeviceChatHarness();
      final controller = ComputerConnectController(harness.model);
      final notifications = SpaceNotificationsViewModel(
        repository: _Policies(),
      );
      addTearDown(() async {
        notifications.dispose();
        controller.dispose();
        await harness.dispose();
      });
      final app = MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: themeMode,
        home: Scaffold(
          body: SafeArea(
            child: DeviceWorktreeArchiveRow(
              controller: controller,
              worktree: DeviceWorktree(
                projectId: fakeProjectId,
                projectName: 'acme-app',
                id: fakeWorktreeId,
                name: 'feature/auth',
                savedStatus: null,
                projection: const {
                  'branch': 'feature/auth',
                  'label': 'Auth flow',
                  'notificationSpaceId': 'space-wt',
                },
              ),
              onTap: () {},
            ),
          ),
        ),
      );
      await tester.pumpWidget(
        RepaintBoundary(
          key: _root,
          child: scoped
              ? ChangeNotifierProvider<SpaceNotificationsViewModel>.value(
                  value: notifications,
                  child: app,
                )
              : app,
        ),
      );
      await tester.pump();
      await tester.longPress(find.text('Auth flow'));
      await tester.pumpAndSettle();

      expect(find.text('Archive'), findsOneWidget);
      expect(
        find.text('Notifications'),
        scoped ? findsOneWidget : findsNothing,
      );
      await capture(tester, 'worktree-row-menu', mode);
      await tester.pumpWidget(const SizedBox());
    });
  }
}
