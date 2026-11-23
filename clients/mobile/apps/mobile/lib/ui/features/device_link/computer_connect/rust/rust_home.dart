import 'dart:async';

import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:flutter/widgets.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/delivery.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/sender.dart'
    show DeviceChatCreationNotSent;
import 'package:mobile/device_link/desktop/ipc.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/device_link/rust_core/failures.dart';
import 'package:mobile/device_link/worktrees/models.dart';
import 'package:mobile/device_link/worktrees/writes.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_draft.dart';

import '../controller.dart';
import '../home_flows.dart';
import '../home_launcher.dart';
import '../home_model.dart';
import '../new_task_model.dart';
import 'rust_composer.dart' show modelOptions;
import 'rust_writes.dart' show homeContextId;
import 'view_revisions.dart';

/// What [controller] shows for [context] now: the inventory the core
/// resolves Home's choices against.
core.HomeInventoryView homeInventory(
  ComputerConnectController controller,
  WorkspaceContext context,
) {
  final scope = controller.scopeFor(context);
  return core.HomeInventoryView(
    active: controller.active,
    online: controller.chats.online,
    scopePending: controller.scopePending,
    loading: controller.loading,
    projects: [
      for (final p in scope.projects)
        core.HomeProjectView(id: p.id, kind: p.type),
    ],
    worktrees: [
      for (final w in scope.worktrees)
        core.HomeWorktreeView(projectId: w.projectId, id: w.id),
    ],
  );
}

core.ChatRefView _chatView(DeviceChatRef ref) => core.ChatRefView(
  projectId: ref.projectId,
  worktreeId: ref.worktreeId,
  id: ref.id,
  title: ref.title,
);

DeviceChatRef _chatRef(core.ChatRefView v) => DeviceChatRef(
  projectId: v.projectId,
  worktreeId: v.worktreeId,
  id: v.id,
  title: v.title,
);

ProviderAvailability? _availability(core.ProviderAvailabilityView? v) =>
    v == null
    ? null
    : ProviderAvailability(
        claude: v.claude,
        codex: v.codex,
        ollama: v.ollama,
        cursor: v.cursor,
        copilot: v.copilot,
      );

/// One computer's Home on the core's [core.HomeService] (final sweep): the
/// core resolves the choices, admits launches, observes their delivery and
/// runs each new task's flow. This class applies its views and settles its
/// intents after the view that shows them (read-your-writes).
final class RustHome implements ComputerHomeFlows {
  RustHome(this.service) {
    _views = service.watch().listen(
      _apply,
      onError: _revisions.ended,
      onDone: _revisions.ended,
      cancelOnError: true,
    );
  }
  final core.HomeService service;
  late final StreamSubscription<core.HomeView> _views;
  core.HomeView? view;
  final _listeners = <VoidCallback>{};
  final _revisions = ViewRevisions();
  bool _disposed = false;

  void _apply(core.HomeView next) {
    if (next.revision <= (view?.revision ?? -1)) return;
    view = next;
    _revisions.reached(next.revision);
    for (final listener in List.of(_listeners)) {
      listener();
    }
  }

  /// Settles [intent] once the view that shows it arrived.
  Future<core.HomeOutcome> settle(core.HomeIntent intent) async {
    if (_disposed) throw StateError('Home disposed.');
    final core.HomeSettled settled;
    try {
      settled = await service.settled(ticket: service.request(intent: intent));
    } on core.CoreFailure catch (error) {
      throw rustFailure(error);
    }
    if (_disposed) throw StateError('Home disposed.');
    await _revisions.wait(settled.revision);
    return settled.outcome;
  }

  @override
  ComputerChatHomeModel homeModel(
    ComputerConnectController controller,
    WorkspaceContext context,
  ) => RustComputerChatHomeModel(this, controller, context);

  @override
  DeviceNewTaskModel newTask(
    ComputerConnectController controller,
    DeviceProject project, {
    DeviceWorktree? worktree,
    String? baseBranch,
    ModelOption? initialModel,
    String? thinkingLevel,
    void Function()? onSent,
    DeviceChatDelivery? delivery,
    WorkspaceContext? workspaceContext,
    List<ChatAttachmentDraft> attachments = const [],
    ValueChanged<List<ChatAttachmentDraft>>? onAttachmentsSent,
  }) => RustDeviceNewTaskModel(
    this,
    controller,
    project,
    worktree: worktree,
    baseBranch: baseBranch,
    initialModel: initialModel,
    thinkingLevel: thinkingLevel,
    onSent: onSent,
    delivery: delivery,
    workspaceContext: workspaceContext,
    attachments: attachments,
    onAttachmentsSent: onAttachmentsSent,
  );

