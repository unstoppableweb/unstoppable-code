// Production wiring of the usage analytics opt-out ping (CAN-6069): the real
// policy, stored-choice read, quit flag, marker file, cloud base URL and fetch.

import { app } from 'electron';
import { BRAND } from '@canopy/brand/current';
import { compiledBuildIdentity } from '@canopy/core-runtime/node/build-identity';
import {
  USAGE_ANALYTICS_OPT_OUT_CHANNELS,
  USAGE_ANALYTICS_OPT_OUT_PATH,
} from '@canopy/protocol/usage-analytics-optout';
import { getCanopyCloudBaseUrl } from '../canopy-cloud/config';
import { readStoredProductAnalyticsChoice } from '../lib/preferences-store';
import { getUsageDataPolicy } from '../lib/usage-data-policy';
import { allowsAutomaticCall } from '../local-only/policy';
import { createFileOptOutMarkerStore } from './marker-store';
import {
  startUsageAnalyticsOptOutPing,
  type OptOutChannel,
  type UsageAnalyticsOptOutPingHandle,
} from './ping';

/**
 * The channel is the build's compiled product identity, which the bundler sets
 * from `CANOPY_RELEASE_FLAVOR` and leaves at `dev` when none is configured
 * (electron.vite.config.ts, `buildIdentityDefines`). `__CANOPY_RELEASE_FLAVOR__`
 * and `getCanopyReleaseFlavor` can't tell: both fall back to `stable`, so a
 * locally packaged build without a flavor would count as a stable release.
 * A `dev` identity has no channel, and neither does an identity that can't be
 * read. An E2E build is not a release build, whatever flavor it was built with.
 */
function readBuildChannel(): OptOutChannel | null {
  if (__CANOPY_E2E__) return null;
  let build: string;
  try {
    build = compiledBuildIdentity(BRAND.id).build;
  } catch {
    return null;
  }
  return USAGE_ANALYTICS_OPT_OUT_CHANNELS.find((c) => c === build) ?? null;
}

/**
 * `isQuitting` is main's quit flag, set before any quit await. The sender reads
 * it before every step and right before a request, so nothing new starts once
 * a quit begins, and a sender whose quit began first never starts.
 */
export function startProductionUsageAnalyticsOptOutPing(
  isQuitting: () => boolean,
): UsageAnalyticsOptOutPingHandle {
  return startUsageAnalyticsOptOutPing({
    channel: readBuildChannel(),
    isPackaged: app.isPackaged,
    allowsAutomaticCall: allowsAutomaticCall(
      'telemetry.usage-analytics-optout',
    ),
    policy: getUsageDataPolicy(),
    readStoredProductAnalytics: readStoredProductAnalyticsChoice,
    isQuitting,
    markerStore: createFileOptOutMarkerStore(() => app.getPath('userData')),
    resolveEndpointUrl: () =>
      `${getCanopyCloudBaseUrl()}${USAGE_ANALYTICS_OPT_OUT_PATH}`,
    // The one network call: a plain fetch with no cookies, credentials or
    // auth header (the `init` is fixed by the sender).
    fetch: (url, init) => fetch(url, init),
  });
}
