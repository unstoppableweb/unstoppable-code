/// Dispatch-form rules, ported from the web portal's
/// `apps/web/src/components/remote-control/pipeline-input-form.ts`, which mirrors the
/// desktop's `pipelineTriggerInputs.ts`. Keep the three in step: the desktop
/// executor rejects anything these let through.
library;

import 'package:mobile/data/models/computer_activity/pipeline_dispatch.dart';

/// Inputs the form shows. A hidden input still shows when it is required and
/// has no default, because nothing else could satisfy it.
List<RemotePipelineInputDefinition> visiblePipelineInputs(
  List<RemotePipelineInputDefinition> inputs,
) => [
  for (final input in inputs)
    if (!input.hideInUi || (input.required && input.defaultValue == null))
      input,
];

Map<String, String> initialPipelineInputValues(
  List<RemotePipelineInputDefinition> inputs,
) => {for (final input in inputs) input.name: input.defaultValue ?? ''};

/// Field name -> message for every invalid value; empty when valid.
Map<String, String> validatePipelineInputs(
  List<RemotePipelineInputDefinition> inputs,
  Map<String, String> values,
) {
  final errors = <String, String>{};
  for (final input in inputs) {
    final value = values[input.name]?.trim() ?? '';
    if (input.required && value.isEmpty) {
      errors[input.name] = 'This field is required';
      continue;
    }
    if (value.isEmpty) continue;
    if (input.type == RemotePipelineInputType.number) {
      final parsed = num.tryParse(value);
      final min = input.min;
      final max = input.max;
      if (parsed == null || !parsed.isFinite) {
        errors[input.name] = 'Must be a valid number';
      } else if (min != null && parsed < min) {
        errors[input.name] = 'Must be at least $min';
      } else if (max != null && parsed > max) {
        errors[input.name] = 'Must be at most $max';
      }
    }
    if (input.type == RemotePipelineInputType.choice &&
        input.options.isNotEmpty &&
        !input.options.contains(value)) {
      errors[input.name] = 'Must be one of: ${input.options.join(', ')}';
    }
  }
  return errors;
}

/// The `inputs` sent with `portal.pipeline.run`: trimmed, non-empty values
/// only. Omitted inputs fall back to their declared defaults on the desktop.
Map<String, String> buildPipelineInputPayload(
  List<RemotePipelineInputDefinition> inputs,
  Map<String, String> values,
) => {
  for (final input in inputs)
    if ((values[input.name]?.trim() ?? '') case final value
        when value.isNotEmpty)
      input.name: value,
};
