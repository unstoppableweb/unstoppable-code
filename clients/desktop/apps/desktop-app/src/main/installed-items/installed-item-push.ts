/** Host-only routing data, never sent to an Electron renderer. */
export interface InstalledItemPushCorrelation {
  readonly senderId: number;
  readonly installRefreshToken: string;
}

const correlations = new WeakMap<object, InstalledItemPushCorrelation>();

/** A fresh identity per publication, shared by all copies of that push. */
export function installedItemPush(
  correlation?: InstalledItemPushCorrelation,
): object {
  const notice = {};
  if (correlation !== undefined) correlations.set(notice, correlation);
  return notice;
}

export function readInstalledItemPushCorrelation(
  notice: unknown,
): InstalledItemPushCorrelation | undefined {
  return typeof notice === 'object' && notice !== null
    ? correlations.get(notice)
    : undefined;
}
