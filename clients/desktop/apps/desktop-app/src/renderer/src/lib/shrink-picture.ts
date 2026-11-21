import { reportClientAppError } from '@canopy/desktop-instrumentation/client';

/** The bytes of a base64 data URL, or `null` for anything else. */
function dataUrlBlob(src: string): Blob | null {
  const comma = src.indexOf(',');
  if (!src.startsWith('data:') || comma < 0) return null;
  const meta = src.slice('data:'.length, comma);
  if (!meta.endsWith(';base64')) return null;
  const binary = atob(src.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: meta.slice(0, -';base64'.length) });
}

function blobDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (): void =>
      resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = (): void => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/**
 * Decodes, crops and scales through `createImageBitmap` and encodes through
 * an offscreen canvas: all of it runs off the page's main thread, so large
 * pictures loading into the viewer's strip do not hold up a frame.
 */
async function shrinkOffThread(
  blob: Blob,
  edgePx: number,
): Promise<string | null> {
  const full = await createImageBitmap(blob);
  try {
    const side = Math.min(full.width, full.height);
    if (side === 0) return null;
    // Never enlarge: a picture smaller than the copy keeps its own size.
    const edge = Math.min(edgePx, side);
    const small = await createImageBitmap(
      full,
      Math.floor((full.width - side) / 2),
      Math.floor((full.height - side) / 2),
      side,
      side,
      { resizeWidth: edge, resizeHeight: edge, resizeQuality: 'medium' },
    );
    const canvas = new OffscreenCanvas(edge, edge);
    const context = canvas.getContext('bitmaprenderer');
    if (context === null) {
      small.close();
      return null;
    }
    context.transferFromImageBitmap(small);
    return await blobDataUrl(
      await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 }),
    );
  } finally {
    full.close();
  }
}

/** The same copy through an image element, for what a bitmap cannot read. */
async function shrinkThroughElement(
  src: string,
  edgePx: number,
): Promise<string | null> {
  const image = new Image();
  image.src = src;
  await image.decode();
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  if (side === 0) return null;
  const edge = Math.min(edgePx, side);
  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  const context = canvas.getContext('2d');
  if (context === null) return null;
  context.drawImage(
    image,
    (image.naturalWidth - side) / 2,
    (image.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    edge,
    edge,
  );
  return canvas.toDataURL('image/webp', 0.8);
}

/**
 * A picture cut down to a square of `edgePx`, as a small WebP data URL. The
 * preview read returns the whole image (up to its 5 MB cap); the media
 * viewer's strip keeps this copy instead and lets the full one go. The copy
 * is the centre square, which is what a square tile shows of the picture
 * anyway.
 * `null` when the picture cannot be decoded.
 */
export async function shrinkPicture(
  src: string,
  edgePx: number,
): Promise<string | null> {
  try {
    const blob = dataUrlBlob(src);
    // An SVG has no bitmap decoder; an image element still draws it.
    return blob === null || blob.type === 'image/svg+xml'
      ? await shrinkThroughElement(src, edgePx)
      : await shrinkOffThread(blob, edgePx);
  } catch (error) {
    reportClientAppError(error);
    return null;
  }
}
