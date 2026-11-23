/// Shared with Remote Control. Computer Connect uses the Rust port in
/// cc-domain::composer (picker); keep both in step until cleanup C5.
library;

import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/model_routing_availability.dart';

/// Pure model-picker policy, mirroring the desktop composer picker
/// (`ModelPickerMenu` harness browser): tabs, vendor sections, Legacy
/// partitioning, fuzzy search and row explanations. Widgets only render it.

/// Harness tabs, in desktop rail order after All models.
enum ModelPickerTab {
  all('All models'),
  claude('Claude'),
  codex('Codex'),
  cursor('Cursor'),
  ollama('Ollama'),
  other('Other models');

  const ModelPickerTab(this.label);

  final String label;

  /// The tab for a harness or provider id; unknown ids belong to Other.
  static ModelPickerTab forHarness(String? harness) => switch (harness) {
    'claude' => claude,
    'codex' => codex,
    'cursor' => cursor,
    'ollama' => ollama,
    _ => other,
  };

  static ModelPickerTab? fromName(String? name) =>
      values.where((tab) => tab.name == name).firstOrNull;
}

/// One titled group of rows. [legacy] rows sit in a collapsed group at the end.
class ModelPickerSection {
  const ModelPickerSection({
    required this.key,
    required this.title,
    required this.rows,
    this.legacy = const [],
  });

  final String key;
  final String title;
  final List<ModelOption> rows;
  final List<ModelOption> legacy;
}

const _vendorLabels = {
  'anthropic': 'Claude',
  'claude': 'Claude',
  'openai': 'OpenAI',
  'codex': 'OpenAI',
  'ollama': 'Ollama',
  'deepseek': 'DeepSeek',
  'moonshotai': 'Moonshot AI',
  'zai': 'Z.ai',
  'minimax': 'MiniMax',
  'google': 'Google',
  'meta': 'Meta',
  'mistral': 'Mistral',
  'xai': 'xAI',
  'qwen': 'Qwen',
};

/// Desktop vendor heading. The ticket shows Anthropic as Claude.
String modelVendorLabel(String vendor) {
  final normalized = vendor.trim().toLowerCase();
  if (normalized.isEmpty) return 'Other';
  return _vendorLabels[normalized] ??
      '${normalized[0].toUpperCase()}${normalized.substring(1)}';
}

/// Desktop provider (harness) label.
String modelProviderLabel(String provider) => switch (provider) {
  'claude' => 'Claude',
  'codex' => 'Codex',
  'ollama' => 'Ollama',
  'cursor' => 'Cursor',
  'opencode' => 'OpenCode',
  'copilot' => 'GitHub Copilot',
  _ => 'Model',
};

/// Desktop compact context window: `200K`, `1M`, `1.5M`.
String? formatModelContextWindow(int? tokens) {
  if (tokens == null || tokens <= 0) return null;
  String compact(double value, String suffix) {
    final rounded = (value * 10).round() / 10;
    return rounded == rounded.roundToDouble()
        ? '${rounded.toInt()}$suffix'
        : '$rounded$suffix';
  }

  if (tokens >= 1000000) return compact(tokens / 1000000, 'M');
  if (tokens >= 1000) return compact(tokens / 1000, 'K');
  return '$tokens';
}

/// Rows billed to AI Credits carry the `AI credits` tag.
bool modelUsesAiCredits(ModelOption row) => row.source == 'ai-gateway';

/// The harness that runs [row]: its declared harness, else its source, else
/// its provider.
String modelRowHarness(ModelOption row) {
  final source = row.source;
  return row.harness ??
      (source != null && source != 'ai-gateway' ? source : row.provider);
}

/// A captured runtime describes the selected chat, not every candidate model.
String? modelCandidateHarness(ModelOption row, String? lockedHarness) =>
    lockedHarness != null &&
        (modelRowHarness(row) == lockedHarness ||
            row.harnessProviders.containsKey(lockedHarness))
    ? lockedHarness
    : null;

/// The harness id that owns [row]'s tab. Like desktop, a native catalog source
/// keeps its tab even when another harness runs the row.
String modelRowTabHarness(ModelOption row) => switch (row.source) {
  'ai-gateway' => modelRowHarness(row),
  final String source => source,
  null => row.provider,
};

/// The tab that owns [row].
ModelPickerTab modelRowTab(ModelOption row) =>
    ModelPickerTab.forHarness(modelRowTabHarness(row));

/// Whether [harness] is connected on the host. Cursor is a managed runtime
/// that must be confirmed; the others are optimistic when unknown.
bool modelHarnessConnected(
  ModelPickerTab tab,
  ProviderAvailability? availability,
) => switch (tab) {
  ModelPickerTab.claude => availability?.claude ?? true,
  ModelPickerTab.codex => availability?.codex ?? true,
  ModelPickerTab.ollama => availability?.ollama ?? true,
  ModelPickerTab.cursor => availability?.cursor ?? false,
  ModelPickerTab.all || ModelPickerTab.other => true,
};

