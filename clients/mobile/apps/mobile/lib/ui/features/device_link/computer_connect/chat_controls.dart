import 'package:mobile/data/models/agent_model_selection.dart';
import 'dart:async';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/effort_speed.dart';
import 'package:mobile/ui/core/chat/view_models/composer_effort.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';
import '../chats_view_model.dart';

/// The same model picker, effort panel, Plan action and Stop as Remote Control.
ComposerControlsData deviceComposerControls(DeviceChatsViewModel model) {
  final tab = model.composerSettings.tab;
  final ref = model.state?.ref;
  final settings = model.settings;
  final catalog = settings.scopeKey == ref?.key
      ? settings.models
      : const <ModelOption>[];
  final selectedId =
      tab['model'] as String? ??
      (settings.scopeKey == ref?.key ? settings.defaultModelId : null);
  final current = effectiveModelOption(
    catalog,
    selectedId,
    defaultModel: settings.defaultModelId,
    executionHarness:
        (settings.scopeKey == ref?.key ? settings.executionHarness : null) ??
        tab['executionHarness'] as String?,
  );
  final provider = settings.scopeKey == ref?.key
      ? settings.executionHarness
      : null;
  final harness =
      provider ??
      tab['executionHarness'] as String? ??
      current?.harness ??
      tab['providerType'] as String?;
  final lockedHarness = settings.modelHarnessLocked == false ? null : provider;
  final config = tab['modelConfig'] as Map<String, dynamic>?;
  final effort = RemoteComposerEffort.resolve(
    catalog: catalog,
    modelId: selectedId,
    executionHarness: harness,
    providerType: current?.provider ?? tab['providerType'] as String?,
    level:
        config?['thinkingLevel'] as String? ??
        tab['thinkingLevel'] as String? ??
        (settings.scopeKey == ref?.key && selectedId == settings.defaultModelId
            ? settings.defaultThinkingLevel
            : null) ??
        'off',
    speed: config?['speed'] as String?,
    fastMode:
        config?['fastMode'] as bool? ?? tab['codexFastModeEnabled'] as bool?,
  );
  final enabled = model.canChangeSettings;
  Future<bool> changeEffort(String value) async {
    if (ref == null || !enabled) return false;
    return model.changeSetting(
      ref,
      {
        'thinkingLevel': value,
        'modelConfig': {'thinkingLevel': value},
      },
      (tab) => model.settings.patch(ref, {
        'thinkingLevel': value,
        'modelConfig': tab['modelConfig'],
      }),
    );
  }

  return ComposerControlsData(
    providerType: harness,
    executionHarness: provider ?? tab['executionHarness'] as String?,
    modelLabel:
        current?.label ??
        (settings.scopeKey == ref?.key ? settings.modelLabel : null) ??
        selectedId,
    selectedModelId: selectedId,
    availableModels: catalog,
    providerAvailability: settings.scopeKey == ref?.key
        ? settings.providerAvailability
        : null,
    auto:
        settings.scopeKey == ref?.key &&
            settings.modelRoutingSupported &&
            ref != null
        ? ModelAutoControl(
            selected: tab['modelSelectionMode'] == 'auto',
            onSelect: () {
              if (enabled) {
                unawaited(
                  model.changeSetting(ref, {
                    'modelSelectionMode': 'auto',
                  }, (_) => settings.selectAuto(ref)),
                );
              }
            },
          )
        : null,
    // Orchestrator execution forces normal mode on the host.
    planMode:
        ref != null &&
            ref.projectId != 'app-advisor' &&
            (harness == 'claude' || harness == 'codex')
        ? PlanModeControl(
            enabled: tab['planMode'] == true,
            onToggle: () {
              if (enabled) {
                unawaited(
                  model.changeSetting(
                    ref,
                    {'planMode': tab['planMode'] != true},
                    (_) => model.settings.patch(ref, {
                      'planMode': tab['planMode'] != true,
                    }),
                  ),
                );
              }
            },
          )
        : null,
    effort: effort.levels.isEmpty
        ? null
        : EffortControl(
            chatId: ref?.id,
            level: effort.level,
            levels: effort.levels,
            onSelect: changeEffort,
          ),
    speed: effort.speed,
    supportsFastMode: harness == 'codex',
    isRunning: model.state?.running == true,
    onSelectModel: !enabled || ref == null
        ? null
        : (id, {executionHarness}) {
            final choice = selectionModelOption(
              catalog,
              id,
              executionHarness: executionHarness ?? lockedHarness,
            );
            if (choice != null) {
              unawaited(
                model.changeSetting(ref, {
                  'model': choice.id,
                  'providerType': choice.provider,
                  if (choice.harness != null)
                    'executionHarness': choice.harness,
                  'modelSelectionMode': 'manual',
                }, (_) => model.settings.selectModel(ref, choice)),
              );
            }
          },
    onToggleFast: () {
      if (enabled &&
          ref != null &&
          effort.speed != CanopyEffortSpeed.ultraFast) {
        final fast = effort.speed != CanopyEffortSpeed.fast;
        unawaited(
          model.changeSetting(
            ref,
            {
              'codexFastModeEnabled': fast,
              'modelConfig': {
                'speed': fast ? 'fast' : 'standard',
                'fastMode': fast,
              },
            },
            (tab) => model.settings.patch(ref, {
              'codexFastModeEnabled': fast,
              'modelConfig': tab['modelConfig'],
            }),
          ),
        );
      }
    },
    onStop: () {
      if (model.online) unawaited(model.stop());
    },
    catalogStatus: settings.loading
        ? ModelCatalogStatus.loading
        : model.settingsCatalogError != null
        ? ModelCatalogStatus.failed
        : settings.loaded
        ? ModelCatalogStatus.loaded
        : ModelCatalogStatus.absent,
    onRetryCatalog: model.loadSettings,
    // Explicitly unlocked chats may switch; older hosts retain their lock.
    lockedHarness: lockedHarness,
  );
}
