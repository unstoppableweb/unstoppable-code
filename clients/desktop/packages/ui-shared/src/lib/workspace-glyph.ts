/**
 * The corner of the 16px workspace identity glyph: this badge, the avatar
 * that covers it, and the skeleton drawn in its place while a worktree is
 * created. It keeps the 24px `rounded-md` control's proportion (8/24) at
 * 16px, written as `--radius-md` less the 3px that proportion removes at
 * this size; it is the glyph's own shape, not a corner nested in the 10px
 * row (which would give 2px).
 */
export const WORKSPACE_GLYPH_RADIUS_CLASS =
  'rounded-[calc(var(--radius-md)-3px)]';
