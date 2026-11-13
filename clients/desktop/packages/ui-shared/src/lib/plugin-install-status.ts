// The rules live in @canopy/protocol/plugins, so desktop-shared's shared
// imports apply them too (CAN-6003); this module keeps its import path.
export {
  countPluginsNeedingInstall,
  pluginHasContent,
  pluginNeedsInstall,
} from '@canopy/protocol/plugins';
