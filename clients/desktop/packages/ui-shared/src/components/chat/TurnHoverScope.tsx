'use client';

import type { JSX, ReactNode } from 'react';

/**
 * The hover scope of a turn's footer.
 *
 * A turn's footer reacts to the pointer being anywhere over its turn
 * (`group-hover/turn` and `group-data-[hover]/turn` in `TurnTimer`). Tailwind
 * writes those variants as `.x:is(:where(.group\/turn):hover *)`, which the
 * browser can only invalidate by restyling every descendant of the element
 * whose state flipped. With `group/turn` on the turn's own wrapper that was
 * the whole turn, a long reply included: over a thousand elements restyled
 * each time the pointer crossed into or out of a turn, focus moved into or
 * out of one, or a hoisted prompt was hovered.
 *
 * The scope is therefore this wrapper around the footer alone. The turn's
 * wrapper (the element carrying `data-chat-turn-group`) reports its pointer
 * and focus through {@link setTurnHover}, which marks the turn's scopes with
 * `data-hover`, so a flip restyles the footer and nothing else.
 * `display: contents` keeps the footer rows the turn's own flex items.
 */
const TURN_HOVER_SCOPE_SELECTOR = '[data-chat-turn-hover-scope]';
const TURN_SELECTOR = '[data-chat-turn-group]';

/**
 * What holds a turn's footer in its hovered state. `focus` is keyboard or
 * click focus anywhere in the turn, which `group-focus-within/turn` can no
 * longer see now that the scope wraps the footer alone.
 */
type TurnHoverSource = 'pointer' | 'prompt' | 'focus';

/** Sources currently hovering each turn wrapper. No selector reads this. */
const hoveredTurns = new WeakMap<Element, Set<TurnHoverSource>>();

function applyTurnHover(scope: Element, hovered: boolean): void {
  if (scope.hasAttribute('data-hover') !== hovered) {
    scope.toggleAttribute('data-hover', hovered);
  }
}

/**
 * Records that `source` entered or left the turn rendered in `turn` (its
 * `data-chat-turn-group` wrapper) and updates the turn's footer scopes.
 * `prompt` is the turn's hoisted sticky prompt, which sits outside the
 * wrapper and so reports for itself.
 */
export function setTurnHover(
  turn: Element,
  source: TurnHoverSource,
  hovered: boolean,
): void {
  let sources = hoveredTurns.get(turn);
  if (!sources) {
    if (!hovered) return;
    sources = new Set();
    hoveredTurns.set(turn, sources);
  }
  if (hovered) sources.add(source);
  else sources.delete(source);
  const active = sources.size > 0;
  turn
    .querySelectorAll(TURN_HOVER_SCOPE_SELECTOR)
    .forEach((scope) => applyTurnHover(scope, active));
}

/** A footer that mounts under a resting pointer starts out hovered. */
function adoptTurnHover(scope: HTMLDivElement | null): void {
  if (!scope) return;
  const turn = scope.closest(TURN_SELECTOR);
  const sources = turn ? hoveredTurns.get(turn) : undefined;
  applyTurnHover(scope, sources !== undefined && sources.size > 0);
}

export function TurnHoverScope({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      ref={adoptTurnHover}
      className="group/turn contents"
      data-chat-turn-hover-scope=""
    >
      {children}
    </div>
  );
}
