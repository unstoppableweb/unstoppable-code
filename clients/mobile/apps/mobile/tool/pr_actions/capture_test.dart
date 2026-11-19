// Mobile PR actions: deterministic Activity drawer evidence, no network.
// Run PR_ACTIONS_STAGE=after flutter test tool/pr_actions/capture_test.dart
// --update-goldens from apps/mobile. Both color modes are captured together.
//
// Pumps the shared WorktreeActivitySidebar that Computer connect's Activity
// drawer renders, with a scripted PR action runner in place of the computer.
// `unsupported` is the drawer with no runner, as when the computer is offline.
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/computer_activity/activity.dart';
import 'package:mobile/data/models/computer_activity/pr.dart';
import 'package:mobile/data/models/computer_activity/pr_status.dart';
import 'package:mobile/ui/core/activity/activity_sidebar.dart';
import 'package:mobile/ui/core/activity/worktree_activity_context.dart';
import 'package:mobile/ui/core/theme.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final stage = Platform.environment['PR_ACTIONS_STAGE'] == 'before'
      ? 'before'
      : 'after';
  setUpAll(() async {
    await (FontLoader(
      'Inter',
    )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  for (final dark in [false, true]) {
    for (final scenario in [
      'none',
      'open',
      'merged',
      'closed',
      'draft',
      'confirmation',
      'blocked-create',
      'blocked-merge',
      'unsupported',
    ]) {
      testWidgets('$scenario ${dark ? 'dark' : 'light'}', (tester) async {
        final state = switch (scenario) {
          'blocked-create' || 'unsupported' => 'none',
          'blocked-merge' || 'confirmation' => 'open',
          _ => scenario,
        };
        final canCreate = state == 'none' && scenario != 'blocked-create';
        final canMerge = state == 'open' && scenario != 'blocked-merge';
        final createBlockedReason = switch (scenario) {
          'blocked-create' => 'no_changes',
          _ => state == 'none' ? null : 'pr_open',
        };
        final mergeBlockedReason = switch (scenario) {
          'blocked-merge' => 'checks_failing',
          'draft' => 'draft',
          _ => state == 'open' ? null : 'no_pr',
        };
        final RemotePrActionRunner? runner = scenario == 'unsupported'
            ? null
            : (
                action, {
                repoId,
                identity,
                confirmUnresolvedComments = false,
              }) async {
                if (scenario == 'confirmation' &&
                    action == RemotePrAction.merge &&
                    !confirmUnresolvedComments) {
                  return {
                    'requiresUnresolvedConfirmation': [
                      {'repoId': repoId},
                    ],
                  };
                }
                return {
                  'busy': false,
                  'repos': [
                    {
                      'repoId': 'app',
                      'repoName': 'App',
                      'baseBranch': 'develop',
                      'headBranch': 'feature/mobile-pr',
                      'canCreate': canCreate,
                      'canMerge': canMerge,
                      'mergeWarning': scenario == 'confirmation',
                      'createBlockedReason': createBlockedReason,
                      'mergeBlockedReason': mergeBlockedReason,
                      'status': state == 'none'
                          ? null
                          : {
                              'number': 42,
                              'state': state,
                              'title': 'Add mobile PR actions',
                              'url': 'https://github.com/acme/repo/pull/42',
                              'checkStatus': scenario == 'blocked-merge'
                                  ? 'failing'
                                  : 'passing',
                              'reviewStatus': 'approved',
                              'unresolvedReviewThreadCount':
                                  scenario == 'confirmation' ? 2 : 0,
                            },
                    },
                  ],
                };
              };
        final cached = runner == null
            ? null
            : await runner(RemotePrAction.refresh);
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: dark ? AppTheme.dark : AppTheme.light,
            home: Scaffold(
              body: RepaintBoundary(
                key: const ValueKey('capture'),
                child: WorktreeActivitySidebar(
                  worktree: WorktreeActivityContext(
                    localId: 'task',
                    workspaceLocalId: 'workspace',
                    prStatuses: [
                      if (state != 'none')
                        RemoteWorktreePr(
                          prNumber: 42,
                          state: state,
                          title: 'Add mobile PR actions',
                          checkStatus: scenario == 'blocked-merge'
                              ? 'failing'
                              : 'passing',
                          reviewStatus: 'approved',
                          unresolvedReviewThreadCount:
                              scenario == 'confirmation' ? 2 : 0,
                        ),
                    ],
                  ),
                  activity: const RemoteWorktreeActivity(),
                  onOpenDiff: (_) {},
                  runPrAction: runner,
                  cachedPrRepos: cached == null
                      ? null
                      : (cached['repos'] as List? ?? const [])
                            .whereType<Map<String, dynamic>>()
                            .map(RemotePrRepo.fromJson)
                            .toList(),
                  cachedPrBusy: cached?['busy'] == true,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        if (canCreate && scenario != 'unsupported') {
          expect(find.byKey(const ValueKey('create-pr-app')), findsOneWidget);
        }
        if (canMerge) {
          expect(find.byKey(const ValueKey('merge-pr-app')), findsOneWidget);
        }
        if (scenario == 'confirmation') {
          await tester.tap(find.byKey(const ValueKey('merge-pr-app')));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 300));
          expect(find.text('Merge with unresolved comments?'), findsOneWidget);
        }
        if (scenario == 'unsupported') {
          expect(find.byKey(const ValueKey('create-pr-app')), findsNothing);
        }
        expect(find.text('Activity'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await expectLater(
          scenario == 'confirmation'
              ? find.byType(Overlay).first
              : find.byKey(const ValueKey('capture')),
          matchesGoldenFile(
            '../../../../.playwright/mobile-pr-actions/$scenario-$stage-${dark ? 'dark' : 'light'}.png',
          ),
        );
      });
    }
  }
}
