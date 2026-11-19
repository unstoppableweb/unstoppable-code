// Edge-to-edge app bar reference and the Computer connect home app bar on a
// fake connected computer. Bundled fonts, no network.
// From apps/mobile: APP_BAR_STAGE=before (or after) flutter test
// tool/design_system/app_bar_capture_test.dart --update-goldens
// Both appearances are captured on each run; after is the default.
import 'dart:io';
import 'package:mobile/ui/features/developer_options/views/app_bars_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/device_link/computer_connect/controller.dart';
import 'package:mobile/ui/features/device_link/computer_connect/screen.dart';
import '../../test/support/device_chat_harness.dart';
import '../../test/support/fake_desktop_computer.dart';
import '../../test/support/reduced_motion.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  useReducedMotion();
  final stage = Platform.environment['APP_BAR_STAGE'] ?? 'after';
  setUpAll(() async {
    final loader = FontLoader('Inter')
      ..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'));
    await loader.load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  for (final dark in [false, true]) {
    if (stage == 'after') {
      testWidgets('app bar reference ${dark ? 'dark' : 'light'}', (
        tester,
      ) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: const AppBarsScreen(),
          ),
        );
        await tester.pumpAndSettle();
        await expectLater(
          find.byType(AppBarsScreen),
          matchesGoldenFile(
            '../../../../.playwright/mobile-app-bar/preview-after-${dark ? 'dark' : 'light'}.png',
          ),
        );
      });
    }

    testWidgets('computer connect app bar ${dark ? 'dark' : 'light'}', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      addTearDown(tester.view.reset);
      final harness = buildDeviceChatHarness(
        computer: FakeDesktopComputer(answers: fakeInventoryAnswers()),
      );
      final controller = ComputerConnectController(harness.model);
      addTearDown(harness.dispose);
      addTearDown(controller.dispose);
      harness.model.connection.host = {'name': 'Studio Mac'};
      await harness.select(tester, 'chat-pkce');
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: dark ? AppTheme.dark : AppTheme.light,
          home: HomeNavigationScope(
            openDrawer: () {},
            child: ComputerConnectScreen(
              controller: controller,
              apiOrigin: 'https://canopy.invalid',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> capture(Finder subject, String name) async {
        expect(tester.takeException(), isNull);
        await expectLater(
          subject,
          matchesGoldenFile(
            '../../../../.playwright/mobile-app-bar/$name-$stage-${dark ? 'dark' : 'light'}.png',
          ),
        );
      }

      expect(find.text('Studio Mac'), findsOneWidget);
      expect(find.byKey(const ValueKey('home-menu-button')), findsOneWidget);
      await capture(find.byType(ComputerConnectScreen), 'remote');
      await tester.tap(find.byTooltip('Remote options'));
      await tester.pumpAndSettle();
      expect(find.text('Search chats'), findsOneWidget);
      await capture(find.byType(Navigator), 'menu');
      await tester.pumpWidget(const SizedBox());
    });
  }
}
