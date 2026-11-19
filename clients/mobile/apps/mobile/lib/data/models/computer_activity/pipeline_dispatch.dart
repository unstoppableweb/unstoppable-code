/// Mobile projection of the pipelines a worktree can run and the form for
/// starting one (CAN-3174).
///
/// [RemotePipelineDescriptor] mirrors the shell state's `pipelines` rows
/// (`RemoteControlPipelineDescriptorEntity`); [RemotePipelineDispatchForm] mirrors
/// the `dispatchInputs` fields of `RemoteControlPipelineGetResult` in
/// `packages/protocol/src/remote-control/shell/index.ts`.
library;

/// Where a pipeline came from; labels the picker row.
enum RemotePipelineOrigin { bundled, user, project, shared, curated }

/// One pipeline the paired desktop offers for a worktree.
class RemotePipelineDescriptor {
  const RemotePipelineDescriptor({
    required this.pipelineId,
    required this.name,
    this.description,
    this.origin = RemotePipelineOrigin.project,
    this.triggerTypes = const [],
    this.scopes = const ['directory'],
  });

  final String pipelineId;
  final String name;
  final String? description;
  final RemotePipelineOrigin origin;
  final List<String> triggerTypes;

  /// Absent on the wire means `['directory']`, as on the desktop.
  final List<String> scopes;

  /// Startable from the worktree picker: declares the `dispatch` trigger,
  /// can run against a worktree (desktop's `filterTriggerRowsByExecutionScope`
  /// rule), and is not a shared cloud pipeline (web excludes those too).
  bool get isDispatchable =>
      triggerTypes.contains('dispatch') &&
      (scopes.contains('directory') || scopes.contains('worktree')) &&
      origin != RemotePipelineOrigin.shared &&
      !pipelineId.startsWith('shared:');

  static RemotePipelineDescriptor? fromJson(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    final pipelineId =
        _nonEmpty(value['pipelineId']) ?? _nonEmpty(value['localId']);
    if (pipelineId == null) return null;
    final scopes = _strings(value['scopes']);
    return RemotePipelineDescriptor(
      pipelineId: pipelineId,
      name: _nonEmpty(value['name']) ?? pipelineId,
      description: _nonEmpty(value['description']),
      origin: switch (value['origin']) {
        'bundled' => RemotePipelineOrigin.bundled,
        'user' => RemotePipelineOrigin.user,
        'shared' => RemotePipelineOrigin.shared,
        'curated' => RemotePipelineOrigin.curated,
        _ => RemotePipelineOrigin.project,
      },
      triggerTypes: _strings(value['triggerTypes']),
      scopes: scopes.isEmpty ? const ['directory'] : scopes,
    );
  }
}

enum RemotePipelineInputType { string, boolean, number, choice }

/// One declared dispatch input. [defaultValue] is already stringified, the
/// way the desktop and web seed their form fields.
class RemotePipelineInputDefinition {
  const RemotePipelineInputDefinition({
    required this.name,
    this.description,
    this.required = false,
    this.defaultValue,
    this.type = RemotePipelineInputType.string,
    this.options = const [],
    this.min,
    this.max,
    this.hideInUi = false,
  });

  final String name;
  final String? description;
  final bool required;
  final String? defaultValue;
  final RemotePipelineInputType type;
  final List<String> options;
  final num? min;
  final num? max;

  /// `hint-hide-ui-option` on the wire.
  final bool hideInUi;

  static RemotePipelineInputDefinition? fromJson(String name, Object? value) {
    if (name.isEmpty || value is! Map<String, dynamic>) return null;
    final rawDefault = value['default'];
    final min = value['min'];
    final max = value['max'];
    return RemotePipelineInputDefinition(
      name: name,
      description: _nonEmpty(value['description']),
      required: value['required'] == true,
      defaultValue:
          rawDefault is String || rawDefault is num || rawDefault is bool
          ? '$rawDefault'
          : null,
      type: switch (value['type']) {
        'boolean' => RemotePipelineInputType.boolean,
        'number' => RemotePipelineInputType.number,
        'choice' => RemotePipelineInputType.choice,
        _ => RemotePipelineInputType.string,
      },
      options: _strings(value['options']),
      min: min is num ? min : null,
      max: max is num ? max : null,
      hideInUi: value['hint-hide-ui-option'] == true,
    );
  }
}

/// The dispatch form for one pipeline, from `portal.pipeline.get`.
class RemotePipelineDispatchForm {
  const RemotePipelineDispatchForm({
    required this.inputs,
    this.inputsOmitted = false,
    this.unsupportedReason,
  });

  /// Every declared input, in declaration order, hidden ones included.
  final List<RemotePipelineInputDefinition> inputs;

  /// The desktop dropped the inputs to fit its result budget.
  final bool inputsOmitted;

  /// Why the phone cannot start this pipeline (`json_input`), if it cannot.
  final String? unsupportedReason;

  bool get canDispatch => !inputsOmitted && unsupportedReason == null;

  static RemotePipelineDispatchForm fromGetResult(Map<String, dynamic> result) {
    final raw = result['dispatchInputs'];
    return RemotePipelineDispatchForm(
      inputs: raw is Map<String, dynamic>
          ? [
              for (final entry in raw.entries)
                ?RemotePipelineInputDefinition.fromJson(entry.key, entry.value),
            ]
          : const [],
      inputsOmitted: result['dispatchInputsOmitted'] == true,
      unsupportedReason: _nonEmpty(result['dispatchUnsupportedReason']),
    );
  }
}

String? _nonEmpty(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

List<String> _strings(Object? value) => value is List
    ? [
        for (final item in value)
          if (item is String && item.isNotEmpty) item,
      ]
    : const [];
