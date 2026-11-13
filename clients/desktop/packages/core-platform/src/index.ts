export * from './platform-services';
export * from './endpoints';
export {
  deriveLocalAuthorityIdentity,
  observeLocalAuthorityRelocation,
  hostLocalAuthorityObservation,
  LocalAuthorityIdentityError,
  type LocalAuthorityIdentity,
  type LocalAuthorityObservation,
} from './local-authority';
export {
  createOwnedChildServices,
  OWNED_CHILD_FILE,
  OwnedChildError,
  type OwnedChildChannel,
  type OwnedChildErrorCode,
  type OwnedChildLaunch,
  type OwnedChildServices,
} from './supervision/owned-child';
export {
  createProcessTableReader,
  type ProcessTableOperations,
} from './supervision/process-table';
export {
  createExecutionProcessServices,
  ExecutionProcessError,
  type ExecutionProcessErrorCode,
} from './supervision/execution-process';
export {
  createPeerIdentityServices,
  type DaemonBuildBinding,
  type DaemonIdentity,
  daemonRequirement,
  type DaemonRequirement,
  type EvidenceCapture,
  type LauncherChannel,
  type LauncherChannelClaim,
  type LauncherIdentity,
  launcherRequirement,
  type LauncherRequirement,
  PEER_IDENTITY_FILE,
  peerEvidenceFor,
  peerCaptureFor,
  type PeerEvidence,
  PeerIdentityError,
  type PeerIdentityErrorCode,
  type PeerIdentityServices,
  type PeerRefusalReason,
} from './peer-identity';
export { createFileIndexingMatchPolicy } from './file-indexing';
export { createNativeTrashServices, type NativeTrashOptions } from './trash';
export {
  createGitReadHost,
  GIT_READ_SELECTION_LIMITS,
  type GitReadHost,
  type GitReadHostCleanupReport,
  type GitReadHostOptions,
  type GitReadSelected,
  type GitReadSelections,
} from './git-read/host';
export {
  createGitWriteHost,
  type GitWriteHost,
  type GitWriteHostOptions,
} from './git-write/host';
export {
  captureWindowsClosureContext,
  createWindowsClosureWitness,
  type WindowsClosureReport,
} from './supervision/windows-closure';

export {
  WINDOWS_PROCESS_FILE,
  windowsPrincipalObserver,
  windowsPrincipalSid,
} from './supervision/windows-process';
export {
  createSecretProtectionServices,
  SECRET_PROTECTION_FILE,
  type SecretProtectionOptions,
} from './secret-protection';

export {
  createNativeArtifactAuthorizer,
  nativeArtifactSnapshotRoot,
  type PreparedNativeArtifact,
  type NativeArtifactAuthorizer,
  type NativeArtifactPreparationOptions,
} from './secret-protection/authorization';
export {
  compiledNativeArtifactCatalog,
  type NativeArtifactCatalog,
} from './secret-protection/catalog';
export {
  createHostTrustGeneration,
  type HostLocalCapability,
  type HostTrustGeneration,
  type PreparedTrustScope,
} from './prepared-trust';
export {
  observeLinuxColdProcess,
  observeLinuxColdProcesses,
  LinuxColdInspectionError,
  type LinuxColdIO,
} from './internal-root-cold/linux';
export {
  WindowsColdInspectionError,
  observeWindowsColdProcess,
  observeWindowsColdProcesses,
  parseWindowsColdObservation,
} from './internal-root-cold/windows';
export { createLinuxColdPathMapper } from './internal-root-cold/linux-mounts';
export type { NativeColdProcess } from './internal-root-cold/types';
