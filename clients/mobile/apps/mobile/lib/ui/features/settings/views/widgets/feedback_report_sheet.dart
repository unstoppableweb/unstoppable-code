import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/data/models/feedback_report.dart';
import 'package:mobile/data/repositories/feedback_report_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/services/app_build_info.dart';

/// Shown when a submit fails with no server-authored 4xx reason.
/// [presentableErrorMessage] returns null for every 5xx by design (see its
/// doc comment), so a submit failure needs its own retryable copy rather than
/// a blank error.
const String _genericSubmitErrorMessage =
    'Could not send your feedback. Please try again.';

/// Matches the desktop feedback modal's copy exactly
/// (`FeedbackModal.tsx`'s `REPORT_TYPE_OPTIONS`).
String _reportTypeLabel(FeedbackReportType type) => switch (type) {
  FeedbackReportType.bug => 'Bug',
  FeedbackReportType.idea => 'Idea',
};

String _reportTypeHelper(FeedbackReportType type) => switch (type) {
  FeedbackReportType.bug => 'Something is broken or not working as expected.',
  FeedbackReportType.idea =>
    'A suggestion, feature request, or general feedback.',
};

/// How the feedback sheet closed, for callers that need to react to it
/// (the satisfaction prompt snoozes on [dismissed]).
enum FeedbackSheetOutcome { submitted, dismissed }

/// Opens the app-wide "Report a bug / Share an idea" sheet.
///
/// Reads [FeedbackReportRepository] from `context` before the first `await`,
/// per this codebase's async-context-safety convention. That repository must
/// be registered in `buildRootProviders()` (see `main.dart`), NOT
/// `buildSharedShellProviders()`: `SettingsScreen` is reached by
/// `Navigator.push` on the ROOT navigator, above anything the shell-scoped
/// providers supply, so a shell-scoped registration throws
/// `ProviderNotFoundException` the moment this sheet opens from Settings even
/// though the identical call from Account (a shell tab) would look fine.
///
/// On a successful submit the sheet pops with the [FeedbackReportResult] and
/// this function shows a confirmation [SnackBar] naming the returned issue
/// identifier. On cancel/dismiss the sheet pops with `null` and nothing
/// further happens. A failed or malformed submit never pops — see
/// [_FeedbackReportSheetBodyState._submit].
///
/// [source] is added to the submitted context (for example `satisfaction_prompt`)
/// so triage can tell where the report came from.
Future<FeedbackSheetOutcome> showFeedbackReportSheet(
  BuildContext context, {
  String? source,
}) async {
  final repository = context.read<FeedbackReportRepository>();

  final result = await showModalBottomSheet<FeedbackReportResult>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (sheetContext) => Padding(
      // Keeps Submit above the keyboard once the description field is
      // focused.
      padding: EdgeInsets.only(
        bottom: MediaQuery.viewInsetsOf(sheetContext).bottom,
      ),
      child: _FeedbackReportSheetBody(repository: repository, source: source),
    ),
  );

  if (result == null) return FeedbackSheetOutcome.dismissed;
  if (context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Thanks! Filed as ${result.issueIdentifier}.')),
    );
  }
  // Return submitted: the report was successfully filed, regardless of whether
  // the caller's context is now unmounted.
  return FeedbackSheetOutcome.submitted;
}

class _FeedbackReportSheetBody extends StatefulWidget {
  const _FeedbackReportSheetBody({required this.repository, this.source});

  final FeedbackReportRepository repository;
  final String? source;

  @override
  State<_FeedbackReportSheetBody> createState() =>
      _FeedbackReportSheetBodyState();
}

class _FeedbackReportSheetBodyState extends State<_FeedbackReportSheetBody> {
  FeedbackReportType _type = FeedbackReportType.bug;
  final TextEditingController _descriptionController = TextEditingController();
  bool _submitting = false;
  String? _error;

  /// Loaded in the background rather than awaited before the sheet opens:
  /// platform build metadata is a nice-to-have on the report, not something
  /// worth making the user wait on (or, if the platform call never resolves,
  /// blocking the sheet from opening at all). A submit before this finishes
  /// just goes out with an empty context map.
  AppBuildInfo? _buildInfo;