  void dispose() {
    _disposed = true;
    _revisions.fail(StateError('Home disposed.'));
    unawaited(_views.cancel());
  }
}

/// Home's composer choices on the core (`ComputerChatHomeModel`). It tells
/// the core what the controller shows whenever it notifies, sends the
/// choices and passes the core's view through.
final class RustComputerChatHomeModel extends ChangeNotifier
    implements ComputerChatHomeModel {
  RustComputerChatHomeModel(this.home, this.controller, this.context)
    : id = home.service.model(
        context: homeContextId(context.organizationId),
        inventory: homeInventory(controller, context),
      ) {
    controller.addListener(_inventoryChanged);
    home._listeners.add(_viewChanged);
    _viewChanged();
  }
  final RustHome home;
  final int id;
  @override
  final ComputerConnectController controller;
  @override
  final WorkspaceContext context;
  core.HomeModelView? _view;
  var _models = const <ModelOption>[];
  int _optionsRevision = -1;
  bool _disposed = false;

  void _viewChanged() {
    final next = home.view?.models.where((m) => m.id == id).firstOrNull;
    if (_disposed || next == null || next == _view) return;
    _view = next;
    if (next.optionsRevision != _optionsRevision) {
      _optionsRevision = next.optionsRevision;
      _models = modelOptions(next.models);
    }
    notifyListeners();
  }

  void _inventoryChanged() {
    if (_disposed) return;
    home.service.send(
      intent: core.HomeIntent.inventory(
        model: id,
        inventory: homeInventory(controller, context),
      ),
    );
    // The project and worktree lists come from the controller.
    notifyListeners();
  }

  @override
  List<DeviceProject> get projects => controller.scopeFor(context).projects;
  @override
  List<DeviceWorktree> get worktrees => controller
      .scopeFor(context)
      .worktrees
      .where((w) => w.projectId == projectId)
      .toList();
  @override
  DeviceProject? get project =>
      projects.where((p) => p.id == projectId).firstOrNull;
  @override
  DeviceWorktree? get worktree =>
      worktrees.where((w) => w.id == worktreeId).firstOrNull;
  @override
  String? get projectId => _view?.choices.projectId;
  @override
  String? get worktreeId => _view?.choices.worktreeId;
  @override
  String? get baseBranch => _view?.choices.baseBranch;
  @override
  String? get modelId => _view?.choices.modelId;
  @override
  String? get executionHarness => _view?.choices.executionHarness;
  @override
  String? get thinkingLevel => _view?.choices.thinkingLevel;
  @override
  List<ModelOption> get models => _models;
  @override
  ProviderAvailability? get providerAvailability =>
      _availability(_view?.providerAvailability);
  @override
  List<String> get branches => _view?.branches ?? const [];
  @override
  bool get branchesSupported => _view?.branchesSupported ?? false;
  @override
  bool get loading => _view?.loading ?? true;
  @override
  String? get error => _view?.error;
  @override
  String? get saveError => _view?.saveError;
  @override
  ModelOption? get selectedModel => switch (_view?.selectedModel) {
    final row? => modelOptions([row]).first,
    null => null,
  };
  @override
  String get effortLevel => _view?.effortLevel ?? 'high';
  @override
  List<String> get effortLevels => _view?.effortLevels ?? const [];
  @override
  bool get canStart => !_disposed && (_view?.canStart ?? false);

  Future<core.HomeOutcome> _settle(core.HomeIntent intent) =>
      home.settle(intent);

  @override
  Future<void> load() => _settle(core.HomeIntent.load(model: id));
  @override
  Future<void> refreshChoices() =>
      _settle(core.HomeIntent.refreshChoices(model: id));
  Future<bool> _pick(core.HomePick pick) async =>
      switch (await _settle(core.HomeIntent.select(model: id, pick: pick))) {
        core.HomeOutcome_Selected(:final accepted) => accepted,
        _ => false,
      };
  @override
  Future<void> selectProject(String id) => _pick(core.HomePick.project(id: id));
  @override
  Future<void> selectWorktree(String? id) =>
      _pick(core.HomePick.worktree(id: id));
  @override
  Future<void> selectBranch(String id) => _pick(core.HomePick.branch(id: id));
  @override
  Future<void> selectModel(String id, {String? executionHarness}) =>
      _pick(core.HomePick.model(id: id, executionHarness: executionHarness));
  @override
  Future<bool> selectEffort(String level) =>
      _pick(core.HomePick.effort(level: level));

  @override
  void dispose() {
    _disposed = true;
    controller.removeListener(_inventoryChanged);
    home._listeners.remove(_viewChanged);
    home.service.send(intent: core.HomeIntent.unmount(model: id));
    super.dispose();
  }
}

