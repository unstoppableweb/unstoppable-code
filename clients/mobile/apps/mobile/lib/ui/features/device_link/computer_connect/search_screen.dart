import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/ui/core/chat/widgets/chat_search_view.dart';
import '../chats_screen.dart';
import 'controller.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/ui/core/workspace_context_label.dart';

class DeviceChatSearchScreen extends StatefulWidget {
  const DeviceChatSearchScreen({super.key, required this.controller});
  final ComputerConnectController controller;
  @override
  State<DeviceChatSearchScreen> createState() => _DeviceChatSearchScreenState();
}

class _DeviceChatSearchScreenState extends State<DeviceChatSearchScreen> {
  int? _openingGeneration;
  String? _openError;
  late Listenable _changes;
  bool _updatePending = false;

  void _changed() {
    if (_updatePending) return;
    _updatePending = true;
    // Account teardown can notify while the home route is being disposed.
    // A pushed search route outlives it; rebuild after that locked frame.
    scheduleMicrotask(() {
      _updatePending = false;
      if (mounted) setState(() {});
    });
  }

  void _listen() {
    _changes = Listenable.merge([widget.controller, widget.controller.chats])
      ..addListener(_changed);
  }

  @override
  void didUpdateWidget(DeviceChatSearchScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      _changes.removeListener(_changed);
      _listen();
    }
  }

  WorkspaceContext? _context;
  int _contextGeneration = 0;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final selected = context.watch<WorkspaceContext?>();
    if (selected != _context) {
      _context = selected;
      _openError = null;
      _contextGeneration++;
    }
  }

  @override
  void dispose() {
    _changes.removeListener(_changed);
    if (_openingGeneration case final generation?) {
      unawaited(widget.controller.restoreOverview(generation));
    }
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    _listen();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(widget.controller.refresh());
    });
  }

  @override
  Widget build(BuildContext context) {
    final model = widget.controller.chats;
    final selected = context.watch<WorkspaceContext?>();
    final scope = widget.controller.scopeFor(selected);
    final worktrees = scope.worktrees;
    return ChatSearchView(
      key: ValueKey((widget.controller, selected)),
      contextLabel:
          context.watch<WorkspaceContextLabel?>()?.value ??
          WorkspaceContextLabel.fallback(selected),
      loading:
          widget.controller.active &&
          (model.catalogLoading ||
              widget.controller.loading ||
              widget.controller.scopePending),
      error:
          widget.controller.error ??
          _openError ??
          model.error ??
          (scope.hasUnknownOwners
              ? 'Some projects are hidden because their ownership is unavailable.'
              : null),
      onRetry: _retry,
      items: [
        for (final ref in scope.chats(widget.controller.overview.catalog))
          ChatSearchItem(
            id: ref.id,
            title: ref.title,
            subtitle:
                worktrees
                    .where((w) => w.key == '${ref.projectId}/${ref.worktreeId}')
                    .map((w) => '${w.projectName} · ${w.name}')
                    .firstOrNull ??
                widget.controller.overview.catalogWorkspaces
                    .where((w) => w.id == ref.projectId)
                    .map((w) => w.name)
                    .firstOrNull ??
                '',
            worktree: worktrees.any(
              (w) => w.key == '${ref.projectId}/${ref.worktreeId}',
            ),
            onOpen: !model.online
                ? () {}
                : () async {
                    if (!widget.controller
                        .scopeFor(context.read<WorkspaceContext?>())
                        .includesChat(ref)) {
                      _explainPendingScope();
                      return;
                    }
                    setState(() => _openError = null);
                    final contextGeneration = _contextGeneration;
                    final pending = model.open(ref);
                    final generation = model.chats.selectionGeneration;
                    _openingGeneration = generation;
                    final opened = await pending;
                    if (!context.mounted ||
                        _openingGeneration != generation ||
                        model.chats.selectionGeneration != generation) {
                      return;
                    }
                    _openingGeneration = null;
                    if (!opened ||
                        contextGeneration != _contextGeneration ||
                        !widget.controller
                            .scopeFor(context.read<WorkspaceContext?>())
                            .includesChat(ref)) {
                      _explainPendingScope();
                      await widget.controller.restoreOverview(generation);
                      return;
                    }
                    widget.controller.enterChat();
                    await Navigator.of(context).push<void>(
                      MaterialPageRoute(
                        builder: (_) => DeviceChatScreen(
                          model: model,
                          worktree: widget.controller.activityContext(ref),
                          locationLabel: worktrees
                              .where(
                                (w) =>
                                    w.key ==
                                    '${ref.projectId}/${ref.worktreeId}',
                              )
                              .map((w) => w.name)
                              .firstOrNull,
                        ),
                      ),
                    );
                    if (context.mounted) {
                      await widget.controller.restoreOverview(
                        model.chats.selectionGeneration,
                      );
                    }
                  },
          ),
      ],
    );
  }

  void _explainPendingScope() {
    if (mounted && widget.controller.active && widget.controller.scopePending) {
      setState(() => _openError = deviceScopeRefreshingMessage);
    }
  }

  void _retry() {
    setState(() => _openError = null);
    unawaited(widget.controller.retrySearch());
  }
}
