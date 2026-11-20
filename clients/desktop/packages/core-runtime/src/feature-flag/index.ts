// `core.featureFlag.*` (CAN-4181): the flag values core owns or shares, read
// from the host evaluator through `CoreFeatureFlagHost`.
export {
  createCoreFeatureFlagHandlers,
  type CoreFeatureFlagHandlerOptions,
  type CoreFeatureFlagHandlers,
  type CoreFeatureFlagHost,
} from './handlers';
