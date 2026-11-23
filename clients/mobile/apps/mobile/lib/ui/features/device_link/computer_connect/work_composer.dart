import 'dart:async';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:mobile/data/models/composer_work.dart';
import 'package:mobile/ui/core/action_dialogs.dart';
import 'package:mobile/ui/core/chat/widgets/composer_work_drawer.dart';
import '../chats_view_model.dart';
import '../pipelines/run_screen.dart';
import 'pipelines_model.dart';

/// Owns work observations for the visible chat, alongside its composer.
class DeviceWorkComposer extends StatefulWidget {
  const DeviceWorkComposer({
    super.key,
    required this.model,
    required this.builder,
  });
  final DeviceChatsViewModel model;
  final Widget Function(Widget? header) builder;
  @override
  State<DeviceWorkComposer> createState() => _DeviceWorkComposerState();
}

class _DeviceWorkComposerState extends State<DeviceWorkComposer> {
  late ComputerWorkDrawer _repository;
  StreamSubscription<void>? _updates;
  @override
  void initState() {
    super.initState();
    _attach();
  }

  void _attach() {
    _repository = widget.model.activity.pipelines.workDrawer();
    _updates = _repository.updates.listen((_) {
      if (mounted) setState(() {});
    });
    widget.model.addListener(_sync);
    _sync();
  }

  @override
  void didUpdateWidget(DeviceWorkComposer old) {
    super.didUpdateWidget(old);
    if (old.model != widget.model) {
      old.model.removeListener(_sync);
      unawaited(_updates?.cancel());
      unawaited(_repository.dispose());
      _attach();
    } else {
      _sync();
    }
  }

  void _sync() {
    final chat = widget.model.state;
    if (chat != null) {
      _repository.update(
        chat,
        online: widget.model.online && !chat.closed,
        ready: widget.model.chats.ready,
      );
    }
  }

  @override
  void dispose() {
    widget.model.removeListener(_sync);
    unawaited(_updates?.cancel());
    unawaited(_repository.dispose());
    super.dispose();
  }

  Future<void> _action(WorkItemView item, WorkAction action) async {
    final repository = _repository;
    final refKey = widget.model.state?.ref.key;
    bool notifySubscriber = false;
    if (action == WorkAction.deleteWatcher) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => StatefulBuilder(
          builder: (context, setDialogState) => AlertDialog(
            title: const Text('Delete watcher?'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Stop watching "${item.title}"?'),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Notify this chat'),
                  value: notifySubscriber,
                  onChanged: (value) =>
                      setDialogState(() => notifySubscriber = value == true),
                ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Cancel'),
              ),
              TextButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Delete'),
              ),
            ],
          ),
        ),
      );
      if (confirmed != true) return;
    } else if (action == WorkAction.stopDelegates) {
      if (!await confirmDestructive(
        context,
        title: 'Stop all delegates?',
        message: 'Stop every running and queued delegate in this chat?',
        confirmLabel: 'Stop all',
      )) {
        return;
      }
    }
    if (!mounted ||
        refKey != widget.model.state?.ref.key ||
        repository != _repository) {
      return;
    }
    await repository.act(
      item,
      action: action,
      notifySubscriber: notifySubscriber,
    );
  }

  Future<void> _open(WorkItemView item) async {
    if (item.url case final url?) {
      final opened = await launchUrl(
        Uri.parse(url),
        mode: LaunchMode.externalApplication,
      );
      if (!opened && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not open GitHub. Try again.')),
        );
      }
    } else if (item.pipelineId case final id?) {
      final ref = widget.model.state?.ref;
      if (ref == null) return;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => DevicePipelineRunScreen(
            repository: widget.model.activity.pipelines,
            ref: ref,
            id: id,
            name: item.title,
          ),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = _repository.state;
    return widget.builder(
      widget.model.state == null || !state.visible
          ? null
          : ComposerWorkDrawer(
              key: ValueKey(widget.model.state!.ref.key),
              state: state,
              online: widget.model.online && widget.model.chats.ready,
              onRefresh: () => unawaited(_repository.retry()),
              onAction: (item, action) => unawaited(_action(item, action)),
              onOpen: (item) => unawaited(_open(item)),
              busy: _repository.busy,
            ),
    );
  }
}
