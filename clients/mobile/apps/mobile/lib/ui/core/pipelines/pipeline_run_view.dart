import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/computer_activity/pipeline_content.dart';
import 'package:mobile/data/models/computer_activity/pipeline_run.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/activity/pipeline_run_display.dart';
import 'pipeline_content_view.dart';
import 'pipeline_run_status_chip.dart';

class PipelineRunBody extends StatelessWidget {
  const PipelineRunBody({
    super.key,
    required this.padding,
    required this.run,
    required this.pending,
    required this.error,
    required this.selectedJobId,
    required this.selectedStepId,
    required this.onSelectStep,
    required this.onLoadLog,
    required this.stepOutput,
    required this.onOpenReport,
    required this.onRetry,
    required this.actionError,
    required this.onDismissActionError,
    required this.chatFollowUp,
  });

  final EdgeInsets padding;
  final RemotePipelineRun run;
  final bool pending;
  final String? error;
  final String? selectedJobId;
  final String? selectedStepId;
  final void Function(String jobId, String stepId) onSelectStep;
  final void Function(String jobId, String stepId) onLoadLog;

  /// A step's complete readable output; null when the desktop can't serve it.
  final PipelineStepOutputFor? stepOutput;
  final VoidCallback onOpenReport;
  final VoidCallback onRetry;

  /// Why the desktop rejected the last run control, until dismissed.
  final String? actionError;
  final VoidCallback onDismissActionError;

  /// The Chat follow-up action, placed under the run summary.
  final Widget chatFollowUp;

