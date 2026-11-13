import type { JsonValue } from './generated/serde_json/JsonValue';
import type { SelectedCapabilityRoot } from './generated/v2/SelectedCapabilityRoot';

export interface CodexCapabilityLease {
  rootContentId: string;
  routeIds?: string[];
}

export interface CodexCapabilitySnapshot {
  id: string;
  dynamicToolSetId: string;
  roots: SelectedCapabilityRoot[];
  extraMcpServers: Record<string, JsonValue>;
  leases: CodexCapabilityLease[];
  warnings: string[];
}

export interface CodexCapabilityLeaseFile {
  version: 1;
  threadId: string;
  snapshotId: string;
  rootContentIds: string[];
  kind: 'persisted-chat' | 'persisted-helper' | 'ephemeral';
  reasoningRouteFamily?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}
