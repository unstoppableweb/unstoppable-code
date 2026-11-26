/**
 * Whether the one-window work (CAN-7750) is on for this computer: tasks
 * from paired computers in the main window instead of a separate window
 * per computer.
 *
 * `choice` is the saved `oneWindowEnabled` preference. Without one, the
 * build decides: on for internal builds, off for every other build. Main
 * and the window both resolve it here from the same saved choice and the
 * same compiled release flavor, so they always agree.
 */
export function resolveOneWindowEnabled(
  choice: boolean | undefined,
  releaseFlavor: string,
): boolean {
  return choice ?? releaseFlavor === 'internal';
}