  bool _hasSelectionIn(List<PipelineRunGroup> groups) => groups.any(
    (group) => group.steps.any(
      (entry) =>
          entry.jobId == selectedJobId && entry.step.stepId == selectedStepId,
    ),
  );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final groups = buildPipelineRunGroups(run.jobs ?? const []);
    return ListView(
      padding: padding.add(const EdgeInsets.symmetric(horizontal: 12)),
      children: [
        _Header(run: run),
        const SizedBox(height: 8),
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: CanopyButton(
            key: const ValueKey('pipeline-run-full-report'),
            label: 'Full report',
            glyph: CanopyGlyph.fileText,
            variant: CanopyButtonVariant.inline,
            onPressed: onOpenReport,
          ),
        ),
        chatFollowUp,
        if (actionError != null) ...[
          const SizedBox(height: 12),
          _ActionError(message: actionError!, onDismiss: onDismissActionError),
        ],
        if (error != null) ...[
          const SizedBox(height: 12),
          _InlineError(message: error!, onRetry: onRetry),
        ],
        if (run.statusReasons.isNotEmpty || run.pendingPauses.isNotEmpty) ...[
          const SizedBox(height: 12),
          _AttentionBlock(
            key: const ValueKey('pipeline-run-attention'),
            run: run,
          ),
        ],
        const SizedBox(height: 12),
        if (!run.hasDetail)
          _UnavailableDetail(
            key: const ValueKey('pipeline-run-unavailable'),
            pending: pending,
            outputTail: run.outputTail,
          )
        else if (groups.isEmpty)
          Text(
            'This run has no steps yet.',
            key: const ValueKey('pipeline-run-empty'),
            style: Theme.of(context).textTheme.bodySmall,
          )
        else ...[
          for (final group in groups)
            _GroupTile(
              key: ValueKey('pipeline-run-group:${group.jobId}'),
              group: group,
              selectedJobId: selectedJobId,
              selectedStepId: selectedStepId,
              pending: pending,
              onSelectStep: onSelectStep,
              onLoadLog: onLoadLog,
              stepOutput: stepOutput,
            ),
          // The log opens under the step it belongs to; until one is open,
          // say that the steps can be tapped.
          if (!_hasSelectionIn(groups)) ...[
            const SizedBox(height: 12),
            Text(
              'Select a step to see its output.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ],
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.run});

  final RemotePipelineRun run;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = StatusColors.of(context);
    final progress = run.progress;
    final started = DateTime.tryParse(run.startedAt ?? '');
    final finished = DateTime.tryParse(run.finishedAt ?? '');
    // A running pipeline has no finish time yet, and this screen never
    // re-renders on a ticking timer (no Timer.periodic — deliberate, see the
    // class doc), so an elapsed duration computed against the wall clock
    // would be non-deterministic and effectively frozen the instant it was
    // read. A finished run shows its (deterministic) elapsed duration; a
    // still-running run with a known start shows a relative "started Nm ago"
    // read instead — a bare time-of-day (e.g. "12:00 PM") is ambiguous for a
    // run that started days ago, so this uses the same
    // formatRelativeTime/formatRelativeDate helpers the feed/members/account
    // screens already use, not `DateTime.now()` directly in a duration.
    final String? timeText;
    if (finished != null) {
      final duration = formatPipelineRunDuration(started, finished);
      timeText = duration.isEmpty ? null : duration;
    } else if (started != null) {
      timeText = formatRelativeDate(started);
    } else {
      timeText = null;
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(
              pipelineTriggerIcon(run.triggerSource),
              size: 16,
              color: theme.colorScheme.onSurfaceVariant,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                run.pipelineName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.titleMedium,
              ),
            ),
            const SizedBox(width: 8),
            PipelineRunStatusChip(
              key: const ValueKey('pipeline-run-status'),
              status: run.status,
            ),
          ],
        ),
        const SizedBox(height: 6),
        Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            // Older hosts and projections may omit the trigger. Show time
            // without claiming a manual start when the trigger is unknown.
            if (run.triggerSource != null) ...[
              Text(
                pipelineTriggerLabel(run.triggerSource),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              if (timeText != null)
                Text(
                  ' · ',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
            ],
            if (timeText != null)
              Text(
                timeText,
                key: const ValueKey('pipeline-run-time'),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
          ],
        ),
        if (progress != null && progress.totalSteps > 0) ...[
          const SizedBox(height: 8),
          Row(
            key: const ValueKey('pipeline-run-progress'),
            children: [
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(3),
                  child: LinearProgressIndicator(
                    value: progress.completedSteps / progress.totalSteps,
                    minHeight: 4,
                    color: pipelineRunStatusColor(run.status, colors),
                    backgroundColor: theme.colorScheme.surfaceContainerHighest,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '${progress.completedSteps}/${progress.totalSteps} steps',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ],
      ],
    );
  }
}

/// The app bar's options: the run controls this run can take, then Refresh.
///
/// One control runs at a time. While the desktop works on one, every control
/// is disabled and the sent one reads as in progress, so a second tap cannot
/// queue a contradicting command behind it.
class PipelineRunOptionsMenu extends StatelessWidget {
  const PipelineRunOptionsMenu({
    super.key,
    required this.run,
    required this.pendingAction,
    required this.onAction,
    required this.onRefresh,
    this.enabled = true,
  });

  final RemotePipelineRun? run;
  final RemotePipelineRunAction? pendingAction;
  final void Function(RemotePipelineRunAction action) onAction;
  final VoidCallback onRefresh;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final secondary = AppColors.of(context).foregroundSecondary;
    final run = this.run;
    final actions = <RemotePipelineRunAction>[
      if (run != null && canCancelPipelineRun(run))
        RemotePipelineRunAction.cancel,
      if (run != null && canResumePipelineRun(run))
        RemotePipelineRunAction.resume,
      if (run != null && canRetryPipelineRun(run))
        RemotePipelineRunAction.retry,
    ];
    return MenuAnchor(
      builder: (context, controller, child) => CanopyIconButton(
        key: const ValueKey('pipeline-run-options'),
        glyph: CanopyGlyph.dotGrid1x3Horizontal,
        tooltip: 'Run options',
        onPressed: () =>
            controller.isOpen ? controller.close() : controller.open(),
      ),
      menuChildren: [
        for (final action in actions)
          MenuItemButton(
            key: ValueKey('pipeline-run-action:${action.name}'),
            leadingIcon: CanopyIcon(glyph: _glyph(action), tint: secondary),
            onPressed: enabled && pendingAction == null
                ? () => onAction(action)
                : null,
            child: Text(
              pendingAction == action ? _progressLabel(action) : _label(action),
            ),
          ),
        MenuItemButton(
          key: const ValueKey('pipeline-run-action:refresh'),
          leadingIcon: CanopyIcon(
            glyph: CanopyGlyph.arrowRotateClockwise,
            tint: secondary,
          ),
          onPressed: onRefresh,
          child: const Text('Refresh'),
        ),
      ],
    );
  }

