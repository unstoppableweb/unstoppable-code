import { TextDecoder } from 'node:util';
import type { Plugin } from 'vite';
// Relative, not `@canopy/...`: electron-vite loads this config with every
// bare import external, and Node can't load those packages' TypeScript.
import {
  findSharedTextCredentialRule,
  type SharedTextCredentialRule,
} from '../../../../../packages/protocol/src/shared-containers/capability-definitions';
import {
  atRuleName,
  BLOCK_AT_RULES,
  blockStart,
  splitTopLevel,
} from '../../../../../packages/desktop-instrumentation/src/client/stylesheet-items';
import type { RendererBundleOutput } from './renderer-react-work-hook';

/**
 * Build check for the renderer's stylesheets (CAN-7593). Session replay
 * records every linked stylesheet, and the desktop `before_send` masks a rule
 * the shared credential check flags, so a credential-shaped string in the
 * app's own CSS would be masked out of every recording. The build fails
 * instead, naming the asset, the check's rule, the offset and the item, never
 * the matched text or its selector.
 */

/** The longest sheet session replay scans (UTF-16 code units); longer ones are emptied. */
export const MAX_RENDERER_STYLESHEET_LENGTH = 4 * 1024 * 1024;

export type StylesheetCredentialHit =
  | { rule: SharedTextCredentialRule; offset: number; item: number }
  | { rule: SharedTextCredentialRule; offset: null; item: null };

/** The innermost flagged items in `css`, at absolute offsets from `base`. */
function locateFlaggedItems(
  css: string,
  base: number,
): Array<{ rule: SharedTextCredentialRule; offset: number }> {
  const items = splitTopLevel(css);
  if (items === null) return [];
  const found: Array<{ rule: SharedTextCredentialRule; offset: number }> = [];
  let offset = base;
  for (const item of items) {
    const rule = findSharedTextCredentialRule(item);
    if (rule !== null) {
      const name = atRuleName(item);
      const open = blockStart(item);
      const nested =
        name !== null &&
        BLOCK_AT_RULES.has(name) &&
        open !== -1 &&
        item.endsWith('}') &&
        findSharedTextCredentialRule(item.slice(0, open)) === null
          ? locateFlaggedItems(item.slice(open + 1, -1), offset + open + 1)
          : [];
      found.push(...(nested.length > 0 ? nested : [{ rule, offset }]));
    }
    offset += item.length;
  }
  return found;
}

/**
 * Where the shared credential check flags `css`: each innermost flagged rule
 * with its offset and top-level item index, or one unlocated hit when the text
 * trips only as a whole (across items) or can't be split. Empty when it passes.
 */
export function findStylesheetCredentialHits(
  css: string,
): StylesheetCredentialHit[] {
  const rule = findSharedTextCredentialRule(css);
  if (rule === null) return [];
  const items = splitTopLevel(css);
  if (items === null) return [{ rule, offset: null, item: null }];
  const ends: number[] = [];
  let end = 0;
  for (const item of items) ends.push((end += item.length));
  const located = locateFlaggedItems(css, 0).map((hit) => ({
    ...hit,
    item: ends.findIndex((itemEnd) => hit.offset < itemEnd),
  }));
  return located.length > 0 ? located : [{ rule, offset: null, item: null }];
}

function describeHit(
  fileName: string,
  hit: StylesheetCredentialHit,
  splittable: boolean,
): string {
  if (hit.offset !== null)
    return `${fileName}: ${hit.rule} at offset ${hit.offset} (item ${hit.item})`;
  return `${fileName}: ${hit.rule}, ${splittable ? 'across items' : 'not splittable'}`;
}

/** `<file>: <problem>` for every renderer stylesheet the build must not ship. */
export function findRendererStylesheetProblems(
  outputs: readonly RendererBundleOutput[],
): string[] {
  const stylesheets = outputs.filter(
    (output): output is Extract<RendererBundleOutput, { type: 'asset' }> =>
      output.type === 'asset' && output.fileName.endsWith('.css'),
  );
  if (stylesheets.length === 0) return ['no CSS asset in the renderer bundle'];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const problems: string[] = [];
  for (const { fileName, source } of stylesheets) {
    let css: string;
    try {
      css = typeof source === 'string' ? source : decoder.decode(source);
    } catch {
      problems.push(`${fileName}: not valid UTF-8`);
      continue;
    }
    if (css.length > MAX_RENDERER_STYLESHEET_LENGTH) {
      problems.push(
        `${fileName}: ${css.length} UTF-16 code units, over the ${MAX_RENDERER_STYLESHEET_LENGTH} session replay scans`,
      );
      continue;
    }
    const splittable = splitTopLevel(css) !== null;
    for (const hit of findStylesheetCredentialHits(css))
      problems.push(describeHit(fileName, hit, splittable));
  }
  return problems;
}

/** Fails every renderer build whose stylesheets session replay would have to mask. */
export function rendererStylesheetCredentialPlugin(): Plugin {
  return {
    name: 'canopy:renderer-stylesheet-credentials',
    apply: 'build',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_outputOptions, bundle): void {
        const problems = findRendererStylesheetProblems(Object.values(bundle));
        if (problems.length > 0) {
          this.error(
            `The renderer stylesheet must pass the shared credential check (CAN-7593); fix the source rule, since session replay would mask it from every recording:\n  ${problems.join('\n  ')}`,
          );
        }
      },
    },
  };
}