/// Disconnected-harness guidance, adapted from the web Portal picker.
String modelHarnessConnectHint(ModelPickerTab tab) =>
    'Connect ${tab.label} in the desktop app to use it here.';

/// The tabs to show: All, then tabs with rows or a known disconnected state.
/// Connected tabs come first; disconnected tabs come last.
List<ModelPickerTab> modelPickerTabs(
  List<ModelOption> rows,
  ProviderAvailability? availability,
) {
  final populated = {for (final row in rows) modelRowTab(row)};
  final candidates = [
    for (final tab in ModelPickerTab.values.skip(1))
      if (populated.contains(tab) || _reportedDisconnected(tab, availability))
        tab,
  ];
  return [
    ModelPickerTab.all,
    ...candidates.where((tab) => modelHarnessConnected(tab, availability)),
    ...candidates.where((tab) => !modelHarnessConnected(tab, availability)),
  ];
}

/// The host explicitly reported [tab]'s harness as not connected.
bool _reportedDisconnected(
  ModelPickerTab tab,
  ProviderAvailability? availability,
) => switch (tab) {
  ModelPickerTab.claude => availability?.claude == false,
  ModelPickerTab.codex => availability?.codex == false,
  ModelPickerTab.ollama => availability?.ollama == false,
  ModelPickerTab.cursor => availability?.cursor == false,
  ModelPickerTab.all || ModelPickerTab.other => false,
};

/// Why [row] cannot be picked, or null when it can.
String? modelRowDisabledReason(
  ModelOption row, {
  required ProviderAvailability? availability,
  required String? lockedHarness,
}) {
  final tab = modelRowTab(row);
  if (tab == ModelPickerTab.cursor &&
      !modelHarnessConnected(tab, availability)) {
    return modelHarnessConnectHint(tab);
  }
  // Copilot rows sit under Other models; like the web Portal picker, they
  // need the host to confirm that Copilot is connected.
  if ([row.provider, row.harness, row.source].contains('copilot') &&
      !(availability?.isAvailable('copilot') ?? false)) {
    return 'Connect Copilot in the desktop app to use it here.';
  }
  if (row.kind == 'agent' && !row.available) {
    return 'This agent is unavailable — its base model is not registered on '
        'the desktop app.';
  }
  final harness = modelRowHarness(row);
  if (lockedHarness != null && harness != lockedHarness) {
    return 'This chat is running on ${modelProviderLabel(lockedHarness)}. '
        'Start a new chat to use ${modelProviderLabel(harness)} models.';
  }
  final signedIn = switch (row.provider) {
    'claude' => availability?.claude,
    'codex' => availability?.codex,
    'ollama' => availability?.ollama,
    _ => null,
  };
  if (row.source != 'ai-gateway' && signedIn == false) {
    return '${modelProviderLabel(row.provider)} is not signed in on the '
        'desktop app.';
  }
  if (modelLibraryUnlockHint(row.unavailableReason) case final hint?) {
    return hint;
  }
  if (!row.available) return 'This model is unavailable.';
  return null;
}

/// The server's model library access (`CloudModelCatalog.modelLibrary`) when
/// it locks models until the user signs in (CAN-2872); null otherwise. A
/// purchase-only lock is not one: mobile has no purchase flow.
String? modelLibrarySignInLock(String? access) => switch (access) {
  'needs_sign_in' || 'needs_sign_in_then_purchase' => access,
  _ => null,
};

/// The visible remedy on a sign-in-locked row, in place of its credits tag,
/// like the web picker's `modelLibraryUnlockLabel`; null for anything else.
String? modelLibraryUnlockLabel(String? lock) =>
    modelLibraryUnlockHint(lock) == null ? null : 'Sign in';

/// The row hint for a sign-in lock, worded like the web and desktop pickers'
/// `modelLibraryUnlockHint`; null for anything else.
String? modelLibraryUnlockHint(String? lock) => switch (lock) {
  'needs_sign_in' => 'Unlock with sign-in',
  'needs_sign_in_then_purchase' => 'Unlock with sign-in and a credits purchase',
  _ => null,
};

/// The picker's Auto row: whether it is selected and why it cannot be picked.
typedef ModelAutoRow = ({bool selected, String? reason});

/// The Auto row for a host that supports Auto, or null when it is hidden.
/// Mirrors the desktop and web pickers: a chat already in Auto keeps its row,
/// and fewer than two pickable models (Agents excluded) make Auto pointless.
ModelAutoRow? modelAutoRow({
  required bool selected,
  required ModelRoutingAvailability availability,
  required List<ModelOption> rows,
  required ProviderAvailability? providerAvailability,
  required String? lockedHarness,
}) {
  if (availability == ModelRoutingAvailability.hidden) {
    return selected ? (selected: true, reason: null) : null;
  }
  final candidates = rows.where(
    (row) =>
        row.kind != 'agent' &&
        modelRowDisabledReason(
              row,
              availability: providerAvailability,
              lockedHarness: lockedHarness,
            ) ==
            null,
  );
  return (
    selected: selected,
    reason: switch (availability) {
      ModelRoutingAvailability.loading => 'Checking credits…',
      ModelRoutingAvailability.noCredits => 'Runs on credits',
      _ when candidates.length < 2 => 'Needs two or more models',
      _ => null,
    },
  );
}

