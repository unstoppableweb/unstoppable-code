/**
 * Fits a Slack thread image (CAN-7749) to what one tool result may carry.
 * Pure over a decoded image, so tests drive it without Electron; the port
 * decodes with `nativeImage`.
 */

/** The parts of Electron's `NativeImage` the fitter uses. */
export interface FitImageSource {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: {
    width?: number;
    height?: number;
    quality?: 'good' | 'better' | 'best';
  }): FitImageSource;
  toJPEG(quality: number): Buffer;
}

export type FitImageDecoder = (bytes: Buffer) => FitImageSource;

export interface FittedImage {
  readonly dataUrl: string;
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
  readonly bytes: number;
}

export type FitImageOutcome =
  | { readonly ok: true; readonly image: FittedImage }
  /** Decoded, but no encode within the step limit fit the budget. */
  | { readonly ok: false; readonly reason: 'over_budget' }
  /** Not decodable, and the original is over the budget. */
  | { readonly ok: false; readonly reason: 'undecodable' };

/** The longest edge a provider reads at full detail. */
export const SLACK_IMAGE_MAX_EDGE_PX = 1_568;
/** At most this many encodes per image. */
export const SLACK_IMAGE_MAX_ENCODES = 6;
const QUALITY_STEPS = [85, 75, 65] as const;
const MIN_EDGE_PX = 160;

function dataUrl(mimeType: string, bytes: Buffer): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function passThrough(
  bytes: Buffer,
  mimeType: string,
  size?: { width: number; height: number },
): FitImageOutcome {
  return {
    ok: true,
    image: {
      dataUrl: dataUrl(mimeType, bytes),
      mimeType,
      ...(size ? { width: size.width, height: size.height } : {}),
      bytes: bytes.byteLength,
    },
  };
}

function scaledToEdge(image: FitImageSource, edge: number): FitImageSource {
  const { width, height } = image.getSize();
  if (Math.max(width, height) <= edge) return image;
  return width >= height
    ? image.resize({ width: edge, quality: 'good' })
    : image.resize({ height: edge, quality: 'good' });
}

/**
 * Scales the longest edge to at most 1,568 px and re-encodes as JPEG,
 * stepping quality and then size down until the bytes fit `budgetBytes`, in
 * at most six encodes. A PNG or JPEG that already fits unchanged passes
 * through. An image that can't be decoded passes through only when it fits;
 * GIF and WebP that decode are always re-encoded, so an animation becomes
 * its first frame.
 */
export function fitSlackImage(
  bytes: Buffer,
  mimeType: string,
  budgetBytes: number,
  decode: FitImageDecoder,
): FitImageOutcome {
  let source: FitImageSource | null;
  try {
    source = decode(bytes);
  } catch {
    source = null;
  }
  if (source === null || source.isEmpty())
    return bytes.byteLength <= budgetBytes
      ? passThrough(bytes, mimeType)
      : { ok: false, reason: 'undecodable' };

  const original = source.getSize();
  if (
    (mimeType === 'image/png' || mimeType === 'image/jpeg') &&
    bytes.byteLength <= budgetBytes &&
    Math.max(original.width, original.height) <= SLACK_IMAGE_MAX_EDGE_PX
  )
    return passThrough(bytes, mimeType, original);

  let image = scaledToEdge(source, SLACK_IMAGE_MAX_EDGE_PX);
  let qualityIndex = 0;
  for (let encode = 0; encode < SLACK_IMAGE_MAX_ENCODES; encode++) {
    const quality = QUALITY_STEPS[qualityIndex] ?? QUALITY_STEPS[0];
    const encoded = image.toJPEG(quality);
    if (encoded.byteLength > 0 && encoded.byteLength <= budgetBytes)
      return passThrough(encoded, 'image/jpeg', image.getSize());
    if (qualityIndex < QUALITY_STEPS.length - 1 && encode === 0) {
      // One quality step first: small overshoots fit without losing pixels.
      qualityIndex += 1;
      continue;
    }
    const { width, height } = image.getSize();
    const edge = Math.max(width, height);
    if (edge <= MIN_EDGE_PX) break;
    // JPEG size scales roughly with pixel count, so shrink each edge by the
    // square root of the overshoot, with a margin.
    const ratio = Math.sqrt(budgetBytes / Math.max(1, encoded.byteLength));
    const nextEdge = Math.max(
      MIN_EDGE_PX,
      Math.min(edge - 1, Math.floor(edge * ratio * 0.9)),
    );
    image = scaledToEdge(image, nextEdge);
    qualityIndex = Math.min(qualityIndex + 1, QUALITY_STEPS.length - 1);
  }
  return { ok: false, reason: 'over_budget' };
}
