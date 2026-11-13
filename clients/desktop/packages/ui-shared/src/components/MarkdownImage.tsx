'use client';

import { type ComponentPropsWithoutRef, type JSX, useState } from 'react';

/**
 * Announced stand-in for a markdown image that is unavailable: a failed load,
 * or a local path the host could not resolve.
 */
export function MarkdownImageUnavailable({
  alt,
}: {
  readonly alt?: string;
}): JSX.Element {
  const trimmedAlt = alt?.trim();
  // Mirrors the desktop local-image fallback so every unavailable image in a
  // transcript reads the same, on desktop and on the web.
  const label = trimmedAlt
    ? `${trimmedAlt} (image unavailable)`
    : 'Image unavailable';
  return (
    <span
      data-testid="markdown-image-unavailable"
      className="text-xs fg-secondary"
      role="img"
      aria-label={label}
    >
      {label}
    </span>
  );
}

/**
 * Markdown image that swaps to {@link MarkdownImageUnavailable} when it fails
 * to load. The failure is keyed by source: a failed `src` is not retried, and
 * only a new `src` (a streamed URL completing, an edited message) tries again,
 * without an effect. It stays one stable component type so streaming
 * re-renders never remount the image. It lives in a client module because the
 * default overrides also reach ServerMarkdown.
 */
export function MarkdownImage({
  src,
  alt,
  onError,
  ...props
}: ComponentPropsWithoutRef<'img'>): JSX.Element {
  const [failedSrc, setFailedSrc] = useState<string | undefined>();
  if (typeof src === 'string' && failedSrc === src) {
    return <MarkdownImageUnavailable alt={alt} />;
  }
  return (
    <img
      {...props}
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={(event) => {
        onError?.(event);
        if (typeof src === 'string') setFailedSrc(src);
      }}
    />
  );
}
