import 'dart:async';

import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:mobile/data/models/computer_activity/pipeline_content.dart';
import 'package:mobile/data/models/computer_activity/pipeline_dispatch.dart';
import 'package:mobile/data/models/computer_activity/pipeline_run.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/state.dart';

import 'package:mobile/ui/core/pipelines/pipeline_input_form.dart';

/// One computer's pipelines as Computer Connect reads them (P7): each
/// worktree's runs and dispatchable pipelines, the run screens' reads and
/// controls, starts, step output and reports, plus the feed's run panels
/// ([chatActivity]) and the composer's work drawer ([workDrawer]).
abstract interface class ComputerPipelines {
  /// Fires after every change of what the getters return.
  Stream<void> get updates;
  bool get connected;

  /// [ref]'s worktree's listed runs, newest first.
  List<RemotePipelineRun> runs(DeviceChatRef ref);
  List<RemotePipelineDescriptor> pipelines(DeviceChatRef ref);
  RemotePipelineRun? run(DeviceChatRef ref, String id);

  /// The worktree's load error, or (with [id]) the run's read error.
  String? error(DeviceChatRef ref, [String? id]);
  bool pending(DeviceChatRef ref, String id);
  RemotePipelineRunAction? pendingAction(DeviceChatRef ref, String id);
  String? actionError(DeviceChatRef ref, String id);
  void clearActionError(DeviceChatRef ref, String id);

  /// What a screen shows for a failed [form] or [start].
  String errorMessage(Object error);

  /// The session became usable or ended.
  void setConnected(bool value);

  /// Shows [ref]'s worktree and loads it; the returned function ends it.
  void Function() watch(DeviceChatRef ref);
  Future<void> load(DeviceChatRef ref);
  Future<RemotePipelineRun?> get(DeviceChatRef ref, String id);
  Future<void> log(DeviceChatRef ref, String id, String jobId, String stepId);
  void clearLogSelection(DeviceChatRef ref, String id);
  Future<void> control(
    DeviceChatRef ref,
    String id,
    RemotePipelineRunAction action,
  );
  Future<RemotePipelineDispatchForm> form(
    DeviceChatRef ref,
    String pipelineId, {
    required RemotePipelineOrigin origin,
  });

  PipelineFormRules formRules(
    RemotePipelineDispatchForm form,
    Map<String, String> values,
  );

  /// Starts a pipeline; completes with the new execution's id.
  Future<String> start(
    DeviceChatRef ref,
    String pipelineId,
    Map<String, String> inputs, {
    required RemotePipelineOrigin origin,
  });
  Future<RemotePipelineContentDocument> content(
    DeviceChatRef ref,
    String id,
    RemotePipelineContentSource source,
  );

  /// A feed's run panels; each mounted feed owns one.
  ComputerPipelineChatActivity chatActivity();

  /// A composer's work drawer; each mounted chat owns one.
  ComputerWorkDrawer workDrawer();

  Future<void> dispose();
}

/// The runs each turn of a chat links, and the turn expanded by default.
typedef ComputerRunPanels = ({
  Map<String, List<RemotePipelineRun>> turns,
  String? latest,
});

/// One feed's run panels: follows the chat it shows and reads the runs its
/// turns link (without replaying controls).
abstract interface class ComputerPipelineChatActivity {
  void update({
    required DeviceChatRef? ref,
    required List<DeviceChatMessage> messages,
    required bool online,
  });

  /// What the panels show for [ref] now (none without a ref).
  ComputerRunPanels panels(
    DeviceChatRef? ref,
    List<DeviceChatMessage> messages,
  );
  void dispose();
}

/// One mounted chat's work drawer.
abstract interface class ComputerWorkDrawer {
  /// Fires after every change of [state].
  Stream<void> get updates;
  void update(DeviceChatState chat, {required bool online, bool ready = true});
  core.WorkDrawerView get state;
  bool busy(String id);
  Future<void> retry();
  Future<void> act(
    core.WorkItemView item, {
    core.WorkAction? action,
    bool notifySubscriber = false,
  });
  Future<void> dispose();
}