  static CanopyGlyph _glyph(RemotePipelineRunAction action) => switch (action) {
    RemotePipelineRunAction.cancel => CanopyGlyph.crossMedium,
    RemotePipelineRunAction.resume => CanopyGlyph.play,
    RemotePipelineRunAction.retry => CanopyGlyph.replay,
  };

  static String _label(RemotePipelineRunAction action) => switch (action) {
    RemotePipelineRunAction.cancel => 'Cancel',
    RemotePipelineRunAction.resume => 'Resume',
    RemotePipelineRunAction.retry => 'Retry',
  };

  static String _progressLabel(RemotePipelineRunAction action) =>
      switch (action) {
        RemotePipelineRunAction.cancel => 'Cancelling…',
        RemotePipelineRunAction.resume => 'Resuming…',
        RemotePipelineRunAction.retry => 'Retrying…',
      };
}

/// A run control the desktop rejected. Dismissed rather than retried in
/// place: the run may have moved on, so the menu re-reads what is possible.
class _ActionError extends StatelessWidget {
  const _ActionError({required this.message, required this.onDismiss});

  final String message;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      key: const ValueKey('pipeline-run-action-error'),
      children: [
        Expanded(
          child: Text(
            message,
            style: theme.textTheme.bodySmall?.copyWith(
              color: StatusColors.of(context).failed,
            ),
          ),
        ),
        TextButton(
          key: const ValueKey('pipeline-run-action-error-dismiss'),
          onPressed: onDismiss,
          child: const Text('Dismiss'),
        ),
      ],
    );
  }
}

class _AttentionBlock extends StatelessWidget {
  const _AttentionBlock({super.key, required this.run});

  final RemotePipelineRun run;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = StatusColors.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final reason in run.statusReasons) ...[
            Text(
              _reasonLabel(reason),
              style: theme.textTheme.bodySmall?.copyWith(color: colors.warning),
            ),
            const SizedBox(height: 4),
          ],
          for (final pause in run.pendingPauses) ...[
            Text(
              pause.title ?? 'Waiting for input',
              style: theme.textTheme.titleSmall,
            ),
            if (pause.message != null)
              Text(pause.message!, style: theme.textTheme.bodySmall),
            if (pause.fieldLabels.isNotEmpty)
              Text(
                'Asks for: ${pause.fieldLabels.join(', ')}',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
          ],
        ],
      ),
    );
  }

  String _reasonLabel(RemotePipelineRunStatusReason reason) {
    final provider = reason.provider;
    final base = switch (reason.code) {
      'usage_limit' => 'Usage limit reached',
      'auth_required' => 'Sign-in needed',
      _ => reason.code.isEmpty ? reason.kind : reason.code,
    };
    return provider == null || provider.isEmpty ? base : '$base · $provider';
  }
}

class _GroupTile extends StatelessWidget {
  const _GroupTile({
    super.key,
    required this.group,
    required this.selectedJobId,
    required this.selectedStepId,
    required this.pending,
    required this.onSelectStep,
    required this.onLoadLog,
    required this.stepOutput,
  });

