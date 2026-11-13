/**
 * Plain names for rendered colors, so a swatch is announced as "Green", not
 * "Color 2". The palette's slots change hue with the theme and brand, so the
 * name comes from the color on screen (CAN-6407).
 */

export interface Oklch {
  /** Lightness, 0 to 1. */
  l: number;
  /** Chroma, 0 and up. */
  c: number;
  /** Hue in degrees, 0 to 360. */
  h: number;
}

type Rgb = readonly [number, number, number];

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?`;

function channels(body: string): number[] {
  return (body.split('/')[0] ?? '')
    .split(/[\s,]+/)
    .filter((part) => new RegExp(`^${NUMBER}$`, 'i').test(part))
    .map((part) =>
      part.endsWith('%') ? Number(part.slice(0, -1)) / 100 : Number(part),
    );
}

function toLinear(value: number): number {
  const magnitude = Math.abs(value);
  const linear =
    magnitude <= 0.04045
      ? magnitude / 12.92
      : ((magnitude + 0.055) / 1.055) ** 2.4;
  return Math.sign(value) * linear;
}

/** Display P3 in linear light to linear sRGB (CSS Color 4). */
function p3ToSrgbLinear([r, g, b]: Rgb): Rgb {
  return [
    1.2249401 * r - 0.2249404 * g,
    -0.0420569 * r + 1.0420571 * g,
    -0.0196376 * r - 0.0786361 * g + 1.0982735 * b,
  ];
}

function oklchFromLinearSrgb([r, g, b]: Rgb): Oklch {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bAxis = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = (Math.atan2(bAxis, a) * 180) / Math.PI;
  return {
    l: lightness,
    c: Math.hypot(a, bAxis),
    h: hue < 0 ? hue + 360 : hue,
  };
}

/**
 * Reads a computed CSS color: `rgb()`/`rgba()`, hex, `color(srgb …)`,
 * `color(display-p3 …)` or `oklch()`. Null when it can't be read.
 */
export function parseCssColor(value: string): Oklch | null {
  const text = value.trim().toLowerCase();
  const hex = /^#([\da-f]{3}|[\da-f]{6})(?:[\da-f]{2})?$/.exec(text)?.[1];
  if (hex) {
    const full =
      hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
    const rgb = [0, 2, 4].map(
      (start) => parseInt(full.slice(start, start + 2), 16) / 255,
    );
    return oklchFromLinearSrgb([
      toLinear(rgb[0] ?? 0),
      toLinear(rgb[1] ?? 0),
      toLinear(rgb[2] ?? 0),
    ]);
  }
  const rgbBody = /^rgba?\((.*)\)$/.exec(text)?.[1];
  if (rgbBody !== undefined) {
    // Percentages are already 0 to 1; plain channels are 0 to 255.
    const percent = rgbBody.includes('%');
    const [r, g, b] = channels(rgbBody).map((part) =>
      percent ? part : part / 255,
    );
    if (r === undefined || g === undefined || b === undefined) return null;
    return oklchFromLinearSrgb([toLinear(r), toLinear(g), toLinear(b)]);
  }
  const colorBody = /^color\((srgb|display-p3)\s+(.*)\)$/.exec(text);
  if (colorBody) {
    const [r, g, b] = channels(colorBody[2] ?? '');
    if (r === undefined || g === undefined || b === undefined) return null;
    const linear: Rgb = [toLinear(r), toLinear(g), toLinear(b)];
    return oklchFromLinearSrgb(
      colorBody[1] === 'display-p3' ? p3ToSrgbLinear(linear) : linear,
    );
  }
  const oklchBody = /^oklch\((.*)\)$/.exec(text)?.[1];
  if (oklchBody !== undefined) {
    const [l, c, h] = channels(oklchBody.replace(/deg/g, ''));
    if (l === undefined || c === undefined || h === undefined) return null;
    return { l, c, h: ((h % 360) + 360) % 360 };
  }
  return null;
}

// Below this chroma a color reads as gray, whatever its hue.
const GRAY_CHROMA = 0.04;

// Upper bounds of OKLCH hue ranges, in degrees; past the last is Pink again.
const HUE_NAMES: readonly (readonly [number, string])[] = [
  [15, 'Pink'],
  [40, 'Red'],
  [65, 'Orange'],
  [80, 'Amber'],
  [105, 'Yellow'],
  [135, 'Lime'],
  [170, 'Green'],
  [200, 'Teal'],
  [228, 'Cyan'],
  [268, 'Blue'],
  [318, 'Purple'],
  [360, 'Pink'],
];

/** One color's name, from its hue, or Gray when it has almost none. */
export function colorName(color: Oklch): string {
  if (color.c < GRAY_CHROMA) return 'Gray';
  return HUE_NAMES.find(([bound]) => color.h < bound)?.[1] ?? 'Pink';
}

/**
 * Names for a row of colors, each unique: colors that share a name are told
 * apart as "Light …" and "Dark …" by lightness, and any still left the same
 * get a number. Unreadable colors (null) take `fallback(index)`.
 */
export function uniqueColorNames(
  colors: readonly (Oklch | null)[],
  fallback: (index: number) => string,
): string[] {
  const names = colors.map((color, index) =>
    color ? colorName(color) : fallback(index),
  );
  const groups = new Map<string, number[]>();
  colors.forEach((color, index) => {
    if (!color) return;
    const name = names[index] ?? '';
    groups.set(name, [...(groups.get(name) ?? []), index]);
  });
  for (const [name, indices] of groups) {
    if (indices.length < 2) continue;
    const byLightness = [...indices].sort(
      (left, right) => (colors[right]?.l ?? 0) - (colors[left]?.l ?? 0),
    );
    const lower = name.toLowerCase();
    byLightness.forEach((index, rank) => {
      if (rank === 0) names[index] = `Light ${lower}`;
      else if (rank === byLightness.length - 1) names[index] = `Dark ${lower}`;
    });
  }
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} ${count}`;
  });
}
