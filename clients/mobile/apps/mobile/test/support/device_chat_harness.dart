import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/repository.dart';
import 'package:mobile/device_link/desktop/repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/device_link/chats_screen.dart';
import 'package:mobile/ui/features/device_link/chats_view_model.dart';
import 'package:mobile/ui/features/device_link/desktop_link_model.dart';

import 'fake_desktop_computer.dart';

/// A Computer connect chat on a connected [FakeDesktopComputer]. Everything
/// below the tunneled IPC boundary is real: the repository, the view model
/// and the screen.
final class DeviceChatHarness {
  DeviceChatHarness._(this.computer, this.model, this._wrap);

  final FakeDesktopComputer computer;
  final DeviceChatsViewModel model;
  final Widget Function(Widget app)? _wrap;

  /// Connects, opens [chatId] in the fake worktree and pumps [screen] (a
  /// plain [DeviceChatScreen] by default) on a 390x844 phone view. Fails the
  /// test at teardown if the screen asked for a channel the fake does not
  /// answer.
  Future<void> open(
    WidgetTester tester,
    String chatId, {
    ThemeMode mode = ThemeMode.light,
    Widget Function(DeviceChatsViewModel model)? screen,
  }) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await select(tester, chatId);
    final app = MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: mode,
      home: screen?.call(model) ?? DeviceChatScreen(model: model),
    );
    await tester.pumpWidget(_wrap?.call(app) ?? app);
    await tester.pumpAndSettle();
  }

  /// Connects and opens [chatId] without pumping anything, for a host that
  /// mounts the screen itself. Fails the test at teardown if anything asked
  /// for a channel the fake does not answer.
  Future<void> select(WidgetTester tester, String chatId) async {
    addTearDown(
      () => expect(
        computer.unanswered,
        isEmpty,
        reason: 'channels the fake computer does not answer',
      ),
    );
    await tester.runAsync(() async {
      await model.chats.setConnected(true);
      await model.open(
        DeviceChatRef(
          projectId: fakeProjectId,
          worktreeId: fakeWorktreeId,
          id: chatId,
          title: 'Chat',
        ),
      );
    });
  }

  Future<void> dispose() async {
    model.dispose();
    await computer.dispose();
  }
}

/// [computer] defaults to the fake's default fixtures. [wrap] wraps the whole
/// app, above its navigator, so feature scopes reach sheets and routes too.
DeviceChatHarness buildDeviceChatHarness({
  FakeDesktopComputer? computer,
  Widget Function(Widget app)? wrap,
}) {
  final fake = computer ?? FakeDesktopComputer();
  return DeviceChatHarness._(
    fake,
    DeviceChatsViewModel(
      connection: DesktopLinkModel(
        DesktopLinkRepository(
          store: MemoryDeviceLinkStore(),
          deviceName: 'Test phone',
        ),
      )..phase = DesktopLinkPhase.connected,
      chats: DeviceChatsRepository(fake),
    ),
    wrap,
  );
}