/// A launch's delivery in the core: the new task tracks its first message
/// with it.
final class RustChatDelivery implements DeviceChatDelivery {
  const RustChatDelivery(this.id);
  final int id;
}

/// Home's launcher on the core (`ComputerHomeLauncher`): the core admits
/// launches, saves the choices and drafts, observes delivery and clears a
/// confirmed draft. The composer drafts' text controllers stay here.
final class RustComputerHomeLauncher extends ChangeNotifier
    implements ComputerHomeLauncher {
  RustComputerHomeLauncher(
    this.home,
    this.controller,
    String computerId,
    ChatDraftPort store,
  ) : _drafts = ComputerHomeDrafts(computerId, store) {
    home._listeners.add(_viewChanged);
    _viewChanged();
  }
  final RustHome home;
  @override
  final ComputerConnectController controller;
  final ComputerHomeDrafts _drafts;
  core.LauncherView? _view;
  int _cleared = 0;
  bool _disposed = false;

  void _viewChanged() {
    final next = home.view?.launcher;
    if (_disposed || next == null || next == _view) return;
    _view = next;
    // A confirmed launch clears its draft if the composer still shows it.
    if (next.draftClear case final clear? when clear.seq > _cleared) {
      _cleared = clear.seq;
      final draft = _drafts.existing(clear.context);
      if (draft != null && draft.text == clear.text) draft.clear();
    }
    notifyListeners();
  }

  @override
  bool get busy => _view?.busy ?? false;
  @override
  String? get error => _view?.error;
  @override
  DeviceChatRef? get pendingRef => switch (_view?.pending) {
    final v? =>
      controller.chats.chats.pendingSend?.ref.key == _key(v)
          ? controller.chats.chats.pendingSend!.ref
          : _chatRef(v),
    null => null,
  };
  static String _key(core.ChatRefView v) =>
      '${v.projectId}/${v.worktreeId}/${v.id}';

  @override
  TextEditingController draftFor(WorkspaceContext context) =>
      _drafts.draftFor(context);

  @override
  void bindDraftStore(ChatDraftPort store) => _drafts.bindStore(store);

  @override
  Future<ComputerHomeLaunch?> begin(ComputerChatHomeModel choices) async {
    if (_disposed ||
        choices is! RustComputerChatHomeModel ||
        !identical(choices.controller, controller)) {
      return null;
    }
    final draft = draftFor(choices.context);
    final outcome = await home.settle(
      core.HomeIntent.begin(model: choices.id, text: draft.text),
    );
    if (_disposed) return null;
    final launch = switch (outcome) {
      core.HomeOutcome_Launch(:final launch) => launch,
      _ => null,
    };
    if (launch == null) return null;
    // The inventory may have changed while the core admitted the launch. A
    // missing worktree must not become null: that creates a new one.
    final scope = controller.scopeFor(choices.context);
    final project = scope.projects
        .where((p) => p.id == launch.projectId)
        .firstOrNull;
    final worktree = scope.worktrees
        .where((w) => w.projectId == launch.projectId)
        .where((w) => w.id == launch.worktreeId)
        .firstOrNull;
    if (project == null || (launch.worktreeId != null && worktree == null)) {
      await home.settle(const core.HomeIntent.launchGone());
      return null;
    }
    controller.enterChat();
    return ComputerHomeLaunch(
      project: project,
      worktree: worktree,
      baseBranch: launch.baseBranch,
      model: switch (launch.model) {
        final row? => modelOptions([row]).first,
        null => null,
      },
      thinkingLevel: launch.thinkingLevel,
      text: launch.text,
      delivery: RustChatDelivery(launch.delivery),
      context: choices.context,
    );
  }

  @override
  Future<DeviceChatRef?> resume(WorkspaceContext context) async {
    if (_disposed) return null;
    final outcome = await home.settle(
      core.HomeIntent.resume(inventory: homeInventory(controller, context)),
    );
    if (_disposed) return null;
    final DeviceChatRef ref;
    switch (outcome) {
      case core.HomeOutcome_Open(:final chat):
        ref = pendingRef?.key == _key(chat) ? pendingRef! : _chatRef(chat);
      default:
        return null;
    }
    controller.enterChat();
    final opened = await controller.chats.open(ref);
    final shown = await home.settle(
      core.HomeIntent.resumed(
        opened: !_disposed && opened,
        inventory: homeInventory(controller, context),
      ),
    );
    if (shown case core.HomeOutcome_Resumed(opened: true)) return ref;
    await finish();
    return null;
  }

  @override
  Future<void> finish() async {
    if (_disposed) return;
    try {
      await controller.chats.leaveChat();
      if (!_disposed) await controller.watchOverview();
    } finally {
      if (!_disposed) await home.settle(const core.HomeIntent.finished());
    }
  }

  @override
  void dispose() {
    _disposed = true;
    home._listeners.remove(_viewChanged);
    _drafts.dispose();
    super.dispose();
  }
}

