import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/text-field/canopy_text_field.dart';
import 'package:mobile/data/models/computer_activity/pipeline_dispatch.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'pipeline_input_form.dart';

class PipelineDispatchForm extends StatefulWidget {
  const PipelineDispatchForm({
    super.key,
    required this.form,
    required this.padding,
    this.description,
    required this.submitting,
    required this.degraded,
    this.dispatchError,
    required this.onRun,
    required this.formRules,
  });
  final RemotePipelineDispatchForm form;
  final EdgeInsets padding;
  final String? description;
  final bool submitting, degraded;
  final String? dispatchError;
  final void Function(Map<String, String> inputs) onRun;
  final PipelineFormRules Function(
    RemotePipelineDispatchForm form,
    Map<String, String> values,
  )
  formRules;
  @override
  State<PipelineDispatchForm> createState() => _PipelineDispatchFormState();
}

class _PipelineDispatchFormState extends State<PipelineDispatchForm> {
  final Map<String, TextEditingController> _controllers = {};
  Map<String, String> _values = {}, _errors = {};
  RemotePipelineDispatchForm? _seededFrom;
  List<RemotePipelineInputDefinition> _fields = const [];
  @override
  void dispose() {
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  void _runInputs(RemotePipelineDispatchForm form) {
    final rules = widget.formRules(form, _values);
    setState(() => _errors = rules.errors);
    if (rules.errors.isNotEmpty) return;
    widget.onRun(rules.payload);
  }

  @override
  Widget build(BuildContext context) => _buildForm(
    context,
    widget.padding,
    widget.form,
    submitting: widget.submitting,
    degraded: widget.degraded,
    dispatchError: widget.dispatchError,
  );

  /// Seeds the field values once per loaded form, never over the user's edits.
  void _seed(RemotePipelineDispatchForm form) {
    if (identical(_seededFrom, form)) return;
    _seededFrom = form;
    final rules = widget.formRules(form, const {});
    _values = rules.initial;
    _fields = rules.visible;
    for (final entry in _values.entries) {
      (_controllers[entry.key] ??= TextEditingController()).text = entry.value;
    }
  }

  void _setValue(String name, String value) => setState(() {
    _values = {..._values, name: value};
    _errors = {..._errors}..remove(name);
  });

  Widget _buildForm(
    BuildContext context,
    EdgeInsets padding,
    RemotePipelineDispatchForm form, {
    required bool submitting,
    required bool degraded,
    required String? dispatchError,
  }) {
    _seed(form);
    final theme = Theme.of(context);
    final description = widget.description;
    final blocked = form.inputsOmitted
        ? 'This pipeline has too many inputs to show here. Run it from the '
              'desktop app.'
        : form.unsupportedReason != null
        ? "This pipeline needs input the phone can't provide. Run it from the "
              'desktop app.'
        : null;
    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: EdgeInsets.fromLTRB(16, padding.top + 8, 16, 16),
            children: [
              if (description != null) ...[
                Text(description, style: theme.textTheme.bodyMedium),
                const SizedBox(height: 16),
              ],
              if (blocked != null)
                Text(
                  blocked,
                  key: const ValueKey('pipeline-dispatch-blocked'),
                  style: theme.textTheme.bodyMedium,
                )
              else
                for (final input in _fields)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: _InputField(
                      input: input,
                      controller: _controllers[input.name] ??=
                          TextEditingController(text: _values[input.name]),
                      value: _values[input.name] ?? '',
                      error: _errors[input.name],
                      enabled: !submitting,
                      onChanged: (value) => _setValue(input.name, value),
                    ),
                  ),
            ],
          ),
        ),
        if (blocked == null)
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (dispatchError != null) ...[
                    Text(
                      dispatchError,
                      key: const ValueKey('pipeline-dispatch-error'),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: StatusColors.of(context).failed,
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
                  // A temporary state: Run stays visible and comes back with the
                  // desktop, rather than the form disappearing.
                  if (degraded && !submitting) ...[
                    Text(
                      "Your desktop is reconnecting. Run when it's back.",
                      key: const ValueKey('pipeline-dispatch-reconnecting'),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
                  CanopyButton(
                    key: const ValueKey('pipeline-dispatch-run'),
                    label: submitting ? 'Starting…' : 'Run',
                    loading: submitting,
                    expand: true,
                    onPressed: submitting || degraded
                        ? null
                        : () => _runInputs(form),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _InputField extends StatelessWidget {
  const _InputField({
    required this.input,
    required this.controller,
    required this.value,
    required this.error,
    required this.enabled,
    required this.onChanged,
  });

  final RemotePipelineInputDefinition input;
  final TextEditingController controller;
  final String value;
  final String? error;
  final bool enabled;
  final ValueChanged<String> onChanged;

  String get _label => input.required ? '${input.name} *' : input.name;

  @override
  Widget build(BuildContext context) {
    final key = ValueKey('pipeline-dispatch-field:${input.name}');
    final description = input.description;
    switch (input.type) {
      case RemotePipelineInputType.boolean
          when !input.required || input.defaultValue != null:
        return SwitchListTile(
          key: key,
          contentPadding: EdgeInsets.zero,
          title: Text(_label),
          subtitle: description == null ? null : Text(description),
          value: value == 'true',
          onChanged: enabled ? (on) => onChanged(on ? 'true' : 'false') : null,
        );
      case RemotePipelineInputType.boolean:
        return _SelectField(
          fieldKey: key,
          name: input.name,
          label: _label,
          hint: description,
          value: value,
          error: error,
          enabled: enabled,
          options: const [('true', 'True'), ('false', 'False')],
          onChanged: onChanged,
        );
      case RemotePipelineInputType.choice:
        return _SelectField(
          fieldKey: key,
          name: input.name,
          label: _label,
          hint: description,
          value: value,
          error: error,
          enabled: enabled,
          options: [for (final option in input.options) (option, option)],
          onChanged: onChanged,
        );
      case RemotePipelineInputType.number:
        final range = [
          if (input.min != null) 'min ${input.min}',
          if (input.max != null) 'max ${input.max}',
        ].join(', ');
        final helper = [?description, if (range.isNotEmpty) range].join(' · ');
        return CanopyTextField(
          key: key,
          controller: controller,
          enabled: enabled,
          keyboardType: const TextInputType.numberWithOptions(
            signed: true,
            decimal: true,
          ),
          labelText: _label,
          helperText: helper.isEmpty ? null : helper,
          errorText: error,
          onChanged: onChanged,
        );
      case RemotePipelineInputType.string:
        return CanopyTextField(
          key: key,
          controller: controller,
          enabled: enabled,
          labelText: _label,
          helperText: description,
          errorText: error,
          onChanged: onChanged,
        );
    }
  }
}

/// A tappable field that opens a bottom sheet of options with a checkmark on
/// the selected one (DESIGN.md picker rule).
class _SelectField extends StatelessWidget {
  const _SelectField({
    required this.fieldKey,
    required this.name,
    required this.label,
    required this.hint,
    required this.value,
    required this.error,
    required this.enabled,
    required this.options,
    required this.onChanged,
  });

  final Key fieldKey;
  final String name;
  final String label;
  final String? hint;
  final String value;
  final String? error;
  final bool enabled;
  final List<(String, String)> options;
  final ValueChanged<String> onChanged;

  Future<void> _pick(BuildContext context) async {
    final picked = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final (optionValue, optionLabel) in options)
              ListTile(
                key: ValueKey('pipeline-dispatch-choice:$name:$optionValue'),
                title: Text(optionLabel),
                trailing: optionValue == value
                    ? const CanopyIcon(glyph: CanopyGlyph.checkmark1)
                    : null,
                selected: optionValue == value,
                onTap: () => Navigator.of(sheetContext).pop(optionValue),
              ),
          ],
        ),
      ),
    );
    if (picked != null) onChanged(picked);
  }

  @override
  Widget build(BuildContext context) {
    final selected = options.where((option) => option.$1 == value).firstOrNull;
    return InkWell(
      key: fieldKey,
      onTap: enabled ? () => unawaited(_pick(context)) : null,
      child: InputDecorator(
        isEmpty: selected == null,
        decoration: InputDecoration(
          labelText: label,
          hintText: 'Select…',
          helperText: hint,
          errorText: error,
          enabled: enabled,
          suffixIcon: const CanopyIcon(glyph: CanopyGlyph.chevronDownMedium),
        ),
        child: Text(selected?.$2 ?? ''),
      ),
    );
  }
}
