'use client';

import { useEffect, useState } from 'react';
import { imageReferrerPolicyFor } from './first-party-image-referrer';

/**
 * Whether a logo image fills its own square (New Customize, Sergii's QA): a
 * purple UD tile or a photo avatar is opaque to its edges and needs no light
 * plate, which would only show as a ring around it. Transparent dark art
 * (Amazon's "a") keeps the plate. Read once per URL from a tiny canvas;
 * `undefined` while unknown, and for an image the canvas may not read
 * (a cross-origin image without CORS), which keeps today's plate.
 */
const results = new Map<string, boolean | undefined>();
const pending = new Map<string, Promise<boolean | undefined>>();

/** Side of the sampling canvas: enough to see a transparent margin. */
const SAMPLE = 24;
/** An edge pixel at or above this alpha counts as opaque (0–255). */
const OPAQUE_ALPHA = 230;
/** The share of edge pixels that must be opaque. */
const OPAQUE_SHARE = 0.9;

function measure(src: string): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof Image === 'undefined') {
      resolve(undefined);
      return;
    }
    const image = new Image();
    // A data or same-origin URL reads either way; a remote one reads only
    // when its server allows CORS, and otherwise fails to the plate.
    if (!src.startsWith('data:')) image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    // The same referrer policy as the displayed logo: a third-party host
    // learns nothing from the probe either.
    image.referrerPolicy = imageReferrerPolicyFor(src);
    image.onload = (): void => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SAMPLE;
        canvas.height = SAMPLE;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
          resolve(undefined);
          return;
        }
        context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
        const { data } = context.getImageData(0, 0, SAMPLE, SAMPLE);
        let edge = 0;
        let opaque = 0;
        for (let y = 0; y < SAMPLE; y += 1)
          for (let x = 0; x < SAMPLE; x += 1) {
            if (x !== 0 && y !== 0 && x !== SAMPLE - 1 && y !== SAMPLE - 1)
              continue;
            edge += 1;
            if ((data[(y * SAMPLE + x) * 4 + 3] ?? 0) >= OPAQUE_ALPHA)
              opaque += 1;
          }
        resolve(edge > 0 && opaque / edge >= OPAQUE_SHARE);
      } catch {
        // A tainted canvas: the image is shown, but cannot be read.
        resolve(undefined);
      }
    };
    image.onerror = (): void => resolve(undefined);
    image.src = src;
  });
}

function edgeOpacity(src: string): Promise<boolean | undefined> {
  const known = pending.get(src);
  if (known) return known;
  const next = measure(src).then((result) => {
    results.set(src, result);
    return result;
  });
  pending.set(src, next);
  return next;
}

/** True once the logo at `src` is known to be opaque to its edges. */
export function useLogoOpaqueEdges(src: string | undefined): boolean {
  const [opaque, setOpaque] = useState<boolean>(() =>
    src === undefined ? false : results.get(src) === true,
  );
  useEffect(() => {
    if (src === undefined) {
      setOpaque(false);
      return undefined;
    }
    if (results.has(src)) {
      setOpaque(results.get(src) === true);
      return undefined;
    }
    let live = true;
    void edgeOpacity(src).then((result) => {
      if (live) setOpaque(result === true);
    });
    return (): void => {
      live = false;
    };
  }, [src]);
  return opaque;
}
