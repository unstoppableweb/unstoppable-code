import type { CSSProperties, JSX } from 'react';
import { Tooltip } from './Tooltip';

export interface PrLabelBadgeProps {
  /** Label text. */
  name: string;
  /** GitHub label color as a 6-digit hex string, with or without a leading `#`. */
  color: string;
  /** Optional description surfaced as a tooltip. */
  description?: string | null;
  /** Test ID hook for automation. */
  dataTestId?: string;
}

const HEX_COLOR = /^#?([0-9a-fA-F]{6})$/;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function parseHex(color: string): Rgb | null {
  const match = HEX_COLOR.exec(color.trim());
  if (!match) {
    return null;
  }
  const value = parseInt(match[1], 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const delta = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === rf) {
      h = ((gf - bf) / delta) % 6;
    } else if (max === gf) {
      h = (bf - rf) / delta + 2;
    } else {
      h = (rf - gf) / delta + 4;
    }
    h *= 60;
    if (h < 0) {
      h += 360;
    }
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** Perceived (relative luminance) lightness of an RGB color, in `[0, 1]`. */
function perceivedLightness({ r, g, b }: Rgb): number {
  return (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
}

// GitHub lightens dark labels toward this lightness threshold so their text and
// border stay legible on the dark tinted background.
const DARK_LIGHTNESS_THRESHOLD = 0.6;
const DARK_BACKGROUND_ALPHA = 0.18;
const DARK_BORDER_ALPHA = 0.3;
const LIGHT_BORDER = 'rgba(0, 0, 0, 0.12)';

/**
 * The six CSS custom properties that drive `.canopy-pr-label` in
 * `canopy-tokens.css`. Extends `CSSProperties` so the custom-property keys can
 * be set inline without casting.
 */
interface LabelColorStyle extends CSSProperties {
  '--pr-label-bg': string;
  '--pr-label-fg': string;
  '--pr-label-border': string;
  '--pr-label-bg-dark': string;
  '--pr-label-fg-dark': string;
  '--pr-label-border-dark': string;
}

/**
 * Builds the label's color custom properties. Light mode uses a solid fill with
 * contrasting text (GitHub's light treatment); dark mode uses GitHub's Primer
 * treatment — a translucent tint of the label color with a lightened,
 * label-hued border and text.
 */
function computeLabelColors(rgb: Rgb): LabelColorStyle {
  const { r, g, b } = rgb;
  const hsl = rgbToHsl(rgb);
  const lightness = perceivedLightness(rgb);

  // Light mode: solid fill, black/white text via the YIQ contrast formula.
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  const solidText = yiq >= 128 ? '#000000' : '#ffffff';

  // Dark mode: lift the label lightness for dark colors so text/border read
  // against the translucent tint; already-light colors are left as-is.
  const lightenBy = Math.max(0, DARK_LIGHTNESS_THRESHOLD - lightness) * 100;
  const darkL = Math.min(100, Math.round(hsl.l + lightenBy));

  return {
    '--pr-label-bg': `rgb(${r}, ${g}, ${b})`,
    '--pr-label-fg': solidText,
    '--pr-label-border': LIGHT_BORDER,
    '--pr-label-bg-dark': `rgba(${r}, ${g}, ${b}, ${DARK_BACKGROUND_ALPHA})`,
    '--pr-label-fg-dark': `hsl(${hsl.h}, ${hsl.s}%, ${darkL}%)`,
    '--pr-label-border-dark': `hsla(${hsl.h}, ${hsl.s}%, ${darkL}%, ${DARK_BORDER_ALPHA})`,
  };
}

const PILL_BASE =
  'inline-flex max-w-full items-center truncate rounded-full px-2.5 py-0.5 text-xs font-medium leading-4.5';

/**
 * Pure GitHub-style PR label pill. Matches GitHub's Primer label treatment in
 * both color modes: a solid fill with contrasting text in light mode, and a
 * translucent label-color tint with a lightened, label-hued border and text in
 * dark mode. The color math is computed here and handed to
 * `.canopy-pr-label` (in `@canopy/ui-shared/styles/canopy-tokens.css`) via CSS
 * custom properties so the light/dark switch stays in CSS. Shared between the
 * desktop renderer and the web portal.
 */
export function PrLabelBadge({
  name,
  color,
  description,
  dataTestId,
}: PrLabelBadgeProps): JSX.Element {
  const rgb = parseHex(color);
  return (
    <Tooltip label={description} clamp disabled={!description} replayBlock>
      <span
        data-testid={dataTestId}
        style={rgb ? computeLabelColors(rgb) : undefined}
        className={`${PILL_BASE} ${rgb ? 'canopy-pr-label' : 'border bg-muted fg-secondary'}`}
      >
        {name}
      </span>
    </Tooltip>
  );
}
