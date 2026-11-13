'use client';

/**
 * One declared pipeline input as a form control (CAN-3019): New Task's
 * `task_ready` mode and the Plans card's `plan_ready` dispatch dialog in the
 * Portal, and the web Workflows page's cloud Run dialog (CAN-6341). Each
 * control keeps its `aria-label`, so `[aria-label="..."]` queries resolve.
 */
import { useId, type JSX } from 'react';
import type { PortalPipelineInputDefinition } from '@canopy/protocol/portal';
import {
  DialogFormField,
  Select,
  TextInput,
  type SelectOption,
} from '@canopy/ui-shared/components';

export interface PipelineInputFieldProps {
  name: string;
  definition: PortalPipelineInputDefinition;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}

function emptyOption(definition: PortalPipelineInputDefinition): SelectOption {
  return {
    value: '',
    label: definition.required ? 'Select…' : 'Use default',
    disabled: definition.required === true,
  };
}

function selectOptions(
  definition: PortalPipelineInputDefinition,
  type: string,
): readonly SelectOption[] {
  const values =
    type === 'boolean'
      ? [
          { value: 'true', label: 'True' },
          { value: 'false', label: 'False' },
        ]
      : (definition.options ?? []).map((option) => ({
          value: option,
          label: option,
        }));
  return [emptyOption(definition), ...values];
}

export function PipelineInputField({
  name,
  definition,
  value,
  error,
  onChange,
}: PipelineInputFieldProps): JSX.Element {
  const id = useId();
  const errorId = `${id}-error`;
  const label = definition.description || name;
  const type = definition.type ?? 'string';
  const invalid = error ? true : undefined;
  const describedBy = error ? errorId : undefined;
  return (
    <DialogFormField
      label={`${label}${definition.required ? ' *' : ''}`}
      htmlFor={id}
      error={error}
      errorId={errorId}
    >
      {type === 'choice' || type === 'boolean' ? (
        <Select
          id={id}
          aria-label={label}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          options={selectOptions(definition, type)}
          value={value}
          onValueChange={onChange}
        />
      ) : (
        <TextInput
          id={id}
          aria-label={label}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          type={type === 'number' ? 'number' : 'text'}
          min={definition.min}
          max={definition.max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </DialogFormField>
  );
}