  final PipelineRunGroup group;
  final String? selectedJobId;
  final String? selectedStepId;
  final bool pending;
  final void Function(String jobId, String stepId) onSelectStep;
  final void Function(String jobId, String stepId) onLoadLog;
  final PipelineStepOutputFor? stepOutput;

  bool _isSelected(PipelineRunStepEntry entry) =>
      entry.jobId == selectedJobId && entry.step.stepId == selectedStepId;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: EdgeInsets.only(left: group.depth * 16.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(
              children: [
                _StatusDot(status: group.status),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    group.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: AppTypography.emphasisWeight,
                      fontVariations: AppTypography.emphasisVariations,
                    ),
                  ),
                ),
                Text(
                  pipelineRunStatusLabel(group.status),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          for (final entry in group.steps) ...[
            _StepRow(
              key: ValueKey(
                'pipeline-run-step:${entry.jobId}:${entry.step.stepId}',
              ),
              entry: entry,
              selected: _isSelected(entry),
              onTap: () => onSelectStep(entry.jobId, entry.step.stepId),
            ),
            if (_isSelected(entry))
              Padding(
                // A different step, retry or iteration needs a fresh content load.
                key: ValueKey(
                  'pipeline-run-pane:${entry.jobId}:${entry.step.stepId}:'
                  '${entry.step.attempt}:${entry.step.iteration}:${entry.step.recovery}',
                ),
                padding: const EdgeInsets.fromLTRB(16, 4, 0, 8),
                child: _LogPane(
                  step: entry.step,
                  pending: pending,
                  onLoadLog: () => onLoadLog(entry.jobId, entry.step.stepId),
                  output: stepOutput?.call(entry.jobId, entry.step),
                ),
              ),
          ],
        ],
      ),
    );
  }
}

class _StepRow extends StatelessWidget {
  const _StepRow({
    super.key,
    required this.entry,
    required this.selected,
    required this.onTap,
  });

  final PipelineRunStepEntry entry;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final attempt = entry.step.attempt;
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 7, 8, 7),
        color: selected ? theme.colorScheme.surfaceContainerHighest : null,
        child: Row(
          children: [
            _StatusDot(status: entry.step.status),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                entry.step.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall,
              ),
            ),
            if (attempt != null && attempt > 1)
              Text(
                'Attempt $attempt',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Reads and opens one step's complete readable output (CAN-3717).
typedef PipelineStepOutput = ({
  Future<List<PipelineContentChunk>> Function() load,
  VoidCallback open,
});

typedef PipelineStepOutputFor =
    PipelineStepOutput Function(String jobId, RemotePipelineRunStep step);

/// A selected step's output. A settled step shows its complete readable
/// output when the desktop serves it: an agent's own text rather than its
/// provider events, or the whole command log. A running step, or one on an
/// older desktop, shows the streamed tail.
class _LogPane extends StatelessWidget {
  const _LogPane({
    required this.step,
    required this.pending,
    required this.onLoadLog,
    required this.output,
  });

  final RemotePipelineRunStep step;
  final bool pending;
  final VoidCallback onLoadLog;
  final PipelineStepOutput? output;

  @override
  Widget build(BuildContext context) {
    final output = this.output;
    if (output != null && !isPipelineRunActive(step.status)) {
      return _ReadableOutput(output: output);
    }
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    final tail = step.outputTail;
    final hasOutput = tail != null && tail.isNotEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          key: const ValueKey('pipeline-run-log'),
          width: double.infinity,
          constraints: const BoxConstraints(minHeight: 96, maxHeight: 280),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: colors.surfaceRaised,
            borderRadius: BorderRadius.circular(8),
          ),
          child: SingleChildScrollView(
            child: SelectableText(
              tail == null || tail.isEmpty ? 'No output yet.' : tail,
              style: theme.textTheme.bodySmall?.copyWith(
                fontFamily: AppTypography.monoFamily,
                color: colors.foreground,
              ),
            ),
          ),
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            Expanded(
              child: hasOutput
                  ? Text(
                      'Showing the end of this step\'s output.',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    )
                  : const SizedBox.shrink(),
            ),
            // The key is a contract with later tasks (Tasks 6-7): it must
            // stay findable across the pending transition, so it lives on
            // the one TextButton whose enabled state and child swap rather
            // than on an unkeyed replacement widget.
            //
            // Labeled "Refresh output", not "Load full output": the desktop
            // answers `log_request` with up to 500 lines re-trimmed to the
            // same STEP_TAIL_MAX_BYTES (2 KB) ceiling as the streamed tail
            // (`pipelines-service.ts`), so this can never return more than
            // what is already on screen. It still helps — it hydrates a tail
            // for matrix steps the desktop skipped, and for projections that
            // omitted one — but the label must not promise a bigger read.
            TextButton(
              key: const ValueKey('pipeline-run-load-log'),
              onPressed: pending ? null : onLoadLog,
              child: pending
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Refresh output'),
            ),
          ],
        ),
        if (output != null) _OpenOutputButton(onPressed: output.open),
      ],
    );
  }
}

