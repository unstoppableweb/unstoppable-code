import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/worktrees/models.dart';
import 'controller.dart';

/// The current Home choices and the available projects, worktrees and models.
abstract interface class ComputerChatHomeModel implements Listenable {
  factory ComputerChatHomeModel(
    ComputerConnectController controller,
    WorkspaceContext context,
  ) => controller.homeFlows.homeModel(controller, context);

  ComputerConnectController get controller;
  WorkspaceContext get context;
  List<DeviceProject> get projects;
  List<DeviceWorktree> get worktrees;
  DeviceProject? get project;
  DeviceWorktree? get worktree;
  String? get projectId;
  String? get worktreeId;
  String? get baseBranch;
  String? get modelId;
  String? get executionHarness;
  String? get thinkingLevel;
  List<ModelOption> get models;
  ProviderAvailability? get providerAvailability;
  List<String> get branches;
  bool get branchesSupported;
  bool get loading;
  String? get error;
  String? get saveError;
  ModelOption? get selectedModel;

  /// The effort shown: the chosen level clamped to [effortLevels].
  String get effortLevel;

  /// Empty when the model does not think.
  List<String> get effortLevels;
  bool get canStart;
  Future<void> load();
  Future<void> refreshChoices();
  Future<void> selectProject(String id);
  Future<void> selectWorktree(String? id);
  Future<void> selectBranch(String id);
  Future<void> selectModel(String id, {String? executionHarness});
  Future<bool> selectEffort(String level);
  void dispose();
}
