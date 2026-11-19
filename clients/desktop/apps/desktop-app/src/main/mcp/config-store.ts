import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import {
  getDataDir,
  getMcpRemovalEvidenceDir,
  getMcpServersIndexFilePath,
  getMcpServerFilePath,
} from '../lib/paths';
import { McpConfigRepository, mcpConfigDisk } from './config-repository';
import { createMcpRemovalEvidenceHost } from './config-removal-disk';
import {
  assertMcpConfigAdmission,
  assertMcpRemovalEvidenceAdmission,
} from './config-writer-admission';

/** Single production config/index authority; root resolvers follow canonical relocation. */
export const mcpConfigRepository: McpConfigRepository = new McpConfigRepository(
  { index: getMcpServersIndexFilePath, server: getMcpServerFilePath },
  mcpConfigDisk,
  createMcpRemovalEvidenceHost({
    root: getMcpRemovalEvidenceDir,
    dataRoot: getDataDir,
    serverPath: getMcpServerFilePath,
    secureFiles: hostPlatformServices(
      createPlatformEndpointServices(hostPlatformOperatingSystem()),
    ).secureFiles,
    assertAdmission: () => {
      assertMcpConfigAdmission();
      assertMcpRemovalEvidenceAdmission();
    },
  }),
);