class _ReadableOutput extends StatelessWidget {
  const _ReadableOutput({required this.output});

  final PipelineStepOutput output;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          key: const ValueKey('pipeline-run-output'),
          width: double.infinity,
          constraints: const BoxConstraints(minHeight: 96, maxHeight: 280),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: AppColors.of(context).surfaceRaised,
            borderRadius: BorderRadius.circular(8),
          ),
          child: PipelineContentLoader(
            supported: true,
            load: output.load,
            emptyMessage: 'This step has no output.',
            builder: (context, chunks) => SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final chunk in chunks)
                    PipelineContentChunkView(chunk: chunk),
                ],
              ),
            ),
          ),
        ),
        _OpenOutputButton(onPressed: output.open),
      ],
    );
  }
}

class _OpenOutputButton extends StatelessWidget {
  const _OpenOutputButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => Align(
    alignment: AlignmentDirectional.centerEnd,
    child: TextButton(
      key: const ValueKey('pipeline-run-open-output'),
      onPressed: onPressed,
      child: const Text('Full output'),
    ),
  );
}

class _UnavailableDetail extends StatelessWidget {
  const _UnavailableDetail({
    super.key,
    required this.pending,
    required this.outputTail,
  });

  final bool pending;
  final String? outputTail;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (pending) return const Center(child: CircularProgressIndicator());
    final tail = outputTail;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Step details need a newer desktop. Open this run there to see '
          'its jobs and logs.',
          style: theme.textTheme.bodySmall,
        ),
        if (tail != null && tail.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text(tail, style: theme.textTheme.bodySmall),
        ],
      ],
    );
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(
        color: pipelineRunStatusColor(status, StatusColors.of(context)),
        shape: BoxShape.circle,
      ),
    );
  }
}

class _InlineError extends StatelessWidget {
  const _InlineError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      key: const ValueKey('pipeline-run-error'),
      children: [
        Expanded(
          child: Text(
            message,
            style: theme.textTheme.bodySmall?.copyWith(
              color: StatusColors.of(context).failed,
            ),
          ),
        ),
        TextButton(
          key: const ValueKey('pipeline-run-retry'),
          onPressed: onRetry,
          child: const Text('Try again'),
        ),
      ],
    );
  }
}

class PipelineRunNotice extends StatelessWidget {
  const PipelineRunNotice({
    super.key,
    required this.padding,
    required this.message,
    required this.onRetry,
  });

  final EdgeInsets padding;
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: padding.add(const EdgeInsets.symmetric(horizontal: 24)),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              message,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 12),
            FilledButton.tonal(
              key: const ValueKey('pipeline-run-retry'),
              onPressed: onRetry,
              child: const Text('Try again'),
            ),
          ],
        ),
      ),
    );
  }
}
