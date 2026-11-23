import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/data/models/computer_activity/pipeline_dispatch.dart';
import 'package:mobile/device_link/chats/models.dart';
import '../computer_connect/pipelines_model.dart';
import 'package:mobile/ui/core/pipelines/pipeline_picker_body.dart';
import 'package:mobile/ui/core/pipelines/pipeline_dispatch_form.dart';
import 'package:mobile/ui/core/pipelines/pipeline_run_view.dart';
import 'run_screen.dart';

class DevicePipelinePickerScreen extends StatefulWidget {
  const DevicePipelinePickerScreen({
    super.key,
    required this.repository,
    required this.ref,
  });
  final ComputerPipelines repository;
  final DeviceChatRef ref;
  @override
  State<DevicePipelinePickerScreen> createState() =>
      _DevicePipelinePickerScreenState();
}

class _DevicePipelinePickerScreenState
    extends State<DevicePipelinePickerScreen> {
  bool _loading = true;
  Future<void> _refresh() async {
    setState(() => _loading = true);
    await widget.repository.load(widget.ref);
    if (mounted) setState(() => _loading = false);
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_refresh());
    });
  }

  void _open(RemotePipelineDescriptor pipeline) => unawaited(
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _DispatchScreen(
          repository: widget.repository,
          ref: widget.ref,
          pipeline: pipeline,
        ),
      ),
    ),
  );
  @override
  Widget build(BuildContext context) => StreamBuilder<void>(
    stream: widget.repository.updates,
    builder: (context, _) => CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: Text(
          'Run pipeline',
          style: Theme.of(context).textTheme.titleMedium,
        ),
      ),
      body: Builder(
        builder: (context) {
          final padding = CanopyScaffold.contentPaddingOf(context),
              error = widget.repository.error(widget.ref),
              pipelines = widget.repository.pipelines(widget.ref);
          if (error != null && pipelines.isEmpty) {
            return PipelineRunNotice(
              padding: padding,
              message: error,
              onRetry: () => unawaited(_refresh()),
            );
          }
          return PipelinePickerBody(
            padding: padding,
            pipelines: pipelines,
            refreshing: _loading,
            onRefresh: _refresh,
            onOpen: _open,
          );
        },
      ),
    ),
  );
}

class _DispatchScreen extends StatefulWidget {
  const _DispatchScreen({
    required this.repository,
    required this.ref,
    required this.pipeline,
  });
  final ComputerPipelines repository;
  final DeviceChatRef ref;
  final RemotePipelineDescriptor pipeline;
  @override
  State<_DispatchScreen> createState() => _DispatchScreenState();
}

class _DispatchScreenState extends State<_DispatchScreen> {
  RemotePipelineDispatchForm? _form;
  String? _error;
  bool _submitting = false;
  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final form = await widget.repository.form(
        widget.ref,
        widget.pipeline.pipelineId,
        origin: widget.pipeline.origin,
      );
      if (mounted) {
        setState(() {
          _form = form;
          _error = null;
        });
      }
    } catch (error) {
      if (mounted) {
        setState(() => _error = widget.repository.errorMessage(error));
      }
    }
  }

  Future<void> _run(Map<String, String> inputs) async {
    if (_submitting || !widget.repository.connected) return;
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final id = await widget.repository.start(
        widget.ref,
        widget.pipeline.pipelineId,
        inputs,
        origin: widget.pipeline.origin,
      );
      if (!mounted) return;
      final navigator = Navigator.of(context);
      navigator.pop();
      unawaited(
        navigator.pushReplacement(
          MaterialPageRoute<void>(
            builder: (_) => DevicePipelineRunScreen(
              repository: widget.repository,
              ref: widget.ref,
              id: id,
              name: widget.pipeline.name,
            ),
          ),
        ),
      );
    } catch (error) {
      if (mounted) {
        setState(() => _error = widget.repository.errorMessage(error));
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) => StreamBuilder<void>(
    stream: widget.repository.updates,
    builder: (context, _) => CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: Text(
          widget.pipeline.name,
          style: Theme.of(context).textTheme.titleMedium,
        ),
      ),
      body: Builder(
        builder: (context) {
          final padding = CanopyScaffold.contentPaddingOf(context),
              form = _form;
          if (form == null) {
            if (_error != null) {
              return PipelineRunNotice(
                padding: padding,
                message: _error!,
                onRetry: () => unawaited(_load()),
              );
            }
            return Padding(
              padding: padding,
              child: const Center(child: CircularProgressIndicator()),
            );
          }
          return PipelineDispatchForm(
            form: form,
            padding: padding,
            description: widget.pipeline.description,
            submitting: _submitting,
            degraded: !widget.repository.connected,
            dispatchError: _error,
            onRun: (inputs) => unawaited(_run(inputs)),
            formRules: widget.repository.formRules,
          );
        },
      ),
    ),
  );
}
