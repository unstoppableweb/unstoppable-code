// Worktree file diff viewer on a Computer connect chat: deterministic
// light/dark evidence for the Activity drawer's Files tab, a row tap, and
// DeviceFileDiffScreen.
//
// FILE_DIFF_STAGE=after flutter test tool/file_diff/capture_test.dart
// --update-goldens, from apps/mobile. Writes to .playwright/mobile-file-diff/
// at the repo root.
//
// Deterministic: the fake computer serves a fixed changed-file roster and a
// fixed before/after file, bundled fonts, no network or live agents.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/activity/worktree_activity_context.dart';
import 'package:mobile/ui/features/device_link/chats_screen.dart';
import 'package:mobile/ui/features/device_link/computer_connect/file_diff_screen.dart';

import '../../test/support/device_chat_harness.dart';
import '../../test/support/fake_attachment_picker.dart';
import '../../test/support/fake_desktop_computer.dart';
import '../../test/support/reduced_motion.dart';

const _diffPath = 'apps/mobile/lib/device_link/files/repository.dart';

const _oldFile = '''
final class DeviceFileRepository {
  DeviceFileRepository(this.ipc);

  final DesktopIpc ipc;

  Future<String> read(String path) async {
    final raw = await ipc.invoke('file:read-content', [path]);
    return raw as String;
  }
}
''';

const _newFile = '''
final class DeviceFileRepository {
  DeviceFileRepository(this.ipc);

  final DesktopIpc ipc;

  Future<String> read(String path) async {
    final raw = await ipc.invoke('file:read-content', [path]);
    return raw as String;
  }

  /// Reads one changed file's before and after text from the computer.
  Future<Map<String, dynamic>> diff(String path, {required bool committed}) async {
    final raw = await ipc.invoke('activity:file-diff', [
      {'filePath': path, 'source': committed ? 'committed' : 'uncommitted'},
    ]);
    return raw as Map<String, dynamic>;
  }
}
''';

Map<String, Object?> _row(
  String path,
  String status, {
  int? insertions,
  int? deletions,
}) => {
  'path': path,
  'status': status,
  'insertions': ?insertions,
  'deletions': ?deletions,
};

final _changedFiles = {
  'uncommitted': [
    _row(
      'apps/mobile/lib/ui/features/device_link/computer_connect/file_diff_screen.dart',
      'untracked',
      insertions: 310,
    ),
    _row(
      'apps/mobile/lib/ui/core/activity/activity_sidebar.dart',
      'modified',
      insertions: 39,
      deletions: 6,
    ),
    _row(
      'apps/mobile/lib/ui/core/files/unified_diff_lines.dart',
      'untracked',
      insertions: 88,
    ),
    _row('docs/parity/registry.yaml', 'modified', insertions: 10),
    _row('docs/parity/FEATURE-PARITY.md', 'modified', insertions: 1),
    _row('README.md', 'deleted', deletions: 12),
  ],
  'committed': [
    _row(_diffPath, 'modified', insertions: 12, deletions: 1),
    _row(
      'apps/mobile/lib/device_link/activity/repository.dart',
      'modified',
      insertions: 26,
    ),
    _row(
      'apps/mobile/lib/data/models/remote_file_diff.dart',
      'added',
      insertions: 74,
    ),
  ],
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  useReducedMotion();
  final stage = Platform.environment['FILE_DIFF_STAGE'] ?? 'after';

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
    testWidgets('file diff $mode', (tester) async {
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      final harness = await buildDeviceChatHarness(
        tester,
        computer: FakeDesktopComputer(
          tabs: [fakeTab('chat-1', 'Diff viewer')],
          transcripts: {'chat-1': const []},
          answers: {
            'activity:changed-files': (_) => _changedFiles,
            ...fakeInventoryAnswers(branch: 'gvoltr/mobile-file-diff'),
            'worktree:get-path': (_) => '/Users/sam/acme-app',
            'github:request-fast-refresh': (_) => null,
            // Nothing else to show in the Activity tab.
            'worktree-summary:load': (_) => null,
            'tracked-plans:list': (_) => null,
            'script:load-worktree-runs': (_) => null,
            'hook:load-worktree-runs': (_) => null,
            for (final channel in [
              'pipelines:list',
              'pipelines:list-executions',
              'pipelines:discover-project',
            ])
              channel: (_) => {'success': true, 'data': <Object?>[]},
            'activity:file-diff': (_) => {
              'oldValue': _oldFile,
              'newValue': _newFile,
            },
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
          // The Activity drawer opens only for a chat in a worktree.
          worktree: const WorktreeActivityContext(
            workspaceLocalId: fakeProjectId,
            localId: fakeWorktreeId,
          ),
        ),
      );

      Future<void> capture(String name) async {
        expect(tester.takeException(), isNull);
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile(
            '../../../../.playwright/mobile-file-diff/$name-$stage-$mode.png',
          ),
        );
      }

      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await harness.settle(tester);
      await tester.tap(find.text('Files'));
      await harness.settle(tester);
      expect(
        find.byKey(
          const ValueKey(
            'changed-file::apps/mobile/lib/ui/core/activity/activity_sidebar.dart',
          ),
        ),
        findsOneWidget,
      );
      await capture('files-tab');

      // The committed rows start below the fold.
      final row = find.byKey(const ValueKey('changed-file::$_diffPath'));
      await tester.scrollUntilVisible(
        row,
        200,
        scrollable: find
            .descendant(
              of: find.byKey(const ValueKey('changed-files-list')),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await Scrollable.ensureVisible(tester.element(row), alignment: 0.5);
      await harness.settle(tester);

      await tester.tap(row);
      await harness.settle(tester);
      expect(find.byType(DeviceFileDiffScreen), findsOneWidget);
      expect(find.textContaining('Reads one changed file'), findsOneWidget);
      await capture('diff-screen');
      await tester.pumpWidget(const SizedBox());
    });
  }
}
