/// The composer's plugin catalog and the capability selections it toggles
/// (CAN-3922). Both hosts answer the same shapes: the Remote Control
/// `portal.chat.list_plugin_catalog` result and the computer capability catalog
/// mirror `RemoteControlPluginCatalog`, and both chats store a
/// `RemoteControlChatTabPluginSelections` object.
library;

/// What a catalog row selects, in display order.
enum ComposerPluginKind {
  collection('collectionIds'),
  plugin('pluginRefs'),
  skill('skillRefs'),
  mcpServer('mcpServerRefs');

  const ComposerPluginKind(this.selectionKey);

  /// The selection list that holds this kind's refs.
  final String selectionKey;
}

/// The provider support flag a chat's plugins need.
enum ComposerPluginProvider { claude, codex }

/// The flag a chat on [providerType] needs, as the desktop Plugins modal
/// scopes it (`pluginSelectorScope.ts`): Claude and Ollama chats need a
/// Claude-native plugin and Codex chats one Codex can run. Other providers,
/// and an unknown one, can use every plugin.
ComposerPluginProvider? composerPluginProviderOf(String? providerType) =>
    switch (providerType) {
      'claude' || 'ollama' => ComposerPluginProvider.claude,
      'codex' => ComposerPluginProvider.codex,
      _ => null,
    };

/// One catalog row the user can turn on or off.
final class ComposerPluginItem {
  const ComposerPluginItem({
    required this.kind,
    required this.ref,
    required this.name,
    this.description = '',
    this.claudeSupported,
    this.codexSupported,
  });

  final ComposerPluginKind kind;

  /// The selection ref: `{id}` for a collection, otherwise the ref object
  /// stored in [ComposerPluginKind.selectionKey].
  final Map<String, String> ref;
  final String name;
  final String description;

  /// Whether a Claude or a Codex chat can use this plugin; null when the
  /// catalog does not say, as older ones do not.
  final bool? claudeSupported;
  final bool? codexSupported;

  /// Stable identity, for widget keys.
  String get key => '${kind.name}:${ref.values.join('/')}';

  /// Whether a chat that needs [provider] support can use this item. A
  /// missing flag allows it.
  bool supports(ComposerPluginProvider? provider) => switch (provider) {
    ComposerPluginProvider.claude => claudeSupported ?? true,
    ComposerPluginProvider.codex => codexSupported ?? true,
    null => true,
  };
}

/// The browser-safe catalog grouped by kind. Rows without their selection
/// ids are skipped, so one malformed row does not hide the others.
final class ComposerPluginCatalog {
  const ComposerPluginCatalog({required this.items});

  final List<ComposerPluginItem> items;

  List<ComposerPluginItem> itemsOf(ComposerPluginKind kind) => [
    for (final item in items)
      if (item.kind == kind) item,
  ];

  /// Throws a [FormatException] when [json] is not a catalog object or a
  /// group is not a list. A missing group is empty.
  factory ComposerPluginCatalog.fromJson(Object? json) {
    if (json is! Map<String, dynamic>) {
      throw const FormatException('Missing plugin catalog');
    }
    List<Map<String, dynamic>> rows(String key) {
      final value = json[key];
      if (value == null) return const [];
      if (value is! List) throw FormatException('Invalid plugin catalog $key');
      return [
        for (final row in value)
          if (row is Map<String, dynamic>) row,
      ];
    }

    String? text(Map<String, dynamic> row, String key) => switch (row[key]) {
      final String value when value.isNotEmpty => value,
      _ => null,
    };

    bool? flag(Map<String, dynamic> row, String key) => switch (row[key]) {
      final bool value => value,
      _ => null,
    };

    ComposerPluginItem? item(
      ComposerPluginKind kind,
      Map<String, dynamic> row,
      List<String> refKeys,
      List<String> nameKeys,
    ) {
      final ref = <String, String>{};
      for (final key in refKeys) {
        final value = text(row, key);
        if (value == null) return null;
        ref[key] = value;
      }
      return ComposerPluginItem(
        kind: kind,
        ref: ref,
        name:
            nameKeys.map((key) => text(row, key)).nonNulls.firstOrNull ??
            ref.values.last,
        description: text(row, 'description') ?? '',
        claudeSupported: flag(row, 'claudeSupported'),
        codexSupported: flag(row, 'codexSupported'),
      );
    }

    return ComposerPluginCatalog(
      items: [
        for (final row in rows('collections'))
          ?item(
            ComposerPluginKind.collection,
            row,
            const ['id'],
            const ['name'],
          ),
        for (final row in rows('plugins'))
          ?item(
            ComposerPluginKind.plugin,
            row,
            const ['marketplaceId', 'pluginName'],
            const ['name'],
          ),
        for (final row in rows('skills'))
          ?item(
            ComposerPluginKind.skill,
            row,
            const ['sourceId', 'skillName'],
            const ['name'],
          ),
        for (final row in rows('mcpServers'))
          ?item(
            ComposerPluginKind.mcpServer,
            row,
            const ['serverId', 'configId'],
            const ['serverName', 'configName'],
          ),
      ],
    );
  }
}

