import 'package:mobile/data/models/chat_message.dart';

import 'models.dart';

/// A chat's settings catalog as Computer Connect reads it: the models the
/// computer offers, its defaults and the chat's captured runtime, and the
/// existing canonical commands that change the tab. The Dart
/// implementation ([DeviceChatSettings]) and the Rust-backed one both
/// implement it.
abstract interface class DeviceChatSettingsCatalog {
  /// The chat key the catalog was read for.
  String? get scopeKey;
  List<ModelOption> get models;
  ProviderAvailability? get providerAvailability;
  String? get executionHarness;
  String? get modelLabel;
  String? get defaultModelId;
  String? get defaultThinkingLevel;
  bool get modelRoutingSupported;
  bool? get modelHarnessLocked;
  bool get loading;
  bool get loaded;

  /// Reads [ref]'s catalog, or shares the read in flight for it. Throws the
  /// read's failure.
  Future<void> load(DeviceChatRef ref);

  /// `chat.set_model` for [choice] once; the receipt's revision.
  Future<int> selectModel(DeviceChatRef ref, ModelOption choice);

  /// Auto model routing; the receipt's revision.
  Future<int> selectAuto(DeviceChatRef ref);

  /// `chat.patch_tab_settings` once; the receipt's revision.
  Future<int> patch(DeviceChatRef ref, Map<String, dynamic> patch);
}
