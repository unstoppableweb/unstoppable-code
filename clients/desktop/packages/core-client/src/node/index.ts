// Node entry point (@canopy/core-client/node): socket and named-pipe
// connectors, descriptor discovery, and the attach-or-start launcher.
export {
  connectCanopyClient,
  connectCanopyFramedConnection,
  type CanopyConnectOptions,
} from './connect';
export {
  CANOPY_DAEMON_CLAIM_HANDOFF_ENV,
  CANOPY_DAEMON_OWNER_HANDOFF,
  createCanopyDaemonHostLaunch,
  type CanopyDaemonHostLaunch,
  type CanopyDaemonHostLaunchOptions,
  type CanopyDaemonHostSupervision,
  type CanopyOwnedDaemonChild,
  type CanopyDaemonMigrationLaunch,
  type CanopyOwnedDaemonChildren,
} from './daemon-host';
export {
  createDaemonOwnerCredential,
  type DaemonOwnerCredential,
} from './daemon-owner';
export {
  CANOPY_DAEMON_W5_HOST_CHECK,
  classifyCanopyDaemonCapability,
  probeCanopyDaemon,
  waitForCanopyDaemonRelease,
  type CanopyDaemonCapability,
  type CanopyDaemonCapabilityInput,
  type CanopyDaemonProbe,
  type CanopyDaemonProbeOptions,
  type CanopyDaemonReleaseWaitOptions,
} from './daemon-handoff';
export {
  CANOPY_DAEMON_REFUSALS,
  canopyDaemonRefusal,
  canopyDaemonRefusalError,
  type CanopyDaemonRefusal,
} from './daemon-refusal';
export type { CanopyClientEndpoint } from './endpoint';
/** Hosts may extend the launch budget through their post-connect capability checks. */
export { Deadline as CanopyDaemonDeadline } from './launch-deadline';
export {
  attachOrStartCanopyDaemon,
  type CanopyDaemonBeforeSpawn,
  type CanopyDaemonLaunchOptions,
  type CanopyDaemonLaunchResult,
} from './launcher';
export {
  classifyCanopyDescriptor,
  parseCanopyRuntimeDescriptor,
  type CanopyDescriptorClassifyInput,
  type CanopyDescriptorState,
} from './descriptor';
export type {
  CanopyDaemonProcessInspector,
  CanopyRuntimeDescriptor,
  CanopyRuntimeDescriptorSource,
} from './daemon-ports';
export type {
  CanopyDaemonSpawnCommand,
  CanopyDaemonSupervisor,
  CanopySpawnedDaemon,
  CanopyStartupClaimAcquisition,
  CanopyStartupClaimHandle,
  CanopyStartupClaimPort,
} from './launcher-ports';
export {
  createRecoverableCanopyStartupClaim,
  type CanopyRetainedStartupClaimPort,
} from './recoverable-startup-claim';

export { executeW5Recovery, type W5RecoveryLaunchOptions } from './w5-recovery';