/// Sections for [tab] when not searching. Agents come first; a harness tab
/// keeps only its own Agents, like the desktop `sectionsForHarness`.
List<ModelPickerSection> modelPickerSections(
  List<ModelOption> rows,
  ModelPickerTab tab,
) {
  final shown = tab == ModelPickerTab.all
      ? rows
      : rows.where((row) => modelRowTab(row) == tab).toList();
  final agents = shown.where((row) => row.kind == 'agent').toList();
  final models = shown.where((row) => row.kind != 'agent').toList();
  final sections = <ModelPickerSection>[
    if (agents.isNotEmpty)
      ModelPickerSection(key: 'agents', title: 'Agents', rows: _sorted(agents)),
  ];
  if (tab == ModelPickerTab.all) return sections..addAll(_byVendor(models));
  final native = tab == ModelPickerTab.other
      ? models
      : models
            .where((row) => (row.source ?? row.provider) == tab.name)
            .toList();
  final borrowed = models.where((row) => !native.contains(row)).toList();
  sections.addAll(_byVendor(native));
  if (borrowed.isNotEmpty) {
    sections.add(
      _section('other-supported', 'Other supported models', borrowed),
    );
  }
  return sections;
}

/// Search results grouped by harness tab. Empty when nothing matches.
List<ModelPickerSection> modelPickerSearch(
  List<ModelOption> rows,
  String query,
) {
  final scored =
      <(ModelOption, double)>[
        for (final row in rows)
          if (fuzzyModelScore(row, query) case final score when score.isFinite)
            (row, score),
      ]..sort((a, b) {
        final byScore = a.$2.compareTo(b.$2);
        return byScore != 0 ? byScore : a.$1.label.compareTo(b.$1.label);
      });
  return [
    for (final tab in ModelPickerTab.values.skip(1))
      if (scored.where((entry) => modelRowTab(entry.$1) == tab).toList()
          case final matches when matches.isNotEmpty)
        ModelPickerSection(
          key: 'search-${tab.name}',
          title: tab.label,
          rows: [for (final entry in matches) entry.$1],
        ),
  ];
}

/// Desktop fuzzy score over label, id and vendor: lower is better, and
/// infinity means no match. A contiguous match scores its index; otherwise an
/// in-order subsequence scores 100 plus its gaps.
double fuzzyModelScore(ModelOption row, String query) {
  final needle = query.trim().toLowerCase();
  if (needle.isEmpty) return 0;
  final haystack = '${row.label} ${row.id} ${row.vendor ?? ''}'.toLowerCase();
  final contiguous = haystack.indexOf(needle);
  if (contiguous >= 0) return contiguous.toDouble();
  var cursor = 0;
  var gaps = 0;
  for (final char in needle.split('')) {
    final found = haystack.indexOf(char, cursor);
    if (found < 0) return double.infinity;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return 100.0 + gaps;
}

/// Desktop section key: Cursor and Ollama keep their own heading; other rows
/// group by declared vendor, and undeclared vendors go to Other models.
(String, String) _sectionOf(ModelOption row) {
  if (row.provider == 'cursor' &&
      (row.source == null || row.source == 'cursor')) {
    return ('provider:cursor', 'Cursor');
  }
  final vendor = row.vendor?.trim().toLowerCase() ?? '';
  if (vendor.isNotEmpty) return ('vendor:$vendor', modelVendorLabel(vendor));
  if (row.provider == 'ollama') return ('provider:ollama', 'Ollama');
  return ('vendor:unclaimed', 'Other models');
}

List<ModelPickerSection> _byVendor(List<ModelOption> rows) {
  final grouped = <(String, String), List<ModelOption>>{};
  for (final row in rows) {
    grouped.putIfAbsent(_sectionOf(row), () => []).add(row);
  }
  final sections = [
    for (final MapEntry(key: (key, title), value: members) in grouped.entries)
      _section(key, title, members),
  ];
  sections.sort((a, b) {
    final byOrder = _minOrder(a).compareTo(_minOrder(b));
    return byOrder != 0 ? byOrder : a.title.compareTo(b.title);
  });
  return sections;
}

ModelPickerSection _section(String key, String title, List<ModelOption> rows) {
  final sorted = _sorted(rows);
  return ModelPickerSection(
    key: key,
    title: title,
    rows: sorted.where((row) => !row.showMoreOnly).toList(growable: false),
    legacy: sorted.where((row) => row.showMoreOnly).toList(growable: false),
  );
}

double _order(ModelOption row) => row.sortOrder ?? double.maxFinite;

double _minOrder(ModelPickerSection section) => [
  ...section.rows,
  ...section.legacy,
].map(_order).fold(double.maxFinite, (a, b) => a < b ? a : b);

List<ModelOption> _sorted(List<ModelOption> rows) => [...rows]
  ..sort((a, b) {
    final byOrder = _order(a).compareTo(_order(b));
    return byOrder != 0 ? byOrder : a.label.compareTo(b.label);
  });
