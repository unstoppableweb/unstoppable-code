import 'dart:async';
import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/data/models/changed_file.dart';
import 'package:mobile/device_link/worktree_ref.dart';
import 'package:mobile/ui/core/files/file_diff_view.dart';
import 'package:mobile/ui/core/files/unified_diff_lines.dart';
import 'activity_model.dart';
import 'rust/same_name.dart';

class DeviceFileDiffScreen extends StatefulWidget {
  const DeviceFileDiffScreen({
    super.key,
    required this.repository,
    required this.ref,
    required this.file,
  });
  final ComputerFileDiffs repository;
  final DeviceWorktreeRef ref;
  final RemoteChangedFile file;
  @override
  State<DeviceFileDiffScreen> createState() => _DeviceFileDiffScreenState();
}

class _DeviceFileDiffScreenState extends State<DeviceFileDiffScreen> {
  late StreamSubscription<ComputerFileDiffKey> _subscription;
  late void Function() _release;
  @override
  void initState() {
    super.initState();
    _bind();
  }

  @override
  void didUpdateWidget(DeviceFileDiffScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.repository != widget.repository ||
        oldWidget.ref.projectId != widget.ref.projectId ||
        oldWidget.ref.worktreeId != widget.ref.worktreeId ||
        oldWidget.file != widget.file) {
      unawaited(_subscription.cancel());
      _release();
      _bind();
    }
  }

  void _bind() {
    final key = widget.repository.key(widget.ref, widget.file);
    _subscription = widget.repository.updates.listen((updated) {
      if (mounted && key == updated) setState(() {});
    });
    _release = widget.repository.watch(widget.ref, widget.file);
  }

  @override
  void dispose() {
    unawaited(_subscription.cancel());
    _release();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => CanopyScaffold(
    appBar: CanopyAppBar(
      automaticallyImplyLeading: true,
      content: Text(
        widget.file.filePath.split('/').last,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: Theme.of(context).textTheme.titleMedium,
      ),
    ),
    body: Builder(
      builder: (context) {
        final padding = CanopyScaffold.contentPaddingOf(context);
        final view = widget.repository.view(widget.ref, widget.file);
        return switch (view.phase) {
          core.DiffPhase_Loading() => Padding(
            padding: padding,
            child: const Center(child: CircularProgressIndicator()),
          ),
          core.DiffPhase_Failed(:final message) => FileDiffNotice(
            padding: padding,
            message: message,
            action: FilledButton.tonal(
              key: const ValueKey('file-diff-retry'),
              onPressed: () =>
                  unawaited(widget.repository.refresh(widget.ref, widget.file)),
              child: const Text('Try again'),
            ),
          ),
          // The header's counts are the list's: the diff carries them too.
          core.DiffPhase_Shown() => FileDiffView(
            padding: padding,
            file: widget.file,
            lines: [
              for (final line in view.lines)
                UnifiedDiffLine(
                  sameName(UnifiedDiffLineKind.values, line.kind),
                  line.text,
                ),
            ],
            truncated: view.truncated,
            cacheNotice: view.notice,
            lineLengthTruncated: view.lineLengthTruncated,
          ),
        };
      },
    ),
  );
}
