import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/device_link/computer_connect/controller.dart';
import 'package:mobile/ui/features/device_link/computer_connect/rust/rust_account.dart';
import 'package:mobile/ui/features/device_link/chats_screen.dart';
import 'package:mobile/ui/features/device_link/chats_view_model.dart';

import 'fake_attachment_picker.dart';
import 'fake_desktop_computer.dart';
import 'rust_test_computer.dart';

/// A Computer Connect chat over the production Rust account and chat services.
final class DeviceChatHarness {
  DeviceChatHarness._(this.computer, this._rust, this._wrap);

  final FakeDesktopComputer computer;
  DeviceChatsViewModel get model => controller.chats;
  RustComputerAccount get account => _rust.account;
  ComputerConnectController get controller => account.sessions.selected!;
  final Widget Function(Widget app)? _wrap;
  final RustTestComputer _rust;

  /// Connects, opens [chatId] in the fake worktree and pumps [screen] (a
  /// [DeviceChatScreen] with a [FakeAttachmentPicker] by default, so no
  /// platform picker answers while the test waits in real time) on a
  /// 390x844 phone view. Fails the
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
      home:
          screen?.call(model) ??
          DeviceChatScreen(
            model: model,
            attachmentPicker: FakeAttachmentPicker(),
          ),
    );
    await tester.pumpWidget(_wrap?.call(app) ?? app);
    await settle(tester);
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

  /// Pumps until the screen is still. On [ChatRuntime.rust] the core answers
  /// in real time while the screen runs on the test's fake clock, so this
  /// alternates real waits and frames until three rounds in a row in which
  /// the fake had no request open, the view model did not change and no
  /// frame was left to draw, then settles.
  Future<void> settle(WidgetTester tester) async {
    var changes = 0;
    void changed() => changes++;
    model.addListener(changed);
    try {
      final deadline = DateTime.now().add(const Duration(seconds: 5));
      var quiet = 0;
      while (quiet < 3 && DateTime.now().isBefore(deadline)) {
        final before = changes;
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 20)),
        );
        await tester.pump(const Duration(milliseconds: 100));
        final still =
            changes == before &&
            _rust.inFlight == 0 &&
            !tester.binding.hasScheduledFrame;
        quiet = still ? quiet + 1 : 0;
      }
    } finally {
      model.removeListener(changed);
    }
    await tester.pumpAndSettle();
  }

  Future<void> dispose() async {
    await _rust.dispose();
    await computer.dispose();
  }
}

Future<DeviceChatHarness> buildChatHarness({
  FakeDesktopComputer? computer,
  Widget Function(Widget app)? wrap,
}) async {
  final fake = computer ?? FakeDesktopComputer();
  final rust = await RustTestComputer.connect(fake);
  return DeviceChatHarness._(fake, rust, wrap);
}

Future<DeviceChatHarness> buildDeviceChatHarness(
  WidgetTester tester, {
  FakeDesktopComputer? computer,
  Widget Function(Widget app)? wrap,
}) async => (await tester.runAsync(
  () => buildChatHarness(computer: computer, wrap: wrap),
))!;
