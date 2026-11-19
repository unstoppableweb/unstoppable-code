import {
  assertAdmittedWriter,
  STORAGE_OWNERSHIP,
  type StorageOwnershipRow,
  type StorageWriterPrincipal,
} from '@canopy/core-runtime/storage';

/** Config/index ownership stays legacy; these are current-writer assertions. */
export function assertMcpConfigAdmission(
  rows: readonly StorageOwnershipRow[] = STORAGE_OWNERSHIP,
  principal: StorageWriterPrincipal = 'electron_main',
): void {
  for (const namespace of ['mcp_server_configs', 'mcp_servers_index'])
    assertAdmittedWriter(
      namespace,
      principal,
      'main/mcp/config-repository',
      rows,
    );
}

/** Custody renames a config and writes only its own private receipt namespace. */
export function assertMcpRemovalEvidenceAdmission(
  rows: readonly StorageOwnershipRow[] = STORAGE_OWNERSHIP,
  principal: StorageWriterPrincipal = 'electron_main',
): void {
  for (const namespace of ['mcp_server_configs', 'mcp_removal_evidence'])
    assertAdmittedWriter(
      namespace,
      principal,
      'main/mcp/config-removal-disk',
      rows,
    );
}
