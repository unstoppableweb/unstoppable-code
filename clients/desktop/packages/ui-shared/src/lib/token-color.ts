/**
 * Resolve a theme token to a concrete sRGB `#rrggbb`, for consumers that need a
 * literal color rather than a CSS variable (Mermaid themes, a native window
 * background). The token is read through a probe inside `element`, so it picks
 * up that element's theme, and drawn onto a 1×1 canvas: wide-gamut values such
 * as `color(display-p3 …)` come back as their sRGB equivalent. A translucent
 * token is composited onto `background` when one is given. Returns null when the
 * environment has no 2D canvas.
 */
export function resolveTokenHex(
  element: HTMLElement,
  token: string,
  background?: string,
): string | null {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  element.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, 1, 1);
  }
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const pixel = context.getImageData(0, 0, 1, 1).data;
  return `#${Array.from(pixel.subarray(0, 3), (value) => value.toString(16).padStart(2, '0')).join('')}`;
}
