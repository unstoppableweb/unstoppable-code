import type { JSX, SVGProps } from 'react';

/* eslint-disable shadcn/no-raw-colors -- Requesty's official blue and white. DESIGN.md keeps provider-owned brand colors literal. */

/**
 * Requesty's terminal-bubble mark, from requestyai/n8n-requesty (MIT)
 * `icons/requesty.svg`: the bubble and its prompt only, without the wordmark
 * the file carries outside its viewBox, optimized with svgo. The viewBox pads
 * the bubble by 2 units on a 24 grid, as OpenRouter's mark is.
 */
export function RequestyLogo(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="49.7 38.2 393.6 393.6"
      {...props}
    >
      <path
        fill="#1676FE"
        d="m130 90.7 19.7 1.2 15 .9 56.9 3.4 2.4.1 11.7.6 56 3.4 46 2.6 28.3 1.5 14.6.6c8.5.4 14.1 2.5 20.7 7.9 9.2 10.6 9.3 21.4 8.5 35l-2.2 26.5-1.2 15-.3 2.6-4.1 52.7-2.7 37.2c-1.7 23-1.7 23-7.3 33.1h-2l-.6 1.7c-4 6.6-11.2 8.6-18.4 10.3q-5.5.7-11 1l-3.2.3-10.4.6-57.1 4L255 335a28 28 0 0 0-22.1 10.6l-6.3 6.8q-7.4 7.8-14.3 15.9-3 3.3-6.2 6.5l-2.3 2.3c-2.8 2.6-4.6 3-8.3 3l-2.4.1c-2.7-.4-3.5-1.2-5.2-3.3-3.4-6.8-2.3-17-2.6-24.6v-3.6l-.4-8.8-1.6.5q-4.5.8-9 1l-4 .2-12.6.8-2.1.1-10.8.9c-12 1-23 .1-32.8-7.5a31 31 0 0 1-10.8-20.4l-.4-3.3-.3-3.5-.4-3.8-3-31.6-3.7-40.9a5557 5557 0 0 1-7.1-77.5l-.9-8.6c-3.2-32.4-3.2-32.4 4-42.6 11.6-13.5 24-14.2 40.6-13"
      />
      <path
        fill="#fff"
        d="M151 153c9 2 17.9 5.8 26.3 9.8l11.5 4.9 10 4.3a229 229 0 0 0 17.8 6.7q4.9 2 9.3 4.3 5.2 2.4 10.5 4.5l2.2 1L257 196v32l-9.7 4.2-3 1.3-26.3 11-15 6.2-22.4 9.2q-9.2 3.7-18 8C160 269 160 269 158 269a230 230 0 0 1-2-34l7-2.5 2.3-.8 13.5-4.7q15.2-5.1 30.2-11l3-1.2 7-2.8-10-3.6q-10.8-3.8-21.8-7.2l-2.4-.8L153 190l-1.3-18q-.7-9.4-.7-19M350 263v22a907 907 0 0 1-47.1 2.7q-9.3.2-18.4 1c-5.5.6-11 .4-16.5.3v-24a1765 1765 0 0 1 82-2"
      />
    </svg>
  );
}
