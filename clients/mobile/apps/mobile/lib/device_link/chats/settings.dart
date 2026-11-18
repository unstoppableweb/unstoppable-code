import 'package:mobile/data/models/agent_model_selection.dart';
import 'package:mobile/data/models/chat_message.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';
import 'dto.dart';
import 'models.dart';
import 'model_registry.dart';
import 'default_model.dart';

/// A local refusal or canonical receipt confirms that no settings were applied.
final class DeviceChatSettingsRejected extends DeviceLinkException {
  const DeviceChatSettingsRejected(super.message);
}

final class DeviceChatSettings {
  DeviceChatSettings(this.ipc);
  final DesktopIpc ipc;
  List<ModelOption> models = [];
  ProviderAvailability? providerAvailability;
  String? scopeKey,
      executionHarness,
      modelLabel,
      defaultModelId,
      defaultThinkingLevel;
  bool modelRoutingSupported = false;
  bool? modelHarnessLocked;
  bool loading = false, loaded = false;
  int _generation = 0;
  Future<void>? _read;
  void _clear() {
    models = [];
    providerAvailability = null;
    executionHarness = modelLabel = defaultModelId = defaultThinkingLevel =
        null;
    modelRoutingSupported = loaded = false;
    modelHarnessLocked = null;
  }

  void invalidate() {
    _generation++;
    _read = null;
    loading = false;
    scopeKey = null;
    _clear();
  }

  Future<void> load(DeviceChatRef ref) {
    if (scopeKey == ref.key && _read != null) return _read!;
    if (scopeKey != ref.key) _clear();
    scopeKey = ref.key;
    loading = true;
    final generation = ++_generation;
    late final Future<void> pending;
    pending = _load(ref, generation).whenComplete(() {
      if (identical(_read, pending)) {
        _read = null;
        loading = false;
      }
    });
    _read = pending;
    return pending;
  }

  Future<Map<String, dynamic>?> _projection(DeviceChatRef ref) async {
    try {
      if (ref.projectId == 'app-advisor') {
        return deviceLinkObject(
          deviceChatDto(await ipc.invoke('app-advisor:settings-view')),
        );
      }
      final result = deviceLinkObject(
        deviceChatDto(
          await ipc.invoke('desktop:session-snapshot', [
            {
              'workspaceLocalId': ref.projectId,
              'worktreeLocalId': ref.worktreeId,
              'includeChatSummaries': true,
            },
          ]),
        ),
      );
      final summary = (result['chatSummaries'] as List? ?? const [])
          .whereType<Map<String, dynamic>>()
          .where(
            (row) =>
                row['scope'] == 'worktree' &&
                row['workspaceLocalId'] == ref.projectId &&
                row['worktreeLocalId'] == ref.worktreeId &&
                row['chatId'] == ref.id,
          )
          .firstOrNull;
      return summary ?? (result['availableModels'] is List ? result : null);
    } catch (_) {
      // This optional, existing read must never break older registry-only hosts.
      return null;
    }
  }

  Future<void> _load(DeviceChatRef ref, int generation) async {
    final values = await Future.wait<Object?>([
      ipc.invoke('model-registry:get'),
      _projection(ref),
    ]);
    final response = deviceLinkObject(deviceChatDto(values[0]));
    final projection = values[1] as Map<String, dynamic>?;
    final projectedRows = projection?['availableModels'];
    final next = projectedRows is List
        ? [
            for (final row in projectedRows)
              ModelOption.fromJson(deviceLinkObject(row)),
          ]
        : deviceRegistryModels(response);
    if (next.any((row) => row.id.isEmpty || row.provider.isEmpty)) {
      throw const FormatException('Invalid model catalog');
    }
    final savedDefault = await readDeviceDefaultModel(ipc, ref, response);
    final defaultId =
        next.where((row) => row.isDefault).firstOrNull?.id ??
        savedDefault?.modelId;
    if (generation != _generation) return;
    models = next;
    defaultModelId = next.any((row) => row.id == defaultId) ? defaultId : null;
    defaultThinkingLevel =
        defaultModelId != null && defaultModelId == savedDefault?.modelId
        ? savedDefault?.thinkingLevel
        : null;
    providerAvailability = projection?['providerAvailability'] is Map
        ? ProviderAvailability.fromJson(
            deviceLinkObject(projection!['providerAvailability']),
          )
        : null;
    executionHarness = projection?['executionHarness'] as String?;
    modelLabel = projection?['modelLabel'] as String?;
    modelRoutingSupported = projection?['modelRoutingSupported'] == true;
    modelHarnessLocked = projection?['modelHarnessLocked'] as bool?;
    loaded = true;
  }

  Future<int> command(DeviceChatRef ref, Map<String, dynamic> command) async {
    final response = deviceLinkObject(
      deviceChatDto(
        await ipc.invoke('chat:command', [
          {
            'schemaVersion': 1,
            'commandId': chatId(),
            ...ref.scope,
            'command': command,
          },
        ]),
      ),
    );
    final outcome = response['outcome'];
    if (['conflict', 'not_found', 'rejected'].contains(outcome)) {
      final reason = response['reason'];
      throw DeviceChatSettingsRejected(
        reason is String && reason.trim().isNotEmpty
            ? reason.substring(0, reason.length.clamp(0, 1000))
            : 'The computer could not complete this action. Refresh and try again.',
      );
    }
    if (!['applied', 'already_applied'].contains(outcome)) {
      throw const FormatException('Missing chat outcome');
    }
    final revision = response['revision'];
    if (revision is! int) throw const FormatException('Missing chat revision');
    return revision;
  }

  Future<int> selectModel(DeviceChatRef ref, ModelOption choice) async {
    if (scopeKey != ref.key || !validAgentSelection(models, choice.id)) {
      throw const DeviceChatSettingsRejected(
        'Refresh model choices before selecting a model.',
      );
    }
    return command(ref, {
      'type': 'chat.set_model',
      'tabId': ref.id,
      'model': choice.id,
      'providerType': choice.provider,
      if (choice.harness != null) 'executionHarness': choice.harness,
    });
  }

  Future<int> selectAuto(DeviceChatRef ref) {
    if (scopeKey != ref.key || !modelRoutingSupported) {
      throw const DeviceChatSettingsRejected(
        'Auto is not available for this chat.',
      );
    }
    return patch(ref, {'modelSelectionMode': 'auto'});
  }

  Future<int> patch(DeviceChatRef ref, Map<String, dynamic> patch) => command(
    ref,
    {'type': 'chat.patch_tab_settings', 'tabId': ref.id, 'patch': patch},
  );
}
