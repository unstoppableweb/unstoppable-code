'use client';

import { useEffect, useState, type JSX } from 'react';

/**
 * A raster artifact (PNG, JPEG, GIF, WebP) in an `<img>` from a blob URL,
 * revoked on unmount and on change. SVG never comes here: it renders in the
 * sandbox.
 */
export function ImageArtifact({
  bytes,
  mediaType,
  title,
  onFailure,
}: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly title: string;
  readonly onFailure: () => void;
}): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(
      new Blob([new Uint8Array(bytes)], { type: mediaType }),
    );
    setUrl(objectUrl);
    return (): void => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [bytes, mediaType]);
  if (url === null) return null;
  return (
    <div className="flex w-full justify-center p-6">
      <img
        src={url}
        alt={title}
        className="h-auto max-w-full"
        data-testid="shared-artifact-image"
        onError={onFailure}
      />
    </div>
  );
}
