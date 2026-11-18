import 'selection_metadata.dart';
import 'agent_catalog_selection.dart';
import 'chat_message.dart';

final _agentId = RegExp(r'^agent_model_[a-z0-9]+(?:_[a-z0-9]+)*$');
String? selectedAgentId(String? selection) {
  if (selection == null) return null;
  final separator = selection.indexOf('@');
  final id = separator < 0 ? selection : selection.substring(0, separator);
  if (!_agentId.hasMatch(id)) return null;
  if (separator >= 0) {
    final model = selection.substring(separator + 1);
    if (model.isEmpty ||
        model == 'default' ||
        model.startsWith('agent_model_')) {
      return null;
    }
  }
  return id;
}

String? explicitAgentModel(String? selection) {
  if (selectedAgentId(selection) == null || !selection!.contains('@')) {
    return null;
  }
  final model = selection.substring(selection.indexOf('@') + 1);
  return AgentCatalogSelection.concrete(model) ? model : null;
}

/// Stored overrides are displayed as their Agent, without exposing the model.
String? modelPickerSelectionId(String? selection) =>
    selectedAgentId(selection) ?? selection;

String? effectiveAgentModel(
  List<ModelOption> catalog,
  String? selection, {
  String? defaultModel,
}) {
  return resolveModelSelectionMetadata(
    catalog: catalog,
    selection: selection,
    defaultModelId: defaultModel,
  ).concreteModelId;
}

ModelOption? effectiveModelOption(
  List<ModelOption> catalog,
  String? selection, {
  String? defaultModel,
  String? executionHarness,
}) => resolveModelSelectionMetadata(
  catalog: catalog,
  selection: selection,
  defaultModelId: defaultModel,
  executionHarness: executionHarness,
).metadataRow;

bool validAgentSelection(List<ModelOption> catalog, String? selection) {
  if (selection == null) return false;
  final agentId = selectedAgentId(selection);
  if (agentId == null) {
    return catalog.any(
      (row) => row.id == selection && row.kind == 'model' && row.available,
    );
  }
  final agent = catalog
      .where((row) => row.id == agentId && row.kind == 'agent')
      .firstOrNull;
  if (agent == null) return false;
  final model = explicitAgentModel(selection);
  if (model == null) {
    if (selection.contains('@')) return false;
    final descriptor = agent.agentSelection;
    return agent.available &&
        (descriptor == null ||
            descriptor.supportedModels.containsKey(descriptor.preferredModel));
  }
  return catalog.any(
        (row) => row.id == model && row.kind == 'model' && row.available,
      ) &&
      (agent.agentSelection == null ||
          agent.agentSelection!.supportedModels.containsKey(model));
}

/// A transport choice retains the canonical route while taking hints from its concrete row.
ModelOption? selectionModelOption(
  List<ModelOption> catalog,
  String? selection, {
  String? executionHarness,
}) {
  if (!validAgentSelection(catalog, selection)) return null;
  final metadata = resolveModelSelectionMetadata(
    catalog: catalog,
    selection: selection,
    executionHarness: executionHarness,
  );
  return metadata.metadataRow?.forExecution(selection: selection!);
}

/// Portal sends cannot name a non-default harness; apply that selection first.
String? agentModelSetupHarness(
  List<ModelOption> catalog,
  String? selection, {
  String? executionHarness,
}) {
  if (selection == null ||
      (selectedAgentId(selection) == null && executionHarness == null)) {
    return null;
  }
  final metadata = resolveModelSelectionMetadata(
    catalog: catalog,
    selection: selection,
    executionHarness: executionHarness,
  );
  return metadata.executionHarness !=
          (metadata.modelRow?.harness ??
              metadata.modelRow?.provider ??
              metadata.agentRow?.harness ??
              metadata.agentRow?.provider)
      ? metadata.executionHarness
      : null;
}
