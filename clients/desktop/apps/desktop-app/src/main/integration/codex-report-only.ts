import type { CodexSpawnProfileRequest } from '@canopy/execution-engine/node/codex-runtime';
import type { ThreadStartParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/ThreadStartParams';
import { applyCodexMultiAgentConfig } from '@canopy/execution-engine/lib/codex-multi-agent';
import { getCodexRuntimeService } from '../codex/runtime-service';

const CODEX_REPORT_ONLY_PERMISSION_PROFILE = 'canopy_report_only';

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecordValue(value) ? value : null;
}

function configuredMcpServerNames(configReadResponse: unknown): string[] {
  const response = recordValue(configReadResponse);
  const config = recordValue(response?.config);
  const mcpServers = recordValue(config?.mcp_servers);
  return mcpServers ? Object.keys(mcpServers) : [];
}

function codexReportOnlyPermissionConfig(
  ambientMcpServerNames: readonly string[],
): NonNullable<ThreadStartParams['config']> {
  return {
    permissions: {
      [CODEX_REPORT_ONLY_PERMISSION_PROFILE]: {
        // Codex needs its platform-minimal runtime paths to launch sandboxed
        // processes. Every other path is denied by the restricted profile's
        // default-deny semantics.
        filesystem: { ':minimal': 'read' },
        network: { enabled: false },
      },
    },
    // Empty MCP replacement tables do not suppress named servers inherited
    // from canonical Codex config, so explicitly disable every effective
    // ambient server discovered through config/read.
    mcp_servers: Object.fromEntries(
      ambientMcpServerNames.map((name) => [name, { enabled: false }]),
    ),
    // Remove provider-native tool surfaces which do not live in mcp_servers.
    'features.apps': false,
    'features.browser_use': false,
    'features.browser_use_external': false,
    'features.code_mode_host': false,
    'features.computer_use': false,
    'features.hooks': false,
    'features.image_generation': false,
    'features.in_app_browser': false,
    'agents.enabled': false,
    'features.multi_agent': false,
    'features.multi_agent_v2': false,
    'features.plugins': false,
    'features.shell_tool': false,
    'features.skill_search': false,
    'features.unified_exec': false,
    'features.workspace_dependencies': false,
    web_search: 'disabled',
  };
}

export async function prepareCodexReportOnlyThread(
  cwd: string,
  config: NonNullable<ThreadStartParams['config']>,
  profile: CodexSpawnProfileRequest,
): Promise<
  Pick<
    ThreadStartParams,
    'permissions' | 'dynamicTools' | 'environments' | 'config'
  >
> {
  const response = await getCodexRuntimeService()
    .admin()
    .request('config/read', { cwd }, profile);
  const serverNames = Array.from(
    new Set([
      ...configuredMcpServerNames(response),
      ...Object.keys(recordValue(config.mcp_servers) ?? {}),
    ]),
  );
  return {
    permissions: CODEX_REPORT_ONLY_PERMISSION_PROFILE,
    dynamicTools: [],
    environments: [],
    config: {
      ...applyCodexMultiAgentConfig(config, { enabled: false }),
      ...codexReportOnlyPermissionConfig(serverNames),
    },
  };
}
