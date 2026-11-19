/**
 * IPC channel names for the plugins / marketplaces subsystem.
 *
 * Channel strings are part of the wire contract between preload and main.
 * Renderer code must reference them via this constant rather than the literal
 * channel name to keep both ends in sync.
 */
export const PLUGINS_CHANNELS = {
  LOAD: 'plugins:load',
  /**
   * Cache-only read. Unlike {@link PLUGINS_CHANNELS.LOAD}, this never falls
   * through to a full `refreshMarketplaces()` when the cache is missing, so it
   * cannot spawn the provider `marketplace update` commands. For callers that
   * only want to know what is already known — e.g. the onboarding wizard
   * deciding whether curated plugins exist — on a path where a heavy refresh
   * would be inappropriate.
   */
  LOAD_CACHE_ONLY: 'plugins:loadCacheOnly',
  RESOLVE_PORTABLE_REFS: 'plugins:resolve-portable-refs',
  RESOLVE_PORTABLE_ENABLE_REF: 'plugins:resolve-portable-enable-ref',
  REFRESH: 'plugins:refreshMarketplaces',
  ADD: 'plugins:addMarketplace',
  UPDATE: 'plugins:updateMarketplace',
  REMOVE: 'plugins:removeMarketplace',
  OPERATION_PROGRESS: 'plugins:operation-progress',
  READ_COMPONENT: 'plugins:read-component',
  /**
   * Customize's light preview of a catalog plugin not added yet: its
   * repository listing and native manifests, read without cloning (spec 3b).
   */
  PREVIEW_MANIFEST: 'plugins:preview-manifest',
  INSTALL_PLUGIN: 'plugins:install-plugin',
  INSTALL_BUILT_IN_PLUGIN: 'plugins:install-built-in-plugin',
  PREPARE_CODEX_COMPATIBILITY: 'plugins:prepare-codex-compatibility',
  SET_CODEX_COMPAT_DISABLED: 'plugins:set-codex-compat-disabled',
  // One Add for every harness, for plugins and skills (CAN-6816).
  INSTALL_FOR_HARNESSES: 'plugins:install-for-harnesses',
  RETRY_HARNESS_INSTALL: 'plugins:retry-harness-install',
  // Shared Canopy Cloud plugin registry. Requests carry portable refs and
  // display metadata only; the main process resolves the singleton Cloud
  // backend and never sends local paths or credentials in the payload.
  SHARED_LIST: 'plugins:shared-list',
  SHARED_GET: 'plugins:shared-get',
  SHARED_CREATE: 'plugins:shared-create',
  SHARED_UPDATE: 'plugins:shared-update',
  SHARED_DELETE: 'plugins:shared-delete',
  SHARED_PUBLIC_PUBLISH: 'plugins:shared-public-publish',
  SHARED_PUBLIC_REVOKE: 'plugins:shared-public-revoke',
  SHARED_REFERENCE_ANALYZE: 'plugins:shared-reference-analyze',
} as const;
