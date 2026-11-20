import {
  CANOPY_STREAM_DEFINITIONS,
  CORE_FEATURE_FLAG_STREAM_DEFINITIONS,
  composeCanopyStreamRegistries,
} from '@canopy/protocol/canopy-core';

/** The desktop dispatcher's streams: the composed registry plus the feature flag events (CAN-4181) the daemon does not serve. */
export const DESKTOP_STREAM_DEFINITIONS = composeCanopyStreamRegistries(
  CANOPY_STREAM_DEFINITIONS,
  CORE_FEATURE_FLAG_STREAM_DEFINITIONS,
);
export type DesktopStreamDefinitions = typeof DESKTOP_STREAM_DEFINITIONS;
