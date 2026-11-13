/** Corner of the window that holds the in-app notification stack. */
export type InAppNotificationPlacement =
  | 'top-right'
  | 'bottom-right'
  | 'top-left'
  | 'bottom-left';

/**
 * The corner used when no placement is chosen. Bottom-right keeps default
 * toasts clear of the header's controls.
 */
export const DEFAULT_IN_APP_NOTIFICATION_PLACEMENT: InAppNotificationPlacement =
  'bottom-right';

export interface InAppNotificationContainerOptions {
  /**
   * Start a top corner below the app header (48px plus an 8px gap), so the
   * stack never covers the header's buttons. Bottom corners are unaffected.
   */
  readonly clearHeader?: boolean;
}

/**
 * Width of the notification stack, in CSS pixels: a macOS notification banner
 * is 344pt wide, so in-app toasts match the system ones beside them. The
 * column is `21.5rem` (344px at the 16px root) and never wider than the
 * window less its 16px margins, so on a phone it fills the screen instead.
 */
export const IN_APP_NOTIFICATION_WIDTH_PX = 344;

// One literal class per token so Tailwind can see each of them.
const COLUMN =
  'pointer-events-none fixed z-toast flex w-[min(21.5rem,calc(100vw-2rem))] flex-col gap-2';

/** Shared notification viewport placement for independent desktop windows. */
export function getInAppNotificationContainerClasses(
  placement: InAppNotificationPlacement,
  { clearHeader = false }: InAppNotificationContainerOptions = {},
): string {
  switch (placement) {
    case 'top-right':
      return `${COLUMN} right-4 ${clearHeader ? 'top-14' : 'top-4'}`;
    case 'bottom-left':
      return `${COLUMN} bottom-4 left-4`;
    case 'top-left':
      return `${COLUMN} left-4 ${clearHeader ? 'top-14' : 'top-4'}`;
    case 'bottom-right':
      return `${COLUMN} bottom-4 right-4`;
  }
}
