export const TERMINAL_PRESET_IMAGE_MAX_DATA_URL_LENGTH = 1_000_000;

export const TERMINAL_PRESET_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
] as const;

export type TerminalPresetImageMimeType =
  (typeof TERMINAL_PRESET_IMAGE_MIME_TYPES)[number];

export const TERMINAL_PRESET_IMAGE_ACCEPT =
  TERMINAL_PRESET_IMAGE_MIME_TYPES.join(',');

const TERMINAL_PRESET_IMAGE_MIME_TYPE_SET = new Set<string>(
  TERMINAL_PRESET_IMAGE_MIME_TYPES,
);

export function isTerminalPresetImageMimeType(
  value: string,
): value is TerminalPresetImageMimeType {
  return TERMINAL_PRESET_IMAGE_MIME_TYPE_SET.has(value.toLowerCase());
}

export function getTerminalPresetImageMaxFileBytes(
  mimeType: TerminalPresetImageMimeType,
): number {
  const prefixLength = `data:${mimeType};base64,`.length;
  const base64Groups = Math.floor(
    (TERMINAL_PRESET_IMAGE_MAX_DATA_URL_LENGTH - prefixLength) / 4,
  );
  return base64Groups * 3;
}

export function isTerminalPresetImageDataUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/i.test(value) &&
    value.length <= TERMINAL_PRESET_IMAGE_MAX_DATA_URL_LENGTH
  );
}
