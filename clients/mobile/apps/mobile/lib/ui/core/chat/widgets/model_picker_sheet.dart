import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/composer/canopy_model_icon.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/model-picker/canopy_model_details.dart';
import 'package:mobile/core/design-system/model-picker/canopy_model_row.dart';
import 'package:mobile/core/design-system/model-picker/canopy_model_tabs.dart';
import 'package:mobile/core/design-system/search-field/canopy_search_field.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/model_routing_availability.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/chat/view_models/model_picker_catalog.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';

/// Tall model picker sheet shared by computer chat and draft composers.
///
/// The search field, Auto row and harness tabs stay fixed while the list
/// scrolls.
/// [data] is observed so a catalog refresh or Retry updates the open sheet.
class ModelPickerSheet extends StatefulWidget {
  const ModelPickerSheet({
    super.key,
    required this.data,
    this.initialTab,
    this.onTabChanged,
  });

  final ValueListenable<ComposerControlsData> data;

  /// The device's remembered tab. A locked chat opens on its harness instead.
  final ModelPickerTab? initialTab;
  final ValueChanged<ModelPickerTab>? onTabChanged;

  @override
  State<ModelPickerSheet> createState() => _ModelPickerSheetState();
}

/// Fits the fixed header and a few rows at 2x text.
const _minContentHeight = 320.0;

class _ModelPickerSheetState extends State<ModelPickerSheet> {
  final _search = TextEditingController();
  final _openLegacy = <String>{};
  ModelPickerTab? _tab;
  String? _explainedId;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  ModelPickerTab _currentTab(
    ComposerControlsData data,
    List<ModelPickerTab> tabs,
  ) {
    final chosen = _tab;
    if (chosen != null && tabs.contains(chosen)) return chosen;
    final locked = data.lockedHarness;
    final opening = locked != null
        ? ModelPickerTab.forHarness(locked)
        : widget.initialTab;
    return opening != null && tabs.contains(opening)
        ? opening
        : ModelPickerTab.all;
  }

  String? _reason(ComposerControlsData data, ModelOption row) =>
      modelRowDisabledReason(
        row,
        availability: data.providerAvailability,
        lockedHarness: data.lockedHarness,
      );

  void _announce(String reason) => unawaited(
    SemanticsService.sendAnnouncement(
      View.of(context),
      reason,
      Directionality.of(context),
    ),
  );

  void _pickAuto(ModelAutoControl auto, ModelAutoRow row) {
    if (!row.selected && row.reason != null) return _announce(row.reason!);
    Navigator.of(context).pop();
    if (!row.selected) auto.onSelect();
  }

  Future<void> _pick(ComposerControlsData data, ModelOption row) async {
    final reason = _reason(data, row);
    if (reason != null) {
      setState(() => _explainedId = row.id);
      _announce(reason);
      return;
    }
    if (row.extraChargeOnly && !await _confirmExtraCharge(row)) return;
    if (!mounted) return;
    Navigator.of(context).pop();
    data.selectModel(row.id);
  }

