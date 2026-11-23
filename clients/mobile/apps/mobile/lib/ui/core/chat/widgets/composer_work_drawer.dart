import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';
import 'package:mobile/data/models/composer_work.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/core/navigation/home_back_handlers.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/core/chat/widgets/composer_drawer.dart';

/// Mobile rendering of ComposerWorkDrawer. Hosts supply facts and actions;
/// rows never decide which machine or transport owns the work.
class ComposerWorkDrawer extends StatefulWidget {
  const ComposerWorkDrawer({
    super.key,
    required this.state,
    required this.online,
    required this.onRefresh,
    required this.onAction,
    required this.onOpen,
    this.busy = _notBusy,
  });
  final WorkDrawerView state;
  final bool online;
  final VoidCallback onRefresh;
  final void Function(WorkItemView, WorkAction) onAction;
  final ValueChanged<WorkItemView> onOpen;
  final bool Function(String) busy;
  static bool _notBusy(String _) => false;
  @override
  State<ComposerWorkDrawer> createState() => _ComposerWorkDrawerState();
}

class _ComposerWorkDrawerState extends State<ComposerWorkDrawer> {
  bool _expanded = false;
  String? _open;
  final _toggle = FocusNode();
  HomeBackHandlers? _backHandlers;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final handlers = HomeNavigationScope.maybeOf(context)?.backHandlers;
    if (handlers == _backHandlers) return;
    _backHandlers?.remove(_consumeBack);
    _backHandlers = handlers;
    handlers?.add(_consumeBack);
  }

  bool _consumeBack() {
    if (!_expanded ||
        !widget.state.visible ||
        ModalRoute.of(context)?.isCurrent == false) {
      return false;
    }
    _collapse();
    return true;
  }

  @override
  void dispose() {
    _toggle.dispose();
    _backHandlers?.remove(_consumeBack);
    super.dispose();
  }

  void _collapse() {
    setState(() => _expanded = false);
    _toggle.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state,
        colors = AppColors.of(context),
        statuses = StatusColors.of(context);
    if (!state.visible) return const SizedBox.shrink();
    final summary = state.summary.isNotEmpty
        ? state.summary
        : 'Background work unavailable';
    final finished = state.items.where((i) => i.finished).toList();
    return PopScope(
      canPop: _backHandlers != null || !_expanded,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && _backHandlers == null) _consumeBack();
      },
      child: CallbackShortcuts(
        bindings: {const SingleActivator(LogicalKeyboardKey.escape): _collapse},
        child: ComposerDrawerSurface(
          key: const ValueKey('composer-work-drawer'),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_expanded) ...[
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxHeight: math.min(
                      268,
                      (MediaQuery.sizeOf(context).height -
                              MediaQuery.viewInsetsOf(context).bottom) *
                          .35,
                    ),
                  ),
                  child: SingleChildScrollView(
                    key: const ValueKey('composer-work-list'),
                    padding: const EdgeInsets.fromLTRB(8, 8, 8, 4),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        for (final group in WorkGroup.values)
                          if (state.count(group) > 0) ...[
                            Padding(
                              padding: const EdgeInsets.only(
                                left: 6,
                                top: 4,
                                bottom: 2,
                              ),
                              child: Row(
                                children: [
                                  Expanded(
                                    child: Text(
                                      '${group.label} ${state.count(group)}',
                                      style: AppTypography.bodySmall.copyWith(
                                        color: colors.foregroundMuted,
                                      ),
                                    ),
                                  ),
                                  // Match the shared desktop drawer: history
                                  // belongs to the active Running group.
                                  if (group == WorkGroup.running &&
                                      finished.isNotEmpty)
                                    CanopyButton(
                                      label: 'View completed',
                                      variant: CanopyButtonVariant.inline,
                                      onPressed: () =>
                                          _completed(context, finished),
                                    ),
                                ],
                              ),
                            ),
                            for (final item in state.items.where(
                              (i) => i.group == group && !i.finished,
                            ))
                              _row(item),
                          ],
                        for (final error in state.errors)
                          Padding(
                            padding: const EdgeInsets.all(6),
                            child: Text(
                              error,
                              style: AppTypography.bodySmall.copyWith(
                                color: statuses.warning,
                              ),
                            ),
                          ),
                        if (state.errors.isNotEmpty)
                          Align(
                            alignment: Alignment.centerLeft,
                            child: CanopyButton(
                              label: 'Try again',
                              variant: CanopyButtonVariant.inline,
                              onPressed: widget.online
                                  ? widget.onRefresh
                                  : null,
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
                Divider(height: 1, color: colors.border),
              ],
              Semantics(
                button: true,
                expanded: _expanded,
                label: '${_expanded ? 'Hide' : 'Show'} work: $summary',
                excludeSemantics: true,
                child: InkWell(
                  key: const ValueKey('composer-work-toggle'),
                  focusNode: _toggle,
                  onTap: () => setState(() => _expanded = !_expanded),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(14, 8, 8, 8),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 32),
                      child: Row(
                        children: [
                          if (state.count(WorkGroup.running) > 0) ...[
                            RunSpinner(
                              size: 12,
                              color: colors.foregroundSecondary,
                            ),
                            const SizedBox(width: 8),
                          ] else if (state.count(WorkGroup.needsYou) > 0) ...[
                            CanopyIcon(
                              glyph: CanopyGlyph.circleQuestionmark,
                              size: 14,
                              tint: statuses.warning,
                            ),
                            const SizedBox(width: 8),
                          ],
                          Expanded(
                            child: Wrap(
                              spacing: 8,
                              runSpacing: 4,
                              children: [
                                if (state.summary.isEmpty)
                                  Text(
                                    summary,
                                    style: AppTypography.bodySmall.copyWith(
                                      color: colors.foregroundSecondary,
                                    ),
                                  ),
                                for (final group in [
                                  WorkGroup.queued,
                                  WorkGroup.running,
                                  WorkGroup.pullRequests,
                                  WorkGroup.watching,
                                  WorkGroup.needsYou,
                                ])
                                  if (state.count(group) > 0)
                                    Text(
                                      '${group.label} ${state.count(group)}',
                                      style: AppTypography.bodySmall.copyWith(
                                        color: group == WorkGroup.needsYou
                                            ? statuses.warning
                                            : colors.foregroundSecondary,
                                      ),
                                    ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 8),
                          CanopyIcon(
                            glyph: _expanded
                                ? CanopyGlyph.chevronDownSmall
                                : CanopyGlyph.chevronTopSmall,
                            size: 16,
                            tint: colors.foregroundMuted,
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _row(WorkItemView item) {
    final colors = AppColors.of(context), statuses = StatusColors.of(context);
    final open = _open == item.id;
    final tint = switch (item.tone) {
      WorkTone.attention => statuses.warning,
      WorkTone.failed => statuses.failed,
      WorkTone.success => statuses.success,
      WorkTone.merged => statuses.merged,
      WorkTone.info => statuses.unread,
      _ => colors.foregroundMuted,
    };
    return Column(
      key: ValueKey('work-${item.id}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            Expanded(
              child: Semantics(
                button: true,
                expanded: open,
                child: InkWell(
                  onTap: () => setState(() => _open = open ? null : item.id),
                  borderRadius: BorderRadius.circular(AppRadii.md),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 6,
                      vertical: 12,
                    ),
                    child: Row(
                      children: [
                        if (item.tone == WorkTone.running)
                          RunSpinner(size: 14, color: colors.foregroundMuted)
                        else
                          CanopyIcon(
                            glyph: _glyph(item.kind),
                            size: 16,
                            tint: tint,
                          ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text.rich(
                            TextSpan(
                              children: [
                                TextSpan(
                                  text: item.title,
                                  style: AppTypography.body.copyWith(
                                    color: colors.foreground,
                                  ),
                                ),
                                if (item.subtitle case final subtitle?)
                                  TextSpan(
                                    text: '  $subtitle',
                                    style: AppTypography.bodySmall.copyWith(
                                      color: colors.foregroundMuted,
                                    ),
                                  ),
                                if (item.status case final status?)
                                  TextSpan(
                                    text: ' · $status',
                                    style: AppTypography.bodySmall.copyWith(
                                      color: tint,
                                    ),
                                  ),
                              ],
                            ),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        if (item.watcherCount > 0) ...[
                          const SizedBox(width: 6),
                          CanopyIcon(
                            glyph: CanopyGlyph.watching,
                            size: 14,
                            tint: colors.foregroundMuted,
                          ),
                          Text(
                            ' ${item.watcherCount}',
                            style: AppTypography.bodySmall.copyWith(
                              color: colors.foregroundMuted,
                            ),
                          ),
                        ],
                        if (item.action != WorkAction.deleteWatcher) ...[
                          const SizedBox(width: 6),
                          CanopyIcon(
                            glyph: open
                                ? CanopyGlyph.chevronDownSmall
                                : CanopyGlyph.chevronRightSmall,
                            size: 14,
                            tint: colors.foregroundMuted,
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),
            if (item.action == WorkAction.deleteWatcher)
              CanopyIconButton(
                glyph: CanopyGlyph.trashCan,
                tooltip: workActionLabel(WorkAction.deleteWatcher),
                onPressed: widget.online && !widget.busy(item.id)
                    ? () => widget.onAction(item, WorkAction.deleteWatcher)
                    : null,
                size: CanopyIconButtonSize.small,
              ),
          ],
        ),
        if (open)
          Padding(
            padding: const EdgeInsets.fromLTRB(32, 4, 8, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final fact in item.details) ...[
                  Text(
                    fact.label,
                    style: AppTypography.bodySmall.copyWith(
                      color: colors.foregroundMuted,
                    ),
                  ),
                  SelectableText(
                    fact.label == 'Last checked'
                        ? formatRelativeTime(fact.value)
                        : fact.value,
                    style: AppTypography.body.copyWith(
                      color: colors.foreground,
                    ),
                  ),
                  const SizedBox(height: 10),
                ],
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    if (item.url != null || item.pipelineId != null)
                      CanopyButton(
                        label: item.url != null ? 'Open on GitHub' : 'Open run',
                        variant: CanopyButtonVariant.inline,
                        onPressed: () => widget.onOpen(item),
                      ),
                    for (final action in [
                      if (item.action != null &&
                          item.action != WorkAction.deleteWatcher)
                        item.action!,
                      ...item.extraActions,
                    ])
                      CanopyButton(
                        label:
                            item.actionLabel(action) ?? workActionLabel(action),
                        variant: CanopyButtonVariant.inline,
                        onPressed: widget.online && !widget.busy(item.id)
                            ? () => widget.onAction(item, action)
                            : null,
                      ),
                  ],
                ),
              ],
            ),
          ),
      ],
    );
  }

  void _completed(BuildContext context, List<WorkItemView> items) =>
      showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Completed work'),
          content: SizedBox(
            width: 360,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final item in items)
                    ListTile(
                      title: Text(item.title),
                      subtitle: Text(item.status ?? 'Completed'),
                      onTap: item.url != null || item.pipelineId != null
                          ? () => widget.onOpen(item)
                          : null,
                    ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Close'),
            ),
          ],
        ),
      );
}

CanopyGlyph _glyph(WorkKind kind) => switch (kind) {
  WorkKind.agent => CanopyGlyph.agent,
  WorkKind.command => CanopyGlyph.console,
  WorkKind.workflow => CanopyGlyph.agents,
  WorkKind.task => CanopyGlyph.squareChecklist,
  WorkKind.pipeline => CanopyGlyph.workflows,
  WorkKind.github => CanopyGlyph.github,
  WorkKind.pullRequest => CanopyGlyph.pullRequest,
  WorkKind.watcher => CanopyGlyph.watching,
  WorkKind.message => CanopyGlyph.bubbleText,
};

String workActionLabel(WorkAction action) => switch (action) {
  WorkAction.stopTask || WorkAction.stopDelegate => 'Stop',
  WorkAction.stopDelegates => 'Stop all delegates',
  WorkAction.deleteWatcher => 'Delete watcher',
  WorkAction.cancelQueued => 'Delete',
  WorkAction.forceQueued => 'Run now',
  WorkAction.steerQueued => 'Steer',
};