/// The creation attempt as the core reports it.
final class _ViewAttempt implements DeviceWorktreeAttempt {
  const _ViewAttempt(this.projectId, this.worktreeId, this.canRetry);
  @override
  final String projectId;
  @override
  final String? worktreeId;
  @override
  final bool canRetry;
}

/// A new task on the core (`DeviceNewTaskModel`). The core decides each
/// step and every check, error and retry; this model takes the steps only
/// the host can take through its chat model and overview (they hold the
/// selection and its generation) and reports how they went.
final class RustDeviceNewTaskModel extends ChangeNotifier
    implements DeviceNewTaskModel {
  RustDeviceNewTaskModel(
    this.home,
    this.controller,
    this.project, {
    DeviceWorktree? worktree,
    String? baseBranch,
    ModelOption? initialModel,
    String? thinkingLevel,
    this.onSent,
    DeviceChatDelivery? delivery,
    this.workspaceContext,
    this.attachments = const [],
    this.onAttachmentsSent,
  }) : id = home.service.task(
         request: core.NewTaskRequest(
           project: core.HomeProjectView(id: project.id, kind: project.type),
           worktreeId: worktree?.id,
           baseBranch: baseBranch,
           model: initialModel == null
               ? null
               : core.TaskModelView(
                   id: initialModel.id,
                   provider: initialModel.provider,
                   harness: initialModel.harness,
                 ),
           thinkingLevel: thinkingLevel,
           delivery: delivery is RustChatDelivery ? delivery.id : null,
           scoped: workspaceContext != null,
           inventory: homeInventory(
             controller,
             workspaceContext ?? const WorkspaceContext.personal(),
           ),
           attachments: [
             for (final a in attachments)
               core.HomeAttachmentView(
                 localId: a.localId,
                 filename: a.filename,
                 mediaType: a.mediaType,
                 bytes: a.bytes,
               ),
           ],
         ),
       ) {
    controller.addListener(_inventoryChanged);
    controller.chats.addListener(_inventoryChanged);
    _views = home.service.watchTask(task: id).listen(_apply);
  }
  final RustHome home;
  final int id;
  @override
  final ComputerConnectController controller;
  @override
  final DeviceProject project;
  final WorkspaceContext? workspaceContext;
  final void Function()? onSent;
  final List<ChatAttachmentDraft> attachments;
  final ValueChanged<List<ChatAttachmentDraft>>? onAttachmentsSent;
  late final StreamSubscription<core.NewTaskView> _views;
  core.NewTaskView? _view;
  bool _disposed = false;
  @override
  String draft = '';

  void _apply(core.NewTaskView next) {
    final previous = _view;
    if (_disposed || (previous != null && next.revision <= previous.revision)) {
      return;
    }
    _view = next;
    if (next.confirmed && !(previous?.confirmed ?? false)) onSent?.call();
    notifyListeners();
  }

  void _inventoryChanged() {
    if (_disposed) return;
    home.service.send(
      intent: core.HomeIntent.taskInventory(
        task: id,
        inventory: homeInventory(
          controller,
          workspaceContext ?? const WorkspaceContext.personal(),
        ),
      ),
    );
    notifyListeners();
  }

  @override
  bool get flat => project.type == 'cowork';
  @override
  bool get ready => _view?.ready ?? false;
  @override
  bool get sending => _view?.sending ?? false;
  @override
  String? get error => _view?.error;
  @override
  bool get canRetryCreation => _view?.canRetry ?? false;
  @override
  String get statusLabel => _view?.statusLabel ?? '';
  @override
  DeviceCreatedWorktree? get created => switch (_view?.created) {
    final c? => DeviceCreatedWorktree(c.projectId, c.id, c.name),
    null => null,
  };
  @override
  DeviceWorktreeAttempt get attempt => _ViewAttempt(
    project.id,
    _view?.attemptWorktreeId,
    _view?.canRetry ?? false,
  );

  @override
  Future<void> prepare() => _drive(core.HomeIntent.prepare(task: id));
  @override
  Future<void> send() =>
      _drive(core.HomeIntent.taskSend(task: id, text: draft));
  @override
  Future<void> retryCreation() =>
      _drive(core.HomeIntent.retry(task: id, text: draft));

  /// Settles [intent], taking each host step the core asks for. The core
  /// waits for the report of every step it asked for, also once the route
  /// left: a step already taken (a send the computer may have) reports how
  /// it went, so the core reconciles Home's files or deletes their uploaded
  /// copies. A closed task takes no other chat action.
  Future<void> _drive(core.HomeIntent intent) async {
    var next = intent;
    while (true) {
      final core.HomeOutcome outcome;
      try {
        outcome = await home.settle(next);
      } on Object {
        return;
      }
      switch (outcome) {
        case core.HomeOutcome_Step(:final step):
          final result = _disposed && !_settlesSend(step)
              ? _notTaken()
              : await _run(step);
          next = core.HomeIntent.stepDone(task: id, result: result);
        case core.HomeOutcome_Task(:final view?):
          _apply(view);
          return;
        default:
          return;
      }
    }
  }

  /// The steps after a send the computer may have, which Dart's send also
  /// took once disposed: Home's files are spent and the sent draft clears.
  static bool _settlesSend(core.TaskStep step) => step is core.TaskStep_Sent;

  /// A step the core asked for before it learned the route left.
  core.TaskStepResult _notTaken() => core.TaskStepResult(
    failure: const core.TaskFailure(
      kind: core.TaskFailureKind.other,
      message: '',
    ),
    unavailable: false,
    chats: const [],
    online: controller.chats.online,
  );

  Future<core.TaskStepResult> _run(core.TaskStep step) async {
    final model = controller.chats;
    DeviceChatRef? created;
    var unavailable = false;
    var chats = const <core.ChatRefView>[];
    String? activeChatId;
    core.TaskFailure? failure;
    try {
      switch (step) {
        case core.TaskStep_Open(:final chat):
          await model.open(_chatRef(chat));
        case core.TaskStep_CreateTab(:final projectId, :final worktreeId):
          await model.chats.createTab(
            projectId,
            worktreeId,
            onCreated: (ref) => created = ref,
          );
        case core.TaskStep_CreateChat(:final projectId):
          await model.chats.createChat(
            projectId,
            onCreated: (ref) => created = ref,
          );
        case core.TaskStep_LoadWorktree(
          :final projectId,
          :final worktreeId,
          :final name,
        ):
          final tree = DeviceWorktree(
            projectId: projectId,
            projectName: project.name,
            id: worktreeId,
            name: name,
            savedStatus: 'active',
          );
          await controller.loadWorktree(tree);
          unavailable = tree.status == 'Unavailable';
          chats = [for (final ref in tree.chats) _chatView(ref)];
          activeChatId = tree.activeChatId;
        case core.TaskStep_Refresh():
          await model.chats.refresh();
        case core.TaskStep_SetDraft(:final chat?, :final text):
          model.drafts.setDraft(_chatRef(chat), text ?? draft);
        case core.TaskStep_SetDraft(:final text):
          model.setDraft(text ?? draft);
        case core.TaskStep_SetWorkspaceKind(:final projectId, :final kind):
          model.activity.setWorkspaceKind(projectId, kind);
        case core.TaskStep_Sent(attachments: final sent):
          for (final s in sent) {
            final draft = attachments
                .where((a) => a.localId == s.localId)
                .firstOrNull;
            if (draft == null) continue;
            unawaited(
              model.attachmentThumbnails.retain(
                attachmentId: s.path,
                mediaType: draft.mediaType,
                bytes: draft.bytes,
              ),
            );
          }
          onAttachmentsSent?.call(attachments);
      }
    } catch (error) {
      failure = core.TaskFailure(
        kind: switch (error) {
          DeviceChatCreationNotSent() => core.TaskFailureKind.creationNotSent,
          DesktopIpcNotSent() => core.TaskFailureKind.notSent,
          DeviceLinkException() => core.TaskFailureKind.link,
          _ => core.TaskFailureKind.other,
        },
        message: error is DeviceLinkException ? error.message : '',
      );
    }
    return core.TaskStepResult(
      failure: failure,
      created: created == null ? null : _chatView(created!),
      unavailable: unavailable,
      chats: chats,
      activeChatId: activeChatId,
      online: model.online,
    );
  }

  @override
  void dispose() {
    _disposed = true;
    controller.removeListener(_inventoryChanged);
    controller.chats.removeListener(_inventoryChanged);
    home.service.send(intent: core.HomeIntent.taskDispose(task: id));
    unawaited(_views.cancel());
    super.dispose();
  }
}