  Future<bool> _confirmExtraCharge(ModelOption row) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Extra charges may apply'),
        content: Text(
          row.extraChargeMessage ??
              'This model may use paid credits outside your included allowance.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Continue'),
          ),
        ],
      ),
    );
    return confirmed == true;
  }

  void _showDetails(ModelOption row) {
    final harness = modelRowHarness(row);
    final vendor = row.vendor?.trim();
    final reasoning =
        (row.supportedThinkingLevels ?? row.thinkingLevels)?.any(
          (level) => level != 'off',
        ) ??
        false;
    final window = formatModelContextWindow(row.contextWindow);
    final claudePlan =
        !modelUsesAiCredits(row) &&
        row.extraChargeOnly &&
        (row.source ?? row.provider) == 'claude';
    unawaited(
      showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        isScrollControlled: true,
        useSafeArea: true,
        builder: (_) => SingleChildScrollView(
          child: CanopyModelDetails(
            key: ValueKey('model-details-${row.id}'),
            title: row.label,
            facts: [
              (
                'Provider',
                vendor != null && vendor.isNotEmpty
                    ? modelVendorLabel(vendor)
                    : row.familyLabel ?? modelProviderLabel(row.provider),
              ),
              if ((row.source == 'ai-gateway' && row.harness != null) ||
                  harness != modelRowTabHarness(row))
                ('Harness', modelProviderLabel(harness)),
              ('Reasoning', reasoning ? 'Allows reasoning' : 'No reasoning'),
              if (window != null) ('Context', window),
            ],
            description: switch (row.description?.trim()) {
              final text? when text.isNotEmpty => text,
              _ => null,
            },
            footer:
                row.extraChargeMessage ??
                (claudePlan
                    ? 'Depending on your Claude plan, this model may require '
                          'extra usage credits.'
                    : null),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    // A fixed height keeps the sheet top still while the keyboard moves; the
    // keyboard only shortens the list. When a landscape keyboard leaves no room
    // for the fixed header and a few rows, the whole content scrolls instead.
    final height = media.size.height * 0.85;
    return SizedBox(
      height: height,
      child: Padding(
        padding: EdgeInsets.only(bottom: media.viewInsets.bottom),
        child: LayoutBuilder(
          builder: (context, constraints) => SingleChildScrollView(
            primary: false,
            child: SizedBox(
              height: math.max(
                constraints.maxHeight,
                math.min(height, _minContentHeight),
              ),
              child: ValueListenableBuilder<ComposerControlsData>(
                valueListenable: widget.data,
                builder: (context, data, _) => _content(data),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _content(ComposerControlsData data) {
    final rows = data.pickerModels;
    final tabs = modelPickerTabs(rows, data.providerAvailability);
    final tab = _currentTab(data, tabs);
    final searching = _search.text.trim().isNotEmpty;
    final auto = data.auto;
    final autoRow = auto == null || searching
        ? null
        : modelAutoRow(
            selected: auto.selected,
            availability: ModelRoutingAvailability.available,
            rows: rows,
            providerAvailability: data.providerAvailability,
            lockedHarness: data.lockedHarness,
          );
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: CanopySearchField(
            key: const ValueKey('model-picker-search'),
            controller: _search,
            hintText: 'Search models',
            onChanged: (_) => setState(() {}),
          ),
        ),
        if (auto != null && autoRow != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: CanopyModelRow(
              key: const ValueKey('model-picker-auto'),
              vendor: 'auto',
              glyph: CanopyGlyph.sparkle,
              label: 'Auto',
              selected: autoRow.selected,
              enabled: autoRow.selected || autoRow.reason == null,
              explanation: autoRow.reason ?? 'Picks the best model for you',
              onTap: () => _pickAuto(auto, autoRow),
            ),
          ),
        if (!searching && tabs.length > 1)
          CanopyModelTabs(
            tabs: [
              for (final item in tabs)
                CanopyModelTab(
                  key: ValueKey('model-picker-tab-${item.name}'),
                  label: item.label,
                  muted: !modelHarnessConnected(
                    item,
                    data.providerAvailability,
                  ),
                ),
            ],
            selectedIndex: tabs.indexOf(tab),
            onSelected: (index) {
              setState(() => _tab = tabs[index]);
              widget.onTabChanged?.call(tabs[index]);
            },
          ),
        Expanded(
          child: ListView(
            key: const ValueKey('model-picker-list'),
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 24),
            children: searching ? _searchResults(data) : _tabContent(data, tab),
          ),
        ),
      ],
    );
  }

  List<Widget> _searchResults(ComposerControlsData data) {
    final sections = modelPickerSearch(data.pickerModels, _search.text);
    if (sections.isEmpty) return [const _Message(title: 'No models match')];
    return [for (final section in sections) ..._section(data, section)];
  }

  List<Widget> _tabContent(ComposerControlsData data, ModelPickerTab tab) {
    final rows = data.pickerModels;
    final selectable = rows.any((row) => _reason(data, row) == null);
    return [
      if (rows.isEmpty)
        _emptyCatalog(data)
      else if (!selectable && data.catalogStatus == ModelCatalogStatus.loaded)
        _Message(title: 'No models available', detail: data.emptyCatalogHint),
      if (!modelHarnessConnected(tab, data.providerAvailability))
        _Message(
          key: ValueKey('model-picker-connect-${tab.name}'),
          leading: CanopyModelIcon(
            vendor: tab.name,
            size: 24,
            tint: AppColors.of(context).foregroundSecondary,
          ),
          title: modelHarnessConnectHint(tab),
        ),
      for (final section in modelPickerSections(rows, tab))
        ..._section(data, section),
    ];
  }

  Widget _emptyCatalog(ComposerControlsData data) =>
      switch (data.catalogStatus) {
        ModelCatalogStatus.loading => const _Loading(),
        ModelCatalogStatus.failed => _Message(
          title: 'Couldn’t load',
          action: data.onRetryCatalog == null
              ? null
              : CanopyButton(
                  key: const ValueKey('model-picker-retry'),
                  label: 'Retry',
                  variant: CanopyButtonVariant.inline,
                  onPressed: data.onRetryCatalog,
                ),
        ),
        ModelCatalogStatus.loaded => _Message(
          title: 'No models available',
          detail: data.emptyCatalogHint,
        ),
        ModelCatalogStatus.absent => const _Message(
          title: 'No models available yet.',
        ),
      };

  List<Widget> _section(ComposerControlsData data, ModelPickerSection section) {
    final legacyOpen = _openLegacy.contains(section.key);
    return [
      _Heading(section.title),
      for (final row in section.rows) _row(data, row),
      if (section.legacy.isNotEmpty) ...[
        _LegacyToggle(
          key: ValueKey('model-picker-legacy-${section.key}'),
          open: legacyOpen,
          onTap: () => setState(() {
            if (!_openLegacy.remove(section.key)) _openLegacy.add(section.key);
          }),
        ),
        if (legacyOpen)
          for (final row in section.legacy) _row(data, row),
      ],
    ];
  }

  Widget _row(ComposerControlsData data, ModelOption row) {
    final reason = _reason(data, row);
    final vendor = row.vendor?.trim();
    return CanopyModelRow(
      key: ValueKey('model-option-${row.id}'),
      vendor: vendor != null && vendor.isNotEmpty
          ? vendor
          : row.provider == 'ollama'
          ? 'ollama'
          : 'other',
      label: row.label,
      selected: !data.autoSelected && row.id == data.pickerSelectionId,
      enabled: reason == null,
      // A sign-in lock names its remedy in place of the credits tag, like the
      // web picker (CAN-2872).
      tag:
          modelLibraryUnlockLabel(row.unavailableReason) ??
          (modelUsesAiCredits(row) ? CanopyModelRow.aiCreditsTag : null),
      explanation: row.id == _explainedId ? reason : null,
      onTap: () => unawaited(_pick(data, row)),
      onLongPress: () => _showDetails(row),
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.title);

  final String title;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 16, 12, 4),
    child: Semantics(
      header: true,
      child: Text(
        title,
        style: AppTypography.compactLabel.copyWith(
          color: AppColors.of(context).foregroundSecondary,
        ),
      ),
    ),
  );
}

class _LegacyToggle extends StatelessWidget {
  const _LegacyToggle({super.key, required this.open, required this.onTap});

  final bool open;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Semantics(
      button: true,
      expanded: open,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadii.md),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    'Legacy models',
                    style: AppTypography.body.copyWith(
                      color: colors.foregroundSecondary,
                    ),
                  ),
                ),
                CanopyIcon(
                  glyph: open
                      ? CanopyGlyph.chevronTopMedium
                      : CanopyGlyph.chevronDownMedium,
                  size: 20,
                  tint: colors.foregroundSecondary,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({
    super.key,
    required this.title,
    this.detail,
    this.leading,
    this.action,
  });

  final String title;
  final String? detail;
  final Widget? leading;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 20),
      child: Column(
        spacing: 8,
        children: [
          ?leading,
          Text(
            title,
            textAlign: TextAlign.center,
            style: AppTypography.body.copyWith(color: colors.foreground),
          ),
          if (detail case final detail?)
            Text(
              detail,
              textAlign: TextAlign.center,
              style: AppTypography.bodySmall.copyWith(
                color: colors.foregroundSecondary,
              ),
            ),
          ?action,
        ],
      ),
    );
  }
}

/// Placeholder rows while a hosted catalog downloads.
class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) {
    final fill = AppColors.of(context)['bg-secondary'];
    return Semantics(
      liveRegion: true,
      label: 'Loading more models',
      child: Column(
        key: const ValueKey('model-picker-loading'),
        children: [
          for (var index = 0; index < 3; index++)
            Container(
              height: 32,
              margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: fill,
                borderRadius: BorderRadius.circular(AppRadii.md),
              ),
            ),
        ],
      ),
    );
  }
}
