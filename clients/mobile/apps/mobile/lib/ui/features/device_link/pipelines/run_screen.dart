import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/data/models/computer_activity/pipeline_content.dart';
import 'package:mobile/device_link/chats/models.dart';
import '../computer_connect/pipelines_model.dart';
import 'package:mobile/ui/core/pipelines/pipeline_run_view.dart';
import 'package:mobile/ui/core/pipelines/pipeline_content_view.dart';

class DevicePipelineRunScreen extends StatefulWidget {
  const DevicePipelineRunScreen({
    super.key,
    required this.repository,
    required this.ref,
    required this.id,
    required this.name,
  });
  final ComputerPipelines repository;
  final DeviceChatRef ref;
  final String id, name;
  @override
  State<DevicePipelineRunScreen> createState() =>
      _DevicePipelineRunScreenState();
}

class _DevicePipelineRunScreenState extends State<DevicePipelineRunScreen>
    with WidgetsBindingObserver {
  late final void Function() _release;
  String? _jobId, _stepId;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _release = widget.repository.watch(widget.ref);
    unawaited(widget.repository.get(widget.ref, widget.id));
  }

  @override
  void dispose() {
    _release();
    widget.repository.clearLogSelection(widget.ref, widget.id);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
  }

  void _refresh() => unawaited(widget.repository.get(widget.ref, widget.id));
  void _content(
    String title,
    String empty,
    RemotePipelineContentSource source,
  ) => unawaited(
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _PipelineContentScreen(
          repository: widget.repository,
          ref: widget.ref,
          id: widget.id,
          title: title,
          empty: empty,
          source: source,
        ),
      ),
    ),
  );
  @override
  Widget build(BuildContext context) => StreamBuilder<void>(
    stream: widget.repository.updates,
    builder: (context, _) {
      final repository = widget.repository,
          ref = widget.ref,
          id = widget.id,
          run = repository.run(ref, id);
      return CanopyScaffold(
        appBar: CanopyAppBar(
          automaticallyImplyLeading: true,
          content: Text(
            run?.pipelineName ?? widget.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          trailing: PipelineRunOptionsMenu(
            enabled: repository.connected,
            run: run,
            pendingAction: repository.pendingAction(ref, id),
            onAction: (action) {
              if (repository.connected) {
                unawaited(repository.control(ref, id, action));
              }
            },
            onRefresh: _refresh,
          ),
        ),
        body: Builder(
          builder: (context) {
            final padding = CanopyScaffold.contentPaddingOf(context),
                error = repository.error(ref, id);
            if (run == null) {
              if (error != null) {
                return PipelineRunNotice(
                  padding: padding,
                  message: error,
                  onRetry: _refresh,
                );
              }
              return Padding(
                padding: padding,
                child: const Center(child: CircularProgressIndicator()),
              );
            }
            return PipelineRunBody(
              padding: padding,
              run: run,
              pending: repository.pending(ref, id),
              error: error,
              selectedJobId: _jobId,
              selectedStepId: _stepId,
              onSelectStep: (job, step) => setState(() {
                final open = _jobId == job && _stepId == step;
                _jobId = open ? null : job;
                _stepId = open ? null : step;
                if (open) {
                  repository.clearLogSelection(ref, id);
                } else {
                  unawaited(
                    repository
                        .log(ref, id, job, step)
                        .catchError((Object _) {}),
                  );
                }
              }),
              onLoadLog: (job, step) => unawaited(
                repository.log(ref, id, job, step).catchError((Object _) {}),
              ),
              stepOutput: (job, step) => (
                load: () => repository.content(
                  ref,
                  id,
                  RemotePipelineStepOutputSource(
                    jobId: job,
                    stepId: step.stepId,
                  ),
                ),
                open: () => _content(
                  step.name,
                  'This step has no output.',
                  RemotePipelineStepOutputSource(
                    jobId: job,
                    stepId: step.stepId,
                  ),
                ),
              ),
              onOpenReport: () => _content(
                'Full report',
                'This run has no saved report.',
                const RemotePipelineReportSource(),
              ),
              onRetry: _refresh,
              actionError: repository.actionError(ref, id),
              onDismissActionError: () => repository.clearActionError(ref, id),
              chatFollowUp: const SizedBox.shrink(),
            );
          },
        ),
      );
    },
  );
}

class _PipelineContentScreen extends StatelessWidget {
  const _PipelineContentScreen({
    required this.repository,
    required this.ref,
    required this.id,
    required this.title,
    required this.empty,
    required this.source,
  });
  final ComputerPipelines repository;
  final DeviceChatRef ref;
  final String id, title, empty;
  final RemotePipelineContentSource source;
  @override
  Widget build(BuildContext context) => CanopyScaffold(
    appBar: CanopyAppBar(
      automaticallyImplyLeading: true,
      content: Text(
        title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: Theme.of(context).textTheme.titleMedium,
      ),
    ),
    body: Builder(
      builder: (context) => Center(
        child: PipelineContentLoader(
          supported: true,
          load: () => repository.content(ref, id, source),
          emptyMessage: empty,
          // The content scrolls under the translucent app bar.
          builder: (context, chunks) => ListView.builder(
            key: const ValueKey('pipeline-content'),
            padding:
                CanopyScaffold.contentPaddingOf(context) +
                const EdgeInsets.all(16),
            itemCount: chunks.length,
            itemBuilder: (context, index) =>
                PipelineContentChunkView(chunk: chunks[index]),
          ),
        ),
      ),
    ),
  );
}
