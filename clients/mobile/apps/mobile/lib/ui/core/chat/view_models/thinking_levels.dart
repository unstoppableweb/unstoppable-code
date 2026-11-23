/// Model-aware effort levels for the chat composer.
///
/// A Dart port of the shared model-catalog helpers in
/// `packages/protocol/src/models/index.ts` and
/// `packages/protocol/src/thinking/index.ts`. Remote Control and Computer Connect resolve their levels here, so the level a composer shows is
/// the level it sends.
///
/// Shared with Remote Control. Computer Connect uses the Rust port in
/// cc-domain::composer (selection); keep both in step until cleanup C5.
library;

import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/selection_metadata.dart';
export 'package:mobile/data/models/selection_metadata.dart'
    show kThinkingLevelOrder, providerFallbackThinkingLevels;

/// The effort levels a composer offers for [modelId], in canonical order
/// (`resolveModelCatalogThinkingLevels`).
///
/// 1. The row's declared levels: those of its `harnessChoices` entry for
///    [providerHint], then its `supportedThinkingLevels`, exactly as sent,
///    including an empty set. Without a [modelId] the default row stands in.
/// 2. The row's legacy `thinkingLevels`, also exactly as sent. Unlike the
///    TypeScript helper, an explicit empty legacy set hides effort: absent
///    means fall back, empty means the model does not think.
/// 3. [providerFallbackThinkingLevels] for [providerHint].
///
/// An empty result means the model does not think: hide the control and
/// send no level.
List<String> resolveThinkingLevels(
  List<ModelOption> catalog,
  String? modelId,
  String? providerHint,
) {
  return resolveModelSelectionMetadata(
    catalog: catalog,
    selection: modelId == '' ? null : modelId,
    executionHarness: providerHint,
  ).thinkingLevels;
}

ModelOption? catalogRow(List<ModelOption> catalog, String? modelId) =>
    resolveModelSelectionMetadata(
      catalog: catalog,
      selection: modelId == '' ? null : modelId,
    ).metadataRow;

/// Clamps [level] to the nearest supported level at or below it, so a stored
/// value the active model does not support displays as a real level. If none
/// is at or below it, uses the weakest supported level (or `off` for an empty
/// set). (`clampThinkingLevelToSupported` port.)
String clampThinkingLevelTo(String level, List<String> supported) {
  if (supported.contains(level)) return level;
  final ceiling = kThinkingLevelOrder.indexOf(level);
  for (var i = ceiling - 1; i >= 0; i--) {
    final candidate = kThinkingLevelOrder[i];
    if (supported.contains(candidate)) return candidate;
  }
  for (final candidate in kThinkingLevelOrder) {
    if (supported.contains(candidate)) return candidate;
  }
  return 'off';
}
