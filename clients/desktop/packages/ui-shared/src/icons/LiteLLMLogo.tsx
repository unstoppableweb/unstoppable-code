import type { JSX, SVGProps } from 'react';

/* eslint-disable shadcn/no-raw-colors -- LiteLLM's official blue. DESIGN.md keeps provider-owned brand colors literal. */

/**
 * LiteLLM's train monogram, from BerriAI/litellm (MIT)
 * `ui/litellm-dashboard/public/assets/logos/litellm_monogram.svg`, optimized
 * with svgo, in its brand blue. The train is cut out of the tile, so a white
 * backing, inset to stay inside the tile's rounded edge, keeps it a white
 * train on a dark background too, as litellm.ai shows it. The viewBox pads
 * the full-bleed tile by 2 units on a 24 grid, as OpenRouter's mark is.
 */
export function LiteLLMLogo(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="-37.2 -37.5 446.6 446.6"
      fill="#0117BE"
      {...props}
    >
      <rect x="6" y="6" width="360" height="359.5" rx="32" fill="#fff" />
      <path d="M296.1 254.2c7.8-1.1 7.4-12.5.4-13.3-6.6-.8-14.5.8-21.2-.3l-50.8.4a6.8 6.8 0 0 0 1 13.3z" />
      <path d="M309.4 196.8a777 777 0 0 0-110-35.8c-33-8.7-69.9-17-103.7-21.4-32-4.1-63.5-3.4-95.5-3.2v6.6c36.2-.6 71.4.4 107.3 5.9a1028 1028 0 0 1 145.8 34 584 584 0 0 1 79.2 31v68c12.5-2 31.3-8.9 39.4-20.4V237c-11-17.2-45.3-32.7-62.5-40ZM14.8 115.7l-.2.4q35 .3 70 4.7c37 5 75.6 13.6 111.4 24 18 5.3 35 13.3 54.2 12.3 4.1-.2 8.3-1.1 12.4-1.5l-.6-.8A380 380 0 0 0 0 85.1L.2 117l10.4-1z" />
      <path d="M333.8-.4 37.6.1A37.6 37.6 0 0 0 0 37.9v39a330 330 0 0 1 125 5.6c55 12.9 104.4 41.3 151 72 22.8 15 46.7 30.8 68.2 47.4 9 6.8 19.9 15 27.6 24.6l-.3-189.2c0-20.8-17-37.7-37.8-37.7M92 245.6h63.5l-48-66.7c-.6-.8-4-2.7-4.7-2.7h-4.7v.1H.2L.3 246l91.8-.1zM.4 298.3v35.6c0 20.9 17 37.7 37.8 37.7l296.1-.4c20.8 0 37.7-17 37.7-37.8l-.1-59.3c-17.4 19-52.2 22.1-75.7 23.7zm158.6-45H98.6v.3H55.8q-1.4.3-2.2 0l-53.3.1v9.8l166.4-.2c-1.5-1.7-5.8-9.7-7.6-10" />
    </svg>
  );
}
