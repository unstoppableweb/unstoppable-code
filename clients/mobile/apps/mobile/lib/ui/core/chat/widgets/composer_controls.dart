import 'package:mobile/data/models/selection_metadata.dart';
import 'package:mobile/data/models/agent_model_selection.dart';
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_control.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_control.dart';
import 'package:mobile/core/design-system/composer/canopy_model_icon.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/model_picker_tab_store.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/chat/view_models/model_picker_catalog.dart';
import 'package:mobile/ui/core/chat/widgets/model_picker_sheet.dart';
import 'package:provider/provider.dart';

/// The plan-mode toggle, when the host supports it (Remote Control worktree
/// chats persist it through `portal.chat.set_plan_mode`; standalone
/// chats have no plan mode and pass null, which hides the chip).
class PlanModeControl {
  const PlanModeControl({required this.enabled, required this.onToggle});

  final bool enabled;
  final VoidCallback onToggle;
}

/// The effort levels the selected model offers. Hosts pass null when the
/// model does not think, which hides the control and `/thinking`.
class EffortControl {
  const EffortControl({
    required this.level,
    required this.levels,
    required this.onSelect,
    this.chatId,
  });

  /// The shown level: the chat's level clamped to [levels].
  final String level;

  /// The model's levels, weakest first; never empty.
  final List<String> levels;

  /// Completes with whether the host kept the level.
  final Future<bool> Function(String level) onSelect;

  /// The chat that [onSelect] changes, when the screen can show another chat
  /// under an open sheet. Null when [onSelect] always changes the same chat.
  final String? chatId;
}

/// Auto model routing, offered when the host and its transport support it.
/// Auto is a selection mode: the selected model stays the concrete fallback.
class ModelAutoControl {
  const ModelAutoControl({required this.selected, required this.onSelect});

  final bool selected;
  final VoidCallback onSelect;
}

/// What the host knows about its model catalog.
enum ModelCatalogStatus {
  /// The host has not projected a catalog (older or unhydrated host).
  absent,

  /// A hosted catalog is downloading.
  loading,

  /// A hosted catalog failed to download.
  failed,

  /// The host projected a catalog, which may be empty.
  loaded,
}

/// Immutable snapshot of the composer's control state + callbacks for one
/// resolved chat. Built by the owning screen (which owns any optimistic
/// overrides) and rendered by [ComposerToolbar].
class ComposerControlsData {
  const ComposerControlsData({
    required this.providerType,
    required this.modelLabel,
    required this.selectedModelId,
    required this.availableModels,
    required this.providerAvailability,
    this.planMode,
    required this.effort,
    required this.speed,
    required this.supportsFastMode,
    required this.isRunning,
    required this.onSelectModel,
    required this.onToggleFast,
    required this.onStop,
    required this.catalogStatus,
    this.onRetryCatalog,
    this.emptyCatalogHint,
    this.executionHarness,
    this.lockedHarness,
    this.auto,
  });

  /// Icon hint for the model control when no catalog row matches.
  final String? providerType;
  final String? modelLabel;

  /// The model the chat uses, including a default that the host resolves.
  /// [effort] follows this model.
  final String? selectedModelId;
  final List<ModelOption> availableModels;
  final ProviderAvailability? providerAvailability;
  final PlanModeControl? planMode;
  final EffortControl? effort;

  /// The chat's speed. Ultra fast is shown read-only: no mobile host can set
  /// it, so Fast mode cannot be toggled from it.
  final CanopyEffortSpeed speed;

  /// Whether Fast mode is offered at all. Hosts decide: Remote Control
  /// passes `providerType == 'codex'`, mirroring the web composer.
  final bool supportsFastMode;
  final bool isRunning;

  /// Null holds the selection: the model chip is disabled.
  final void Function(String model, {String? executionHarness})? onSelectModel;

  final VoidCallback onToggleFast;
  final VoidCallback onStop;
  final ModelCatalogStatus catalogStatus;

  /// Retries a failed hosted catalog download; null when the host cannot.
  final VoidCallback? onRetryCatalog;

  /// Optional subtitle for a projected catalog with no selectable model.
  final String? emptyCatalogHint;

  /// Captured harness for current-selection metadata, even when unlocked.
  final String? executionHarness;