  @override
  void initState() {
    super.initState();
    // Submit's enabled state depends on the description text.
    _descriptionController.addListener(_onDescriptionChanged);
    unawaited(_loadBuildInfo());
  }

  Future<void> _loadBuildInfo() async {
    try {
      final info = await AppBuildInfo.load();
      if (!mounted) return;
      setState(() => _buildInfo = info);
    } catch (_) {
      // Best-effort context for the report; not worth surfacing an error
      // over. The context line simply stays blank.
    }
  }

  @override
  void dispose() {
    _descriptionController.removeListener(_onDescriptionChanged);
    _descriptionController.dispose();
    super.dispose();
  }

  void _onDescriptionChanged() => setState(() {});

  Future<void> _submit() async {
    final description = _descriptionController.text.trim();
    if (description.isEmpty || _submitting) return;

    setState(() {
      _submitting = true;
      _error = null;
    });

    try {
      final result = await widget.repository.submit(
        type: _type,
        description: description,
        context: <String, dynamic>{
          ...?_buildInfo?.toContext(),
          'source': ?widget.source,
        },
      );
      if (!mounted) return;
      // `FeedbackReportResult.fromJson` defensively defaults a missing
      // `issueIdentifier` to '' instead of throwing — never present that as
      // a named success. Treat it like a failure so the typed text and an
      // actionable retry stay in front of the user.
      if (result.issueIdentifier.trim().isEmpty) {
        setState(() {
          _submitting = false;
          _error = _genericSubmitErrorMessage;
        });
        return;
      }
      Navigator.of(context).pop(result);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = presentableErrorMessage(error) ?? _genericSubmitErrorMessage;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final canSubmit =
        !_submitting && _descriptionController.text.trim().isNotEmpty;
    final error = _error;
    final buildInfo = _buildInfo;
    final contextLine = buildInfo
        ?.toContext()
        .entries
        .map((entry) => '${entry.key}: ${entry.value}')
        .join(' · ');

    return SingleChildScrollView(
      key: const ValueKey('feedback-report-sheet'),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Feedback', style: theme.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
              'Report a bug or share an idea.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 16),
            SegmentedButton<FeedbackReportType>(
              segments: [
                for (final type in FeedbackReportType.values)
                  ButtonSegment(
                    value: type,
                    label: Text(_reportTypeLabel(type)),
                  ),
              ],
              selected: {_type},
              onSelectionChanged: _submitting
                  ? null
                  : (selection) => setState(() => _type = selection.first),
            ),
            const SizedBox(height: 4),
            Text(
              _reportTypeHelper(_type),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 16),
            TextField(
              key: const ValueKey('feedback-report-description'),
              controller: _descriptionController,
              enabled: !_submitting,
              autofocus: true,
              maxLines: 5,
              maxLength: maxFeedbackDescriptionLength,
              decoration: const InputDecoration(
                hintText: 'What happened, or what would help?',
                border: OutlineInputBorder(),
              ),
            ),
            if (contextLine != null) ...[
              const SizedBox(height: 4),
              Text(
                contextLine,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
            if (error != null) ...[
              const SizedBox(height: 12),
              Text(
                error,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
            ],
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: _submitting
                      ? null
                      : () => Navigator.of(context).pop(),
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  key: const ValueKey('feedback-report-submit'),
                  onPressed: canSubmit ? () => unawaited(_submit()) : null,
                  child: _submitting
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Submit'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Entry-point row for [showFeedbackReportSheet], in Settings' Help section.
class SendFeedbackTile extends StatelessWidget {
  const SendFeedbackTile({super.key});

  @override
  Widget build(BuildContext context) {
    return CanopySettingsRow(
      key: const ValueKey('send-feedback-tile'),
      glyph: CanopyGlyph.bubbleText,
      title: 'Send feedback',
      trailing: const CanopySettingsChevron(),
      onTap: () => unawaited(showFeedbackReportSheet(context)),
    );
  }
}
