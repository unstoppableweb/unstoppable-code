import { useId, useState, type JSX } from 'react';
import type { BotColor } from '@canopy/protocol/bot-glyph';
import {
  botColorArea,
  botHexFromHsv,
  botHsvFromHex,
  deriveBotColors,
  normalizeBotHex,
  type BotColorTheme,
  type BotHsv,
} from '../../lib/bot-colors';
import { FieldError, TextInput } from '../../primitives/Field';
import { DialogFormField } from '../../primitives/DialogFormField';
import { Slider } from '../../primitives/Slider';

export interface BotCustomColorProps {
  readonly color: BotColor;
  readonly theme: BotColorTheme | null;
  readonly disabled: boolean;
  readonly onChange: (color: BotColor) => void;
}

export function BotCustomColor({
  color,
  theme,
  disabled,
  onChange,
}: BotCustomColorProps): JSX.Element {
  const id = useId();
  const source =
    color.kind === 'custom'
      ? normalizeBotHex(color.hex)
      : theme?.palette[color.key];
  const [draft, setDraft] = useState(source ?? '');
  const [hsv, setHsv] = useState<BotHsv>(() =>
    source ? botHsvFromHex(source) : { hue: 0, saturation: 0, value: 0 },
  );
  const valid = normalizeBotHex(draft);
  const colors =
    theme && valid
      ? deriveBotColors({ kind: 'custom', hex: valid }, theme)
      : null;
  const area = botColorArea(hsv);
  const emit = (next: BotHsv): void => {
    setHsv(next);
    const hex = botHexFromHsv(next);
    setDraft(hex);
    onChange({ kind: 'custom', hex });
  };
  const clamp = (value: number): number => Math.max(0, Math.min(1, value));
  return (
    <div className="flex flex-col gap-2 border-b px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <DialogFormField label="Hex" htmlFor={`${id}-hex`}>
          <TextInput
            id={`${id}-hex`}
            density="compact"
            mono
            className="w-28"
            value={draft}
            disabled={disabled}
            aria-invalid={!valid}
            aria-describedby={!valid ? `${id}-error` : `${id}-hint`}
            spellCheck={false}
            autoComplete="off"
            onChange={(event): void => {
              const next = event.target.value;
              setDraft(next);
              const normalized = normalizeBotHex(next);
              if (normalized) {
                setHsv(botHsvFromHex(normalized));
                onChange({ kind: 'custom', hex: normalized });
              }
            }}
          />
        </DialogFormField>
        <span
          id={`${id}-hint`}
          className="text-pretty text-xs fg-tertiary"
          aria-live="polite"
        >
          {colors?.adjusted ? 'Adjusted for contrast' : '3 or 6 hex digits'}
        </span>
      </div>
      {!valid ? (
        <FieldError id={`${id}-error`}>
          Enter a 3- or 6-digit hex color.
        </FieldError>
      ) : null}
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Color saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.saturation * 100)}
        aria-valuetext={`${Math.round(hsv.saturation * 100)}% saturation, ${Math.round(hsv.value * 100)}% brightness`}
        aria-disabled={disabled || undefined}
        aria-describedby={`${id}-keys`}
        className="focus-ring relative h-24 w-full touch-none rounded-md"
        style={{ background: area.background }}
        onPointerDown={(event): void => {
          if (disabled) return;
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          const rect = event.currentTarget.getBoundingClientRect();
          emit({
            ...hsv,
            saturation: clamp((event.clientX - rect.left) / rect.width),
            value: clamp(1 - (event.clientY - rect.top) / rect.height),
          });
        }}
        onPointerMove={(event): void => {
          if (
            disabled ||
            !event.currentTarget.hasPointerCapture(event.pointerId)
          )
            return;
          const rect = event.currentTarget.getBoundingClientRect();
          emit({
            ...hsv,
            saturation: clamp((event.clientX - rect.left) / rect.width),
            value: clamp(1 - (event.clientY - rect.top) / rect.height),
          });
        }}
        onPointerUp={(event): void => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onKeyDown={(event): void => {
          if (disabled) return;
          const step = event.shiftKey ? 0.1 : 0.01;
          const next =
            event.key === 'ArrowLeft'
              ? { ...hsv, saturation: clamp(hsv.saturation - step) }
              : event.key === 'ArrowRight'
                ? { ...hsv, saturation: clamp(hsv.saturation + step) }
                : event.key === 'ArrowUp'
                  ? { ...hsv, value: clamp(hsv.value + step) }
                  : event.key === 'ArrowDown'
                    ? { ...hsv, value: clamp(hsv.value - step) }
                    : event.key === 'Home'
                      ? { ...hsv, saturation: 0, value: 1 }
                      : event.key === 'End'
                        ? { ...hsv, saturation: 1, value: 0 }
                        : null;
          if (next) {
            event.preventDefault();
            emit(next);
          }
        }}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 line-base ring-1 ring-line-primary"
          style={{ left: area.left, top: area.top }}
        />
      </div>
      <span id={`${id}-keys`} className="sr-only">
        Left and right adjust saturation. Up and down adjust brightness.
      </span>
      <Slider
        label="Color hue"
        value={Math.round(hsv.hue)}
        valueText={`${Math.round(hsv.hue)} degrees`}
        stops={360}
        disabled={disabled}
        onChange={(hue): void => emit({ ...hsv, hue })}
        onPreview={(hue): void => emit({ ...hsv, hue })}
      />
    </div>
  );
}
