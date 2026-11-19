import {
  MCP_REMOVAL_GRANT,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  McpRemovalCandidatesResult,
  ForceMcpRemovalRequest,
  ForceMcpRemovalResult,
  InspectMcpRemovalRequest,
  InspectMcpRemovalResult,
} from '@canopy/protocol/mcp-removal';
import { getDesktopCanopyRuntime } from './desktop-runtime-access';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-mcp-removal',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: ['core.catalog.read', MCP_REMOVAL_GRANT],
};

/** Explicit local-user repair or saved approved repair only; never ordinary-delete fallback. */
export function forceMcpRemovalThroughCore(
  request: ForceMcpRemovalRequest,
): Promise<ForceMcpRemovalResult> {
  return getDesktopCanopyRuntime().instruction(
    'core.catalog.mcpServer.removal.force',
    request,
    { caller },
  );
}

export function inspectMcpRemovalThroughCore(
  request: InspectMcpRemovalRequest,
): Promise<InspectMcpRemovalResult> {
  return getDesktopCanopyRuntime().query(
    'core.catalog.mcpServer.removal.inspect',
    request,
    { caller },
  );
}

export function listMcpRemovalCandidatesThroughCore(): Promise<McpRemovalCandidatesResult> {
  return getDesktopCanopyRuntime().query(
    'core.catalog.mcpServer.removal.candidates',
    {},
    { caller },
  );
}
