import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'dart:async';
import 'package:mobile/data/models/effort_speed.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';
import '../chats_view_model.dart';
import 'rust/rust_composer.dart';
import 'rust/same_name.dart';

/// The same model picker, effort panel, Plan action and Stop as Remote Control.
ComposerControlsData deviceComposerControls(DeviceChatsViewModel model) {
  if (model.composer.controls case final controls?) {
    return _coreControls(model, controls);
  }
  return ComposerControlsData(
    providerType: null,
    modelLabel: null,
    selectedModelId: null,
    availableModels: const [],
    providerAvailability: null,
    effort: null,
    speed: CanopyEffortSpeed.regular,
    supportsFastMode: false,
    isRunning: model.state?.running == true,
    onSelectModel: null,
    onToggleFast: () {},
    catalogStatus: ModelCatalogStatus.absent,
    onStop: () {
      if (model.online) unawaited(model.stop());
    },
    onRetryCatalog: model.loadSettings,
  );
}

/// The controls the core computed (P5c), with the screen's callbacks.
ComposerControlsData _coreControls(
  DeviceChatsViewModel model,
  core.ControlsView c,
) {
  final ref = model.state?.ref;
  final enabled = model.canChangeSettings;
  final speed = sameName(CanopyEffortSpeed.values, c.speed);
  return ComposerControlsData(
    providerType: c.providerType,
    executionHarness: c.executionHarness,
    modelLabel: c.modelLabel,
    selectedModelId: c.selectedModelId,
    availableModels: modelOptions(c.models),
    providerAvailability: availabilityOf(c.providerAvailability),
    auto: switch (c.auto) {
      final selected? when ref != null => ModelAutoControl(
        selected: selected,
        onSelect: () {
          if (enabled) {
            unawaited(model.changeSetting(ref, const core.SettingsPick.auto()));
          }
        },
      ),
      _ => null,
    },
    planMode: switch (c.planMode) {
      final on? when ref != null => PlanModeControl(
        enabled: on,
        onToggle: () {
          if (enabled) {
            unawaited(
              model.changeSetting(
                ref,
                core.SettingsPick.planMode(enabled: !on),
              ),
            );
          }
        },
      ),
      _ => null,
    },
    effort: c.effortLevels.isEmpty
        ? null
        : EffortControl(
            chatId: ref?.id,
            level: c.effortLevel,
            levels: c.effortLevels,
            onSelect: (value) async {
              if (ref == null || !enabled) return false;
              return model.changeSetting(
                ref,
                core.SettingsPick.effort(level: value),
              );
            },
          ),
    speed: speed,
    supportsFastMode: c.supportsFastMode,
    isRunning: model.state?.running == true,
    onSelectModel: !enabled || ref == null
        ? null
        : (id, {executionHarness}) => unawaited(
            model.changeSetting(
              ref,
              core.SettingsPick.model(
                id: id,
                executionHarness: executionHarness,
              ),
            ),
          ),
    onToggleFast: () {
      if (enabled && ref != null && speed != CanopyEffortSpeed.ultraFast) {
        unawaited(
          model.changeSetting(
            ref,
            core.SettingsPick.fast(fast: speed != CanopyEffortSpeed.fast),
          ),
        );
      }
    },
    onStop: () {
      if (model.online) unawaited(model.stop());
    },
    catalogStatus: sameName(ModelCatalogStatus.values, c.catalogStatus),
    onRetryCatalog: model.loadSettings,
    lockedHarness: c.lockedHarness,
  );
}
