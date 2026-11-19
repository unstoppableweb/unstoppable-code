import type { CoreMcpRemovalHost } from '@canopy/core-runtime/node/catalog';

/** Lazy imports keep catalog startup independent of MCP inventory and OAuth state. */
export function createDesktopMcpRemovalHost(): CoreMcpRemovalHost {
  return {
    candidates: async () => {
      const { listDeviceMcpRemovalCandidates } =
        await import('../ipc/mcp-servers');
      return listDeviceMcpRemovalCandidates();
    },
    inspect: async (request) => {
      const { inspectDeviceMcpRemoval } = await import('../ipc/mcp-servers');
      return inspectDeviceMcpRemoval(request);
    },
    force: async (request, caller) => {
      const { forceDeviceMcpRemoval } = await import('../ipc/mcp-servers');
      return forceDeviceMcpRemoval(request, caller);
    },
  };
}
