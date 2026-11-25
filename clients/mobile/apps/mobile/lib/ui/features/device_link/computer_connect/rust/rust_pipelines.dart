import 'dart:async';

import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:mobile/data/models/computer_activity/action_exception.dart';
import 'package:mobile/data/models/computer_activity/pipeline_content.dart';
import 'package:mobile/data/models/computer_activity/pipeline_dispatch.dart';
import 'package:mobile/data/models/computer_activity/pipeline_run.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/state.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/device_link/rust_core/failures.dart';

import 'package:mobile/ui/core/pipelines/pipeline_input_form.dart';

import '../pipelines_model.dart';
import 'rust_chats.dart';
import 'same_name.dart';

core.ChatRefView _ref(DeviceChatRef ref) => core.ChatRefView(
  projectId: ref.projectId,
  worktreeId: ref.worktreeId,
  id: ref.id,
  title: ref.title,
);

/// A failure that was neither a `RemoteControlException` nor a
/// `DeviceLinkException`; [message] is the core's generic wording.
final class _PipelineFailure implements Exception {
  const _PipelineFailure(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Rethrows a core failure as the exception Dart threw.
Never _throw(core.PipelineFailure failure) => switch (failure.kind) {
  core.PipelineFailureKind.remote => throw RemoteControlException(
    failure.message,
  ),
  core.PipelineFailureKind.link => throw DeviceLinkException(failure.message),
  core.PipelineFailureKind.other => throw _PipelineFailure(failure.message),
};

List<RemotePipelineRunStep> _steps(List<core.PipelineStepView> steps) => [
  for (final s in steps)
    RemotePipelineRunStep(
      stepId: s.stepId,
      name: s.name,
      status: s.status,
      attempt: s.attempt,
      iteration: s.iteration,
      recovery: s.recovery,
      outputTail: s.outputTail,
    ),
];

/// The core's run in the type the shared run screens draw.
RemotePipelineRun _run(core.PipelineRunView r) => RemotePipelineRun(
  localId: r.localId,
  pipelineId: r.pipelineId,
  pipelineName: r.pipelineName,
  workspaceLocalId: r.workspaceLocalId,
  worktreeLocalId: r.worktreeLocalId,
  status: r.status,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  parentExecutionId: r.parentExecutionId,
  triggerSource: r.triggerSource,
  hidden: r.hidden,
  truncated: r.truncated,
  outputTail: r.outputTail,
  progress: switch (r.progress) {
    final p? => RemotePipelineRunProgress(
      completedSteps: p.completedSteps,
      totalSteps: p.totalSteps,
    ),
    null => null,
  },
  statusReasons: [
    for (final s in r.statusReasons)
      RemotePipelineRunStatusReason(
        id: s.id,
        kind: s.kind,
        code: s.code,
        provider: s.provider,
        resetsAt: s.resetsAt,
      ),
  ],
  pendingPauses: [
    for (final p in r.pendingPauses)
      RemotePipelinePauseCheckpoint(
        id: p.id,
        kind: p.kind,
        jobId: p.jobId,
        stepId: p.stepId,
        title: p.title,
        message: p.message,
        fieldLabels: p.fieldLabels,
      ),
  ],
  jobs: switch (r.jobs) {
    final jobs? => [
      for (final j in jobs)
        RemotePipelineRunJob(
          jobId: j.jobId,
          name: j.name,
          status: j.status,
          needs: j.needs,
          steps: _steps(j.steps),
          variants: [
            for (final v in j.variants)
              RemotePipelineRunVariant(
                jobId: v.jobId,
                name: v.name,
                status: v.status,
                steps: _steps(v.steps),
              ),
          ],
          expansion: j.expansion,
          expansionError: j.expansionError,
        ),
    ],
    null => null,
  },
  chatTurns: switch (r.chatTurns) {
    final turns? => List.unmodifiable([
      for (final t in turns)
        RemotePipelineRunChatTurn(
          chatId: t.chatId,
          userMessageId: t.userMessageId,
          relation: t.relation,
        ),
    ]),
    null => null,
  },
  chatFollowUp: switch (r.chatFollowUp) {
    final f? => RemotePipelineRunChatFollowUp(
      planAvailable: f.planAvailable,
      reportAvailable: f.reportAvailable,
    ),
    null => null,
  },
);

num? _number(core.PipelineNumberView? n) => switch (n) {
  null => null,
  final n when n.integer => n.value.toInt(),
  final n => n.value,
};

RemotePipelineDispatchForm _form(core.DispatchFormView f) =>
    RemotePipelineDispatchForm(
      inputs: [
        for (final i in f.inputs)
          RemotePipelineInputDefinition(
            name: i.name,
            description: i.description,
            required: i.required_,
            defaultValue: i.defaultValue,
            type: sameName(RemotePipelineInputType.values, i.inputType),
            options: i.options,
            min: _number(i.min),
            max: _number(i.max),
            hideInUi: i.hideInUi,
          ),
      ],
      inputsOmitted: f.inputsOmitted,
      unsupportedReason: f.unsupportedReason,
    );

/// One worktree's latest view, mapped once.
final class _Scope {
  _Scope(this.view, Map<String, (core.PipelineRunView, RemotePipelineRun)> held)
    : runs = [for (final r in view.runs) _held(held, r)],
      hidden = [for (final r in view.hiddenRuns) _held(held, r)],
      pipelines = [
        for (final d in view.pipelines)
          RemotePipelineDescriptor(
            pipelineId: d.pipelineId,
            name: d.name,
            description: d.description,
            origin: sameName(RemotePipelineOrigin.values, d.origin),
            triggerTypes: d.triggerTypes,
            scopes: d.scopes,
          ),
      ];

  final core.PipelineScopeView view;
  final List<RemotePipelineRun> runs, hidden;
  final List<RemotePipelineDescriptor> pipelines;

  /// Keeps an unchanged run's identity across views, for the runs mapped
  /// most recently.
  static RemotePipelineRun _held(
    Map<String, (core.PipelineRunView, RemotePipelineRun)> held,
    core.PipelineRunView view,
  ) {
    final previous = held.remove(view.localId);
    final kept = previous != null && previous.$1 == view
        ? previous
        : (view, _run(view));
    held[view.localId] = kept;
    if (held.length > _heldRuns) held.remove(held.keys.first);
    return kept.$2;
  }

  static const _heldRuns = 500;
}

/// One computer's pipelines on the core's [core.PipelinesService] (P7).
/// The core owns the runs, reads, controls, starts, the feed's run panels
/// and the work drawers; this model maps each view into the types the
/// shared run screens draw, once per view.
final class RustComputerPipelines implements ComputerPipelines {
  RustComputerPipelines(this.service, this._reader) {
    _connection = _reader.updates
        .map((_) => connected)
        .distinct()
        .listen((_) => _changed());
  }

  final core.PipelinesService service;
  final RustChatReader _reader;
  late final StreamSubscription<bool> _connection;
  final _forms = Expando<core.DispatchFormView>();
  final _updates = StreamController<void>.broadcast();
  final _scopes = <String, _Scope>{};
  final _watches = <String, StreamSubscription<core.PipelineScopeView>>{};
  final _held = <String, (core.PipelineRunView, RemotePipelineRun)>{};
  bool _disposed = false;
  int _tokens = 0;

  @override
  Stream<void> get updates => _updates.stream;
  @override
  bool get connected => _reader.activityConnected;

  void _changed() {
    if (!_disposed) _updates.add(null);
  }

  int _token() => ++_tokens;

  String _key(DeviceChatRef ref) => '${ref.projectId}/${ref.worktreeId}';

  /// [ref]'s worktree, followed from the first read until disposal.
  _Scope? _scope(DeviceChatRef ref) {
    final key = _key(ref);
    if (!_disposed && !_watches.containsKey(key)) {
      _watches[key] = service
          .watch(projectId: ref.projectId, worktreeId: ref.worktreeId)
          .listen((view) {
            if (_disposed) return;
            _scopes[key] = _Scope(view, _held);
            _changed();
          });
    }
    return _scopes[key];
  }

  RemotePipelineRun _map(core.PipelineRunView view) =>
      _Scope._held(_held, view);

  /// The core's run (the comparison reads its display facts).
  core.PipelineRunView? coreRun(DeviceChatRef ref, String id) {
    final view = _scope(ref)?.view;
    if (view == null) return null;
    for (final r in [...view.runs, ...view.hiddenRuns]) {
      if (r.localId == id) return r;
    }
    return null;
  }

  Future<core.PipelinesSettled> _request(core.PipelinesIntent intent) async {
    try {
      return await service.settled(ticket: service.request(intent: intent));
    } on core.CoreFailure catch (error) {
      throw rustFailure(error);
    }
  }

  Future<core.PipelinesSettled> _checked(core.PipelinesIntent intent) async {
    final settled = await _request(intent);
    if (settled.failure case final failure?) _throw(failure);
    return settled;
  }

  @override
  List<RemotePipelineRun> runs(DeviceChatRef ref) => _scope(ref)?.runs ?? [];
  @override
  List<RemotePipelineDescriptor> pipelines(DeviceChatRef ref) =>
      _scope(ref)?.pipelines ?? const [];
  @override
  RemotePipelineRun? run(DeviceChatRef ref, String id) {
    final scope = _scope(ref);
    if (scope == null) return null;
    for (final r in [...scope.runs, ...scope.hidden]) {
      if (r.localId == id) return r;
    }
    return null;
  }

  @override
  String? error(DeviceChatRef ref, [String? id]) {
    final view = _scope(ref)?.view;
    if (view == null) return null;
    if (id == null) return view.error;
    return view.runErrors.where((n) => n.id == id).firstOrNull?.message;
  }

  @override
  bool pending(DeviceChatRef ref, String id) =>
      _scope(ref)?.view.pending.contains(id) ?? false;
  @override
  RemotePipelineRunAction? pendingAction(DeviceChatRef ref, String id) =>
      switch (_scope(ref)?.view.controls.where((c) => c.id == id).firstOrNull) {
        final c? => sameName(RemotePipelineRunAction.values, c.action),
        null => null,
      };
  @override
  String? actionError(DeviceChatRef ref, String id) => _scope(
    ref,
  )?.view.actionErrors.where((n) => n.id == id).firstOrNull?.message;
  @override
  void clearActionError(DeviceChatRef ref, String id) => service.send(
    intent: core.PipelinesIntent.clearActionError(chat: _ref(ref), id: id),
  );

  @override
  String errorMessage(Object error) => switch (error) {
    RemoteControlException(:final message) => message,
    DeviceLinkException(:final message) => message,
    _PipelineFailure(:final message) => message,
    _ => '$error',
  };

  @override
  void Function() watch(DeviceChatRef ref) {
    final token = _token();
    _scope(ref);
    service.send(
      intent: core.PipelinesIntent.watch(chat: _ref(ref), token: token),
    );
    return () {
      if (!_disposed) {
        service.send(intent: core.PipelinesIntent.release(token: token));
      }
    };
  }

  @override
  Future<void> load(DeviceChatRef ref) {
    _scope(ref);
    return _request(core.PipelinesIntent.load(chat: _ref(ref)));
  }

  @override
  Future<RemotePipelineRun?> get(DeviceChatRef ref, String id) async {
    _scope(ref);
    final settled = await _request(
      core.PipelinesIntent.get_(chat: _ref(ref), id: id),
    );
    return switch (settled.outcome) {
      core.PipelinesOutcome_Run(:final run?) => _map(run),
      _ => null,
    };
  }

  @override
  Future<void> log(DeviceChatRef ref, String id, String jobId, String stepId) =>
      _checked(
        core.PipelinesIntent.log(
          chat: _ref(ref),
          id: id,
          jobId: jobId,
          stepId: stepId,
        ),
      );

  @override
  void clearLogSelection(DeviceChatRef ref, String id) => service.send(
    intent: core.PipelinesIntent.clearLogSelection(chat: _ref(ref), id: id),
  );

  @override
  Future<void> control(
    DeviceChatRef ref,
    String id,
    RemotePipelineRunAction action,
  ) {
    _scope(ref);
    return _request(
      core.PipelinesIntent.control(
        chat: _ref(ref),
        id: id,
        action: sameName(core.PipelineAction.values, action),
      ),
    );
  }

  @override
  Future<RemotePipelineDispatchForm> form(
    DeviceChatRef ref,
    String pipelineId, {
    required RemotePipelineOrigin origin,
  }) async {
    final settled = await _checked(
      core.PipelinesIntent.form(
        chat: _ref(ref),
        pipelineId: pipelineId,
        origin: sameName(core.PipelineOrigin.values, origin),
      ),
    );
    if (settled.outcome case core.PipelinesOutcome_Form(:final form)) {
      final shown = _form(form);
      _forms[shown] = form;
      return shown;
    }
    throw StateError('The core sent no form.');
  }

  @override
  PipelineFormRules formRules(
    RemotePipelineDispatchForm form,
    Map<String, String> values,
  ) {
    final rules = service.formRules(
      form: _forms[form]!,
      values: [
        for (final entry in values.entries)
          core.PipelineInputValue(name: entry.key, value: entry.value),
      ],
    );
    return (
      visible: [for (final index in rules.visible) form.inputs[index]],
      initial: {for (final entry in rules.initial) entry.name: entry.value},
      errors: {for (final entry in rules.errors) entry.name: entry.message},
      payload: {for (final entry in rules.payload) entry.name: entry.value},
    );
  }

  @override
  Future<String> start(
    DeviceChatRef ref,
    String pipelineId,
    Map<String, String> inputs, {
    required RemotePipelineOrigin origin,
  }) async {
    _scope(ref);
    final settled = await _checked(
      core.PipelinesIntent.start(
        chat: _ref(ref),
        pipelineId: pipelineId,
        origin: sameName(core.PipelineOrigin.values, origin),
        inputs: [
          for (final entry in inputs.entries)
            core.PipelineInputValue(name: entry.key, value: entry.value),
        ],
      ),
    );
    return switch (settled.outcome) {
      core.PipelinesOutcome_Started(:final id) => id,
      _ => throw StateError('The core sent no execution.'),
    };
  }

  @override
  Future<List<PipelineContentChunk>> content(
    DeviceChatRef ref,
    String id,
    RemotePipelineContentSource source,
  ) async {
    final settled = await _checked(
      core.PipelinesIntent.content(
        chat: _ref(ref),
        id: id,
        source: switch (source) {
          RemotePipelineStepOutputSource(:final jobId, :final stepId) =>
            core.PipelineContentSource.stepOutput(jobId: jobId, stepId: stepId),
          RemotePipelineReportSource() =>
            const core.PipelineContentSource.report(),
        },
      ),
    );
    return switch (settled.outcome) {
      core.PipelinesOutcome_Content(:final chunks) => [
        for (final chunk in chunks)
          (markdown: chunk.markdown, text: chunk.text),
      ],
      _ => throw StateError('The core sent no document.'),
    };
  }

  @override
  ComputerPipelineChatActivity chatActivity() =>
      RustPipelineChatActivity._(this, _token());

  @override
  ComputerWorkDrawer workDrawer() => RustComputerWorkDrawer._(this, _token());

  @override
  Future<void> dispose() async {
    _disposed = true;
    await _connection.cancel();
    service.send(intent: const core.PipelinesIntent.close());
    for (final watch in _watches.values) {
      await watch.cancel();
    }
    _watches.clear();
    await _updates.close();
  }
}

/// A feed's run panels on the core: it follows the chat and reads the runs
/// the turns link; the panels draw its turns.
final class RustPipelineChatActivity implements ComputerPipelineChatActivity {
  RustPipelineChatActivity._(this.pipelines, this.token) {
    _subscription = pipelines.service.watchChatActivity(token: token).listen((
      view,
    ) {
      _view = view;
      pipelines._changed();
    });
  }

  final RustComputerPipelines pipelines;
  final int token;
  late final StreamSubscription<core.ChatActivityView> _subscription;
  core.ChatActivityView? _view;
  ({String? key, bool online})? _sent;

  /// The core reads the chat's messages from its own read path.
  @override
  void update({required DeviceChatRef? ref, required bool online}) {
    if (ref != null) pipelines._scope(ref);
    final next = (key: ref?.key, online: online);
    if (next == _sent) return;
    _sent = next;
    pipelines.service.send(
      intent: core.PipelinesIntent.follow(
        token: token,
        chat: ref == null ? null : _ref(ref),
        online: online,
      ),
    );
  }

  @override
  ComputerRunPanels panels(DeviceChatRef? ref) {
    final view = _view;
    if (ref == null || view == null) return (turns: const {}, latest: null);
    return (
      turns: {
        for (final turn in view.turns)
          turn.turn: [for (final r in turn.runs) pipelines._map(r)],
      },
      latest: view.latest,
    );
  }

  @override
  void dispose() {
    unawaited(_subscription.cancel());
    pipelines.service.send(intent: core.PipelinesIntent.unfollow(token: token));
  }
}

/// A composer's work drawer on the core: the core reads, projects and acts;
/// the drawer draws its view as is.
final class RustComputerWorkDrawer implements ComputerWorkDrawer {
  RustComputerWorkDrawer._(this.pipelines, this.token) {
    _subscription = pipelines.service.watchDrawer(token: token).listen((view) {
      _view = view;
      if (!_closed) _updates.add(null);
    });
  }

  final RustComputerPipelines pipelines;
  final int token;
  late final StreamSubscription<core.WorkDrawerView> _subscription;
  final _updates = StreamController<void>.broadcast();
  static const _none = core.WorkDrawerView(
    revision: 0,
    chatKey: null,
    items: [],
    errors: [],
    busy: [],
    visible: false,
    summary: '',
    counts: [],
  );
  core.WorkDrawerView _view = _none;
  ({String key, bool online, bool ready})? _sent;
  bool _closed = false;

  @override
  Stream<void> get updates => _updates.stream;

  /// The core reads the chat's state from its own read path.
  @override
  void update(DeviceChatState chat, {required bool online, bool ready = true}) {
    final next = (key: chat.ref.key, online: online, ready: ready);
    if (next == _sent) return;
    _sent = next;
    pipelines.service.send(
      intent: core.PipelinesIntent.drawerUpdate(
        token: token,
        chat: _ref(chat.ref),
        online: online,
        ready: ready,
      ),
    );
  }

  /// The core's view of the chat [update] last named: none while the view
  /// it has is still the previous chat's.
  @override
  core.WorkDrawerView get state => _view.chatKey == _sent?.key ? _view : _none;
  @override
  bool busy(String id) => state.busy.contains(id);

  @override
  Future<void> retry() =>
      pipelines._request(core.PipelinesIntent.drawerRetry(token: token));

  @override
  Future<void> act(
    core.WorkItemView item, {
    core.WorkAction? action,
    bool notifySubscriber = false,
  }) async {
    final chosen = action ?? item.action;
    if (chosen == null) return;
    await pipelines._request(
      core.PipelinesIntent.drawerAct(
        token: token,
        itemId: item.id,
        action: chosen,
        notifySubscriber: notifySubscriber,
      ),
    );
  }

  @override
  Future<void> dispose() async {
    _closed = true;
    pipelines.service.send(
      intent: core.PipelinesIntent.drawerClose(token: token),
    );
    await _subscription.cancel();
    await _updates.close();
  }
}
