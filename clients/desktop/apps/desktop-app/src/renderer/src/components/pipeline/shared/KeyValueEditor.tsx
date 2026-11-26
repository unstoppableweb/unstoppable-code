import { type JSX, useState } from 'react';
import type { PipelineScalar } from '@canopy/execution-engine/types/pipeline';
import { Stack, Surface, TextArea } from '@canopy/ui-shared/components';
import { TextField } from './TextField';
import { EnlargeValueModal } from './EnlargeValueModal';
import { Tooltip } from '@canopy/ui-shared';
import {
  Button,
  SegmentedControl,
  type SegmentedControlOption,
} from '@canopy/ui-shared/components';
import {
  MaximizeIcon as AppCatalogMaximizeIcon,
  CloseIcon as AppCatalogCloseIcon,
} from '@canopy/ui-shared/icons/AppIcons';

type ValueType = 'string' | 'number' | 'boolean';

const TYPE_LABELS: Record<ValueType, string> = {
  string: 'Abc',
  number: '123',
  boolean: 'T/F',
};

const TYPE_ORDER: ValueType[] = ['string', 'number', 'boolean'];

const BOOLEAN_OPTIONS: readonly SegmentedControlOption<'false' | 'true'>[] = [
  { value: 'false', label: 'false' },
  { value: 'true', label: 'true' },
];

interface KeyValueEditorProps {
  value: Record<string, PipelineScalar>;
  onChange: (value: Record<string, PipelineScalar>) => void;
  stringOnly?: boolean;
  readonly?: boolean;
}

function detectType(val: PipelineScalar): ValueType {
  if (typeof val === 'boolean') return 'boolean';
  if (typeof val === 'number') return 'number';
  return 'string';
}

function coerceToType(val: PipelineScalar, target: ValueType): PipelineScalar {
  if (target === 'boolean') {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val !== 0;
    return val === 'true' || val === '1';
  }
  if (target === 'number') {
    if (typeof val === 'number') return val;
    if (typeof val === 'boolean') return val ? 1 : 0;
    const num = Number(val);
    return Number.isNaN(num) ? 0 : num;
  }
  // string
  return String(val);
}

export function KeyValueEditor({
  value,
  onChange,
  stringOnly,
  readonly = false,
}: KeyValueEditorProps): JSX.Element {
  const entries = Object.entries(value);
  const [newKey, setNewKey] = useState('');
  const [enlargeKey, setEnlargeKey] = useState<string | null>(null);

  function updateKey(oldKey: string, newKeyName: string): void {
    // Prevent empty key names and overwriting an existing key
    if (!newKeyName || (newKeyName !== oldKey && newKeyName in value)) return;
    const updated: Record<string, PipelineScalar> = {};
    for (const [k, v] of Object.entries(value)) {
      updated[k === oldKey ? newKeyName : k] = v;
    }
    onChange(updated);
  }

  function updateValue(key: string, newVal: string): void {
    const current = value[key];
    // Only coerce to number if the existing value is already numeric
    if (typeof current === 'number') {
      if (newVal === '') {
        onChange({ ...value, [key]: newVal });
        return;
      }
      const num = Number(newVal);
      onChange({ ...value, [key]: Number.isNaN(num) ? newVal : num });
      return;
    }
    onChange({ ...value, [key]: newVal });
  }

  function setBooleanValue(key: string, next: boolean): void {
    if (value[key] === next) return;
    onChange({ ...value, [key]: next });
  }

  function cycleType(key: string): void {
    const current = value[key];
    const currentType = detectType(current);
    const currentIdx = TYPE_ORDER.indexOf(currentType);
    const nextType = TYPE_ORDER[(currentIdx + 1) % TYPE_ORDER.length];
    onChange({ ...value, [key]: coerceToType(current, nextType) });
  }

  function removeEntry(key: string): void {
    const updated = { ...value };
    delete updated[key];
    onChange(updated);
  }

  function addEntry(): void {
    if (newKey && !(newKey in value)) {
      onChange({ ...value, [newKey]: '' });
      setNewKey('');
    }
  }

  function handleEnlargeSave(key: string, newVal: PipelineScalar): void {
    onChange({ ...value, [key]: newVal });
  }

  return (
    <Stack gap="item">
      {entries.map(([key, val], index) => {
        // Keys are authored, so labels name the row by number instead.
        const row = String(index + 1);
        const valType = detectType(val);
        return (
          <Surface variant="group" size="small" padding="tight" key={key}>
            <div className="flex flex-col gap-2">
              {/* Row 1: key name + type button + enlarge button + delete */}
              <div className="flex gap-2 items-center">
                <TextField
                  value={key}
                  onChange={(e) => updateKey(key, e.target.value)}
                  placeholder="Key"
                  className="flex-1"
                  disabled={readonly}
                />
                {!stringOnly && !readonly && (
                  <Tooltip
                    label={`Type: ${valType}`}
                    description="Select to cycle"
                  >
                    <Button
                      size="compact"
                      onClick={() => cycleType(key)}
                      aria-label={`Type: ${valType}. Select to cycle`}
                    >
                      {TYPE_LABELS[valType]}
                    </Button>
                  </Tooltip>
                )}
                {!readonly && (
                  <Tooltip label="Edit in expanded view">
                    <Button
                      variant="ghost"
                      size="compact"
                      iconOnly
                      onClick={() => setEnlargeKey(key)}
                      aria-label="Edit in expanded view"
                    >
                      <AppCatalogMaximizeIcon size="sm" />
                    </Button>
                  </Tooltip>
                )}
                {!readonly && (
                  <Button
                    variant="ghost"
                    size="compact"
                    iconOnly
                    onClick={() => removeEntry(key)}
                    aria-label={`Remove entry ${row}`}
                  >
                    <AppCatalogCloseIcon size="sm" />
                  </Button>
                )}
              </div>

              {/* Row 2: value input (full width) */}
              <div>
                {!stringOnly && valType === 'boolean' ? (
                  <SegmentedControl
                    label={`Value ${row}`}
                    value={val ? 'true' : 'false'}
                    options={BOOLEAN_OPTIONS}
                    onChange={(next): void =>
                      setBooleanValue(key, next === 'true')
                    }
                    disabled={readonly}
                    width="fill"
                  />
                ) : valType === 'number' ? (
                  <TextField
                    value={String(val)}
                    onChange={(e) => updateValue(key, e.target.value)}
                    placeholder="Value"
                    type="number"
                    disabled={readonly}
                  />
                ) : (
                  <TextArea
                    mono
                    aria-label={`Value ${row}`}
                    value={String(val)}
                    onChange={(e) => updateValue(key, e.target.value)}
                    placeholder="Value"
                    rows={2}
                    disabled={readonly}
                  />
                )}
              </div>
            </div>
          </Surface>
        );
      })}
      {!readonly && (
        <div className="flex gap-2 items-center">
          <TextField
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="New key…"
            className="flex-1"
            onKeyDown={(e) => e.key === 'Enter' && addEntry()}
          />
          <Button
            size="compact"
            onClick={addEntry}
            disabled={!newKey || newKey in value}
          >
            Add
          </Button>
        </div>
      )}

      {/* Enlarge modal */}
      {enlargeKey !== null && enlargeKey in value && (
        <EnlargeValueModal
          inputKey={enlargeKey}
          value={value[enlargeKey]}
          valueType={detectType(value[enlargeKey])}
          onSave={(newVal) => handleEnlargeSave(enlargeKey, newVal)}
          onClose={() => setEnlargeKey(null)}
        />
      )}
    </Stack>
  );
}
