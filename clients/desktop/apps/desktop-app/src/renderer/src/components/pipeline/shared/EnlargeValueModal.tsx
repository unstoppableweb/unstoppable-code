import { type JSX, useState, useEffect } from 'react';
import {
  Button,
  SegmentedControl,
  TextArea,
  TextInput,
  type SegmentedControlOption,
} from '@canopy/ui-shared/components';
import { DialogModal } from '../../shared/DialogModal';
import type { PipelineScalar } from '@canopy/execution-engine/types/pipeline';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

type ValueType = 'string' | 'number' | 'boolean';

const BOOLEAN_OPTIONS: readonly SegmentedControlOption<'false' | 'true'>[] = [
  { value: 'false', label: 'false' },
  { value: 'true', label: 'true' },
];

interface EnlargeValueModalProps {
  inputKey: string;
  value: PipelineScalar;
  valueType: ValueType;
  onSave: (value: PipelineScalar) => void;
  onClose: () => void;
}

export function EnlargeValueModal({
  inputKey,
  value,
  valueType,
  onSave,
  onClose,
}: EnlargeValueModalProps): JSX.Element {
  const [localValue, setLocalValue] = useState<string>(String(value));
  const [boolValue, setBoolValue] = useState<boolean>(
    typeof value === 'boolean' ? value : false,
  );

  useEffect((): void => {
    setLocalValue(String(value));
    if (typeof value === 'boolean') {
      setBoolValue(value);
    }
  }, [value]);

  function handleSave(): void {
    if (valueType === 'boolean') {
      onSave(boolValue);
    } else if (valueType === 'number') {
      const num = Number(localValue);
      onSave(Number.isNaN(num) ? localValue : num);
    } else {
      onSave(localValue);
    }
    onClose();
  }

  return (
    <DialogModal onClose={onClose} title="Edit value" maxWidth="2xl">
      <div className="flex flex-col gap-4">
        {/* The key is authored: never recorded. */}
        <span
          className={`text-xs font-medium fg-secondary ${REPLAY_BLOCK_CLASS}`}
        >
          {inputKey}
        </span>
        {valueType === 'boolean' ? (
          <SegmentedControl
            label="Value"
            value={boolValue ? 'true' : 'false'}
            options={BOOLEAN_OPTIONS}
            onChange={(next): void => setBoolValue(next === 'true')}
            width="fill"
          />
        ) : valueType === 'number' ? (
          <TextInput
            type="number"
            mono
            aria-label="Value"
            value={localValue}
            onChange={(e): void => setLocalValue(e.target.value)}
            autoFocus
          />
        ) : (
          <TextArea
            mono
            aria-label="Value"
            value={localValue}
            onChange={(e): void => setLocalValue(e.target.value)}
            autoFocus
            rows={12}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button size="compact" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="compact" onClick={handleSave}>
            Save
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}