/// [selections] with its lists checked and the legacy `bundleIds` alias
/// folded into `collectionIds`. Every other field, such as MCP sign-in
/// preferences, is kept. Throws a [FormatException] when a list is
/// malformed, so a write never drops choices it cannot read.
Map<String, Object?> normalizePluginSelections(
  Map<String, Object?>? selections,
) {
  final next = <String, Object?>{...?selections};
  List<Object?> list(String key) {
    final value = next[key];
    if (value == null) return [];
    if (value is! List) throw FormatException('Invalid $key');
    return List.of(value);
  }

  next['collectionIds'] = {
    ...list('collectionIds'),
    ...list('bundleIds'),
  }.toList();
  next.remove('bundleIds');
  next['skillRefs'] = list('skillRefs');
  next['pluginRefs'] = list('pluginRefs');
  if (next.containsKey('mcpServerRefs')) {
    next['mcpServerRefs'] = list('mcpServerRefs');
  }
  return next;
}

/// Whether [refs] holds a ref with every field of [ref].
bool selectionRefsName(List<Object?> refs, Map<String, String> ref) => refs.any(
  (entry) =>
      entry is Map &&
      ref.entries.every((field) => entry[field.key] == field.value),
);

bool _holds(List<Object?> list, ComposerPluginItem item) =>
    item.kind == ComposerPluginKind.collection
    ? list.contains(item.ref['id'])
    : selectionRefsName(list, item.ref);

/// Whether [selections] selects [item].
bool pluginSelectionsContain(
  Map<String, Object?>? selections,
  ComposerPluginItem item,
) => _holds(
  normalizePluginSelections(selections)[item.kind.selectionKey]
          as List<Object?>? ??
      const [],
  item,
);

/// [selections] with [item] turned [on] or off and every other choice kept.
Map<String, Object?> withPluginSelection(
  Map<String, Object?>? selections,
  ComposerPluginItem item, {
  required bool on,
}) {
  final next = normalizePluginSelections(selections);
  final key = item.kind.selectionKey;
  final list = next[key] as List<Object?>? ?? [];
  final value = item.kind == ComposerPluginKind.collection
      ? item.ref['id']
      : item.ref;
  if (on) {
    next[key] = _holds(list, item) ? list : [...list, value];
  } else {
    next[key] = [
      for (final entry in list)
        if (!_holds([entry], item)) entry,
    ];
  }
  return next;
}

/// The explicit choices in [selections], counted the way the web picker's
/// `countRemoteControlPluginSelections` counts them; null when a list is malformed,
/// so a bad projection shows no count instead of failing.
int? countPluginSelections(Map<String, Object?> selections) {
  final Map<String, Object?> normalized;
  try {
    normalized = normalizePluginSelections(selections);
  } on FormatException {
    return null;
  }
  return [
    for (final kind in ComposerPluginKind.values)
      (normalized[kind.selectionKey] as List<Object?>? ?? const []).length,
  ].fold<int>(0, (sum, count) => sum + count);
}
