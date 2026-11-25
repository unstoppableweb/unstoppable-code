import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:flutter/foundation.dart';
import '../chats_view_model.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/settings_catalog.dart';
import 'package:mobile/device_link/chats/state.dart';
import 'package:mobile/ui/core/chat/view_models/composer_menu_controller.dart';
import 'package:mobile/ui/core/chat/view_models/composer_plugins_controller.dart';

/// A settings write that failed for the selected chat.
typedef ComputerSettingsFailure = ({
  String message,
  bool reported,
  bool modelChange,
});

/// One chat screen's composer catalogs: the slash commands and the plugin
/// picker's catalog and selections of the shown chat.
abstract interface class ComputerComposerSources implements Listenable {
  /// The sources for the shown chat, or null while it is not ready.
  ({ComposerCommandSource commands, ComposerPluginsSource plugins})? current();
  void dispose();
}

/// Composer settings, catalogs and actions for the selected chat.
abstract interface class ComputerChatComposer {
  /// The settings catalog (Home's new task also reads it).
  DeviceChatSettingsCatalog get settings;

  /// The catalog read's failure, as the composer notice shows it.
  String? get catalogError;

  /// The shown chat may have changed (the host's listener runs while
  /// not restoring a reconnect): read its catalog when its model, harness
  /// or running state did.
  void sync(DeviceChatState? state, {required bool online});

  /// Reads the shown chat's catalog and records its failure.
  Future<void> load();

  /// The connection ended: forget the catalog.
  void invalidate();

  ComputerSettingsFailure? get failure;
  bool get saving;
  bool get refreshing;

  /// Shows [pick] at once and saves it after the picks before it; whether
  /// it was saved for the shown chat.
  Future<bool> change(DeviceChatRef ref, core.SettingsPick pick);

  /// Drops the queued picks (a new tab or selection).
  void invalidatePicks();

  /// Releases picks the chat's revision reached.
  void syncPicks();

  /// The controls for the selected chat, once its frame arrives.
  core.ControlsView? get controls;

  /// The chat's pending questions.
  List<AskUserQuestionState> pendingQuestions(DeviceChatState? state);

  Future<void> answer(
    DeviceChatRef ref,
    String requestId,
    List<AskUserQuestionAnswer> answers,
  );
  Future<void> dismiss(DeviceChatRef ref, String requestId);

  /// Forks [source] at [atMessageId]. Returns true if it was still current
  /// and the core opened the fork.
  Future<bool> fork(DeviceChatRef source, String atMessageId);

  /// The composer catalogs for one chat screen.
  ComputerComposerSources createSources(DeviceChatsViewModel model);
  void dispose();
}