  /// The harness a started chat runs on; rows of other harnesses explain the
  /// lock instead of switching. Null when the chat can still change harness.
  final String? lockedHarness;

  /// Null hides Auto: the host or its transport cannot route.
  final ModelAutoControl? auto;

  String? get pickerSelectionId => modelPickerSelectionId(selectedModelId);

  ModelOption? get pickerSelection =>
      availableModels.where((row) => row.id == pickerSelectionId).firstOrNull;

  List<ModelOption> get pickerModels => availableModels.map((row) {
    final next = resolveModelSelectionMetadata(
      catalog: availableModels,
      selection: row.id,
    );
    final harness = modelCandidateHarness(
      next.modelRow ?? row,
      _selectionHarness(row.id),
    );
    final support =
        next.agentRow?.agentSelection?.supportedModels[next.concreteModelId];
    return row.forExecution(
      selection: row.id,
      executionHarness: support == null || support.contains(harness)
          ? harness
          : null,
    );
  }).toList();

  // Preserve the captured runtime only when the next Agent can also use it.
  String? _selectionHarness(String? selection) {
    if (lockedHarness != null) return lockedHarness;
    final next = resolveModelSelectionMetadata(
      catalog: availableModels,
      selection: selection,
    );
    if (next.concreteModelId == null ||
        next.concreteModelId !=
            effectiveAgentModel(availableModels, selectedModelId)) {
      return null;
    }
    final support =
        next.agentRow?.agentSelection?.supportedModels[next.concreteModelId];
    if (support != null && !support.contains(executionHarness)) return null;
    final row = next.modelRow;
    return row == null ? null : modelCandidateHarness(row, executionHarness);
  }

  void selectModel(String selection) {
    final choice = selectionModelOption(
      availableModels,
      selection,
      executionHarness: _selectionHarness(selection),
    );
    onSelectModel?.call(selection, executionHarness: choice?.harness);
  }

  bool get autoSelected => auto?.selected ?? false;

  /// Whether Fast mode can be toggled now.
  bool get canToggleFast =>
      supportsFastMode && speed != CanopyEffortSpeed.ultraFast;

  ModelOption? get selectedModel => resolveModelSelectionMetadata(
    catalog: availableModels,
    selection: selectedModelId,
    executionHarness: executionHarness ?? lockedHarness,
  ).metadataRow;

  /// `$` commands follow the execution harness, including gateway models
  /// whose provider differs from the harness that runs them.
  bool get supportsDollarCommands =>
      (executionHarness ??
          lockedHarness ??
          selectedModel?.harness ??
          providerType) ==
      'codex';

  /// The selected model left a loaded catalog.
  bool get selectionRetired =>
      !autoSelected &&
      catalogStatus == ModelCatalogStatus.loaded &&
      pickerSelectionId != null &&
      pickerSelection == null;
}

/// Opens the model picker over [data], as the model chip and `/model` do.
/// The sheet observes [data], so a catalog that arrives while it is open
/// updates it.
Future<void> showComposerModelPicker(
  BuildContext context,
  ValueListenable<ComposerControlsData> data,
) async {
  final store = Provider.of<ModelPickerTabStore?>(context, listen: false);
  final stored = ModelPickerTab.fromName(await store?.read());
  if (!context.mounted) return;
  await showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => ModelPickerSheet(
      data: data,
      initialTab: stored,
      onTabChanged: (tab) => unawaited(store?.write(tab.name)),
    ),
  );
}

/// Opens the Effort sheet over [data], as the effort control and `/thinking`
/// do. The sheet observes [data], so it shows the host's latest level and
/// speed, and it closes if the model stops offering effort.
Future<void> showComposerEffortSheet(
  BuildContext context,
  ValueListenable<ComposerControlsData?> data,
) => showModalBottomSheet<void>(
  context: context,
  showDragHandle: true,
  isScrollControlled: true,
  useSafeArea: true,
  builder: (_) => ValueListenableBuilder<ComposerControlsData?>(
    valueListenable: data,
    builder: (context, data, _) {
      final effort = data?.effort;
      if (data == null || effort == null) {
        SchedulerBinding.instance.addPostFrameCallback((_) {
          final route = context.mounted ? ModalRoute.of(context) : null;
          if (route != null && route.isCurrent) Navigator.of(context).pop();
        });
        return const SizedBox.shrink();
      }
      return SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 0, 8, 16),
          // A drag belongs to the chat and model it started on. Another chat
          // or model gets a new panel, so the old drag's release sends
          // nothing.
          child: KeyedSubtree(
            key: ValueKey((effort.chatId, data.selectedModelId)),
            child: CanopyEffortPanel(
              key: const ValueKey('composer-effort-sheet'),
              level: effort.level,
              levels: effort.levels,
              onSelect: effort.onSelect,
              speed: data.supportsFastMode ? data.speed : null,
              onToggleFast: data.canToggleFast ? data.onToggleFast : null,
            ),
          ),
        ),
      );
    },
  ),
);

