'use client';

import type { JSX } from 'react';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { Heading } from '../primitives/Heading';
import { Stack } from '../primitives/Stack';
import { TextArea } from '../primitives/Field';

export function OrchestratorInstructionsPanel({
  value,
  onChange,
  testId,
  labelId,
  descriptionId,
  placeholder,
  disabled,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly testId: string;
  readonly labelId: string;
  readonly descriptionId?: string;
  readonly placeholder: string;
  readonly disabled?: boolean;
}): JSX.Element {
  return (
    <Stack gap="inline" className="min-h-0 flex-1">
      <Stack gap="tight">
        <Heading level={3} variant="title" id={labelId}>
          CLAUDE.md
        </Heading>
        <p id={descriptionId} className="text-xs fg-secondary">
          Instructions loaded into every {ORCHESTRATOR_LABEL} chat.
        </p>
      </Stack>
      <TextArea
        mono
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        className="min-h-0 flex-1"
        data-testid={testId}
        placeholder={placeholder}
      />
    </Stack>
  );
}
