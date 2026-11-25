// The daemon's `core.pipeline.definition.*` composition (CAN-5092 S1b). A
// separate subpath, so hosts that only use the definition service never load
// the runtime graph module or the daemon's host.
export {
  CORE_PIPELINE_DEFINITION_CALLER_GRANTS,
  CORE_PIPELINE_DEFINITION_OPERATIONS,
  CORE_PIPELINE_DEFINITION_OWNER_GRANTS,
  createCorePipelineDefinitionModule,
  createDaemonDefinitionSidecarWriter,
  createDaemonPipelineDefinitionHost,
  DAEMON_PIPELINE_DEFINITION_DEFINITIONS,
  isDaemonPipelineDefinitionOwner,
  type DaemonDefinitionSidecarOptions,
  type DaemonPipelineDefinitionHostOptions,
  type DaemonPipelineDefinitionSources,
  type DaemonPipelineDefinitionSourcesLoader,
  type DaemonPipelineDefinitionWriter,
} from './daemon-definitions';