/// Mirrors [value] into a listenable for routes such as sheets, which then
/// show the host's latest data. Updates land after the frame that builds
/// them, because those routes are built separately.
class ComposerLiveData<T> extends StatefulWidget {
  const ComposerLiveData({
    super.key,
    required this.value,
    required this.builder,
  });

  final T value;
  final Widget Function(BuildContext context, ValueListenable<T> live) builder;

  @override
  State<ComposerLiveData<T>> createState() => _ComposerLiveDataState<T>();
}

class _ComposerLiveDataState<T> extends State<ComposerLiveData<T>> {
  late final ValueNotifier<T> _live = ValueNotifier(widget.value);

  @override
  void didUpdateWidget(ComposerLiveData<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    SchedulerBinding.instance.addPostFrameCallback((_) {
      if (mounted) _live.value = widget.value;
    });
  }

  @override
  void dispose() {
    _live.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(context, _live);
}

/// Compact, independent model and effort controls.
class ComposerToolbar extends StatelessWidget {
  const ComposerToolbar({super.key, required this.data});

  final ComposerControlsData data;

  /// What the model control keeps when the row is short of room: its glyph
  /// and the gap after it.
  static const double _modelMinWidth = 36;

  @override
  Widget build(BuildContext context) => ComposerLiveData<ComposerControlsData>(
    value: data,
    builder: (context, live) => LayoutBuilder(
      builder: (context, constraints) => _toolbar(context, live, constraints),
    ),
  );

  Widget _toolbar(
    BuildContext context,
    ValueListenable<ComposerControlsData> live,
    BoxConstraints constraints,
  ) {
    final colors = AppColors.of(context);
    final selected = data.pickerSelection;
    // The model label shrinks first. Effort keeps its full name unless the
    // row cannot fit it even then.
    final effortMaxWidth = constraints.maxWidth - _modelMinWidth;
    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      spacing: 4,
      children: [
        Flexible(
          fit: FlexFit.loose,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 160),
            child: CanopyComposerControl(
              key: const ValueKey('composer-model'),
              glyph: CanopyGlyph.agent,
              leading: data.autoSelected
                  ? CanopyIcon(
                      glyph: CanopyGlyph.sparkle,
                      size: 16,
                      tint: colors.foregroundSecondary,
                    )
                  : CanopyModelIcon(
                      vendor: selected == null
                          ? data.providerType ?? 'other'
                          : _modelVendor(selected),
                      tint: colors.foregroundSecondary,
                    ),
              label: data.autoSelected
                  ? 'Auto'
                  : data.selectionRetired
                  ? 'Model no longer available'
                  : selected?.label ??
                        (selectedAgentId(data.selectedModelId) == null
                            ? data.modelLabel
                            : null) ??
                        'Model',
              onTap: data.onSelectModel == null
                  ? null
                  : () => unawaited(showComposerModelPicker(context, live)),
            ),
          ),
        ),
        if (data.effort case final effort?)
          ConstrainedBox(
            constraints: BoxConstraints(maxWidth: effortMaxWidth),
            child: CanopyEffortTrigger(
              key: const ValueKey('composer-thinking'),
              level: effort.level,
              speed: data.supportsFastMode
                  ? data.speed
                  : CanopyEffortSpeed.regular,
              onTap: () => unawaited(showComposerEffortSheet(context, live)),
            ),
          ),
      ],
    );
  }
}

String _modelVendor(ModelOption model) {
  final vendor = model.vendor?.trim();
  return vendor != null && vendor.isNotEmpty
      ? vendor
      : model.provider == 'ollama'
      ? 'ollama'
      : 'other';
}
