/**
 * Whether the transcript's "Scroll to bottom" button shows.
 *
 * The transcript's scroll handler decides it on every scroll event. Kept as
 * the list's own state, the first wheel tick away from the bottom (and the
 * return to it) re-rendered the whole message list in the middle of a scroll
 * to mount or drop one button. The list writes here instead, and only the
 * button subscribes.
 */
export interface ScrollButtonVisibility {
  readonly set: (visible: boolean) => void;
  readonly get: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createScrollButtonVisibility(): ScrollButtonVisibility {
  let visible = false;
  const listeners = new Set<() => void>();
  return {
    set: (next): void => {
      if (next === visible) return;
      visible = next;
      listeners.forEach((listener) => listener());
    },
    get: (): boolean => visible,
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}
