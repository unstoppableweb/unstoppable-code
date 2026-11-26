'use client';
import { useId, useRef, useState, type JSX } from 'react';
import type { BotGlyph as BotGlyphValue } from '@canopy/protocol/bot-glyph';
import { PencilIcon } from '../../icons/AppIcons';
import { Button } from '../../primitives/Button';
import { Popover } from '../../primitives/Popover';
import { Tooltip } from '../../primitives/Tooltip';
import { BotGlyph } from './BotGlyph';
import { BotGlyphPicker } from './BotGlyphPicker';

export interface BotGlyphControlProps {
  readonly value: BotGlyphValue;
  readonly onChange: (value: BotGlyphValue) => void;
  readonly recentEmojis?: readonly string[];
  readonly disabled?: boolean;
}

/** Avatar itself is the control; Popover owns Escape, Tab and focus return. */
export function BotGlyphControl({
  value,
  onChange,
  recentEmojis,
  disabled = false,
}: BotGlyphControlProps): JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <Tooltip label="Edit avatar" suppressed={open}>
        <Button
          ref={anchorRef}
          className="group/bot-glyph"
          variant="ghost"
          size="lg"
          iconOnly
          aria-label="Edit avatar"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          disabled={disabled}
          onClick={(): void => setOpen(!open)}
        >
          <span className="group/bot-glyph relative inline-flex">
            <BotGlyph value={value} size="md" />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 inline-flex items-center justify-center rounded-lg bg-overlay-scrim fg-emphasis opacity-0 group-hover/bot-glyph:opacity-100 group-focus-within/bot-glyph:opacity-100"
            >
              <PencilIcon size="md" />
            </span>
          </span>
        </Button>
      </Tooltip>
      <Popover
        id={id}
        open={open && !disabled}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        returnFocusRef={anchorRef}
        aria-label="Edit avatar"
        width="content"
        inset="flush"
      >
        {/* Keep Escape inside this picker before the settings dialog handles it. */}
        <div data-canopy-escape-boundary="true">
          <BotGlyphPicker
            value={value}
            onChange={onChange}
            recentEmojis={recentEmojis}
            initialTab={value.kind === 'emoji' ? 'emojis' : 'icons'}
            disabled={disabled}
          />
        </div>
      </Popover>
    </>
  );
}
