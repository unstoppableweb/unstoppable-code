/**
 * Shared geometry for prompts the composer box asks while the agent waits:
 * the plan-approval prompt and the question prompt, whose title row the
 * secret request prompt also uses (`ComposerPromptHeader`). Plan and question
 * are a column (title, answers, text row) on the box's 4px padding, each row
 * adding its own 4px:
 * every circle, x, and send sits 8px from the box's edges, as + and send do
 * on the one-line composer, and a highlighted row keeps 4px from the edge.
 */

/**
 * The answer row's class is defined with the control recipes, which draw it
 * as the `plan-approval-start` presentation; it is re-exported here for the
 * prompts that compose it.
 */
export { COMPOSER_PROMPT_ROW_CLASS } from '../../primitives/control-button-shared';

/**
 * The 32px circle that leads each answer with its number, drawn like + at
 * the start of the composer's row.
 */
export const COMPOSER_PROMPT_ROW_GLYPH_CLASS =
  'flex size-8 shrink-0 items-center justify-center rounded-full inset-ring-[length:var(--border-hairline)] inset-ring-line-secondary text-xs tabular-nums fg-secondary';

/** The answers' list: 4px between rows, so highlights never touch. */
export const COMPOSER_PROMPT_ROWS_CLASS = 'flex flex-col gap-1';

/** The composer box while a prompt shows. */
export const COMPOSER_PROMPT_BOX_CLASS = 'flex flex-col p-1';

/**
 * The text row: the composer's input, with its microphone and send at the
 * end exactly as on the one-line composer, bottom-aligned so a longer note
 * grows upward from them. 8px in plus the editor's own 4px puts the text
 * 16px in, where the title starts; send sits 8px from the box's right and bottom edges.
 */
export const COMPOSER_PROMPT_TEXT_ROW_CLASS =
  'flex items-end gap-2 pt-2 pr-1 pb-1 pl-2';

/**
 * The text row led by a pen in the numbers' column, when typing is one more
 * answer: the circle sits where the numbers do, and the text starts where
 * the answers' labels do (8px gap plus the editor's own 4px, the rows' 12px).
 */
export const COMPOSER_PROMPT_TEXT_ROW_WITH_GLYPH_CLASS =
  'flex items-end gap-2 pt-2 pr-1 pb-1 pl-1';

/**
 * The title row: the title keeps the composer's 16px text inset (circles sit
 * 8px in, text 16px), and x sits 8px from the box's top and right edges, in
 * send's column.
 */
export const COMPOSER_PROMPT_HEADER_CLASS = 'flex gap-2 pt-1 pr-1 pb-1 pl-3';

/**
 * The title row led by a circle in the numbers' column, such as Back: the
 * circle sits where the numbers do, and the title starts where the answers'
 * labels do (the rows' 12px gap).
 */
export const COMPOSER_PROMPT_HEADER_WITH_GLYPH_CLASS =
  'flex gap-3 pt-1 pr-1 pb-1 pl-1';

/**
 * The editor's scroll container in the text row: one 20px line centred on
 * the 32px row, growing to a few lines before it scrolls.
 */
export const COMPOSER_PROMPT_EDITOR_CONTAINER_CLASS =
  'max-h-30 min-h-8 cursor-text overflow-y-auto px-1 py-1.5';

/**
 * Whether the user is typing in a field or terminal outside `root`, where a
 * prompt that just showed must not take focus.
 */
export function isTypingOutside(root: Element | null): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    !root?.contains(active) &&
    (active.isContentEditable ||
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement)
  );
}
