/** Reveal only content opened by a pointer, never streamed or initially open content. */
export function revealDisclosure(
  trigger: HTMLButtonElement,
  scope: 'local' | 'turn',
): void {
  const view = trigger.ownerDocument.defaultView;
  if (!view || view.matchMedia('(prefers-reduced-motion: reduce)').matches)
    return;
  const root =
    scope === 'turn'
      ? turnRoot(trigger)
      : trigger.closest('[data-chat-disclosure]');
  if (!root) return;
  const selector =
    scope === 'turn'
      ? ':scope > [data-role="assistant"], :scope > [data-testid^="chat-tool-step"]'
      : ':scope > [data-chat-reveal-body]';
  // StepRow calls this before toggling. Keep the existing reply out of the
  // turn reveal; it only changes position to make room for the opened work.
  const existing = new Set(
    scope === 'turn' ? root.querySelectorAll<HTMLElement>(selector) : [],
  );
  view.requestAnimationFrame(() => {
    if (
      !trigger.isConnected ||
      trigger.getAttribute('aria-expanded') !== 'true'
    )
      return;
    const targets = Array.from(root.querySelectorAll<HTMLElement>(selector))
      .filter((target) => !existing.has(target))
      .flatMap((target) => {
        if (target.hasAttribute('data-chat-disclosure')) return [target];
        const rows = Array.from(
          target.querySelectorAll<HTMLElement>('[data-chat-disclosure]'),
        );
        // Animate each whole row, including its details, never both a row
        // and its enclosing stack (which would compound the transforms).
        return rows.length === 0
          ? [target]
          : rows.filter(
              (row) =>
                !rows.some((other) => other !== row && other.contains(row)),
            );
      });
    for (const [index, target] of targets.entries()) {
      if (typeof target.animate !== 'function') continue;
      target.getAnimations().forEach((animation) => animation.cancel());
      target.animate(
        [
          { opacity: 0, transform: 'translateY(2px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        {
          duration: 180,
          delay: Math.min(index * 24, 96),
          fill: 'backwards',
          easing: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
        },
      );
    }
  });
}

/**
 * The turn a header belongs to: its `group/turn` wrapper (web) or its
 * `data-chat-turn-group` wrapper (desktop). A header the desktop transcript
 * pins in its section head sits outside that wrapper; the head names the
 * turn by its user message, and the turn is a sibling in the same section.
 */
function turnRoot(trigger: HTMLElement): Element | null {
  const own = trigger.closest('.group\\/turn, [data-chat-turn-group]');
  if (own) return own;
  const head = trigger.closest<HTMLElement>('[data-sticky-user-message-id]');
  const id = head?.dataset.stickyUserMessageId;
  if (!head || id === undefined) return null;
  return (
    head.parentElement?.querySelector(
      `[data-chat-turn-group="${CSS.escape(id)}"]`,
    ) ?? null
  );
}
