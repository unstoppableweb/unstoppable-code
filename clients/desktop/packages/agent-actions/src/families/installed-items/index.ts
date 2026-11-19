import type {
  McpRemovalCandidatesResult,
  InspectMcpRemovalRequest,
  InspectMcpRemovalResult,
  ForceMcpRemovalRequest,
  ForceMcpRemovalResult,
} from '@canopy/protocol/mcp-removal';
import { AgentPortError } from '../../port/environment-port';
import type { AgentWritePreparation } from '../../action-support';
import type { AgentActionToolResult } from '../../tools/definition';
import { z } from 'zod';
import {
  InstalledItemTargetSchema,
  type InstalledItemSnapshot,
  type InstalledItemMutationResult,
  type SetInstalledItemStatusRequest,
  type UninstallInstalledItemRequest,
} from '@canopy/protocol/installed-items';
import type {
  AgentActionCall,
  AgentActionFamily,
  AgentActionFamilyJsonSchema,
} from '../../surface/family';
import { defineAgentActionFamily } from '../../surface/family';
import type { AgentActionCatalogEntry } from '../../catalog/types';
import type { AgentActionReceiptStore } from '../../receipts';
import type { AgentActionLimitsPort } from '../../limits';
import {
  agentActionIdempotencyKey,
  agentActionResult,
  agentActionToolResult,
  portErrorResponse,
  runIdempotentWrite,
} from '../../action-support';

import {
  INSTALLED_ITEM_ACTION_TYPES,
  installedItemActionSchema,
} from './actions';
export {
  INSTALLED_ITEM_ACTION_TYPES,
  installedItemActionSchema,
} from './actions';
export type { InstalledItemAction } from './actions';
export interface AgentInstalledItemsPort<H> {
  listMcpRemovals?(
    this: void,
    call: AgentActionCall<H>,
  ): Promise<McpRemovalCandidatesResult>;
  inspectMcpRemoval?(
    this: void,
    request: InspectMcpRemovalRequest,
    call: AgentActionCall<H>,
  ): Promise<InspectMcpRemovalResult>;
  forceMcpRemoval?(
    this: void,
    request: ForceMcpRemovalRequest,
    call: AgentActionCall<H>,
  ): Promise<ForceMcpRemovalResult>;
  listStatus(
    this: void,
    call: AgentActionCall<H>,
  ): Promise<InstalledItemSnapshot>;
  setStatus(
    this: void,
    request: SetInstalledItemStatusRequest,
    call: AgentActionCall<H>,
  ): Promise<InstalledItemMutationResult>;
  uninstall(
    this: void,
    request: UninstallInstalledItemRequest,
    call: AgentActionCall<H>,
  ): Promise<InstalledItemMutationResult>;
}
export function installedItemActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    {
      type: 'installed_items.list_mcp_removals',
      category: 'plugins',
      summary:
        'Find device MCP server IDs and saved uninstalls without loading inventory.',
      fields: [],
      example: { type: 'installed_items.list_mcp_removals' },
      keywords: ['repair', 'mcp', 'remove'],
    },
    {
      type: 'installed_items.inspect_mcp_removal',
      category: 'plugins',
      summary:
        'Inspect an exact device MCP server for evidence-preserving removal, without loading inventory.',
      fields: [
        {
          name: 'serverId',
          type: 'string',
          required: true,
          description: 'Exact device server ID; never an account connection.',
        },
      ],
      example: {
        type: 'installed_items.inspect_mcp_removal',
        serverId: 'aabb-1122',
      },
      keywords: ['repair', 'mcp', 'remove'],
    },
    {
      type: 'installed_items.force_mcp_removal',
      category: 'plugins',
      summary:
        'Remove an exact device MCP server with explicit approval and preserve its files as evidence. Incomplete outcomes are not successful uninstalls.',
      fields: [
        {
          name: 'serverId',
          type: 'string',
          required: true,
          description: 'Exact inspected device server ID.',
        },
        {
          name: 'mode',
          type: 'string',
          required: true,
          description: 'preserve-evidence',
        },
        {
          name: 'inspectedState',
          type: 'string',
          required: false,
          description:
            'Opaque inspection token; exactly one of inspectedState and recoveryId.',
        },
        {
          name: 'finishUninstall',
          type: 'boolean',
          required: false,
          description:
            'With recoveryId only, also finish that exact saved uninstall and its workspace/chat reference cleanup.',
        },
        {
          name: 'recoveryId',
          type: 'string',
          required: false,
          description:
            'Saved recovery ID from inspection; never a caller path.',
        },
      ],
      example: {
        type: 'installed_items.force_mcp_removal',
        serverId: 'aabb-1122',
        mode: 'preserve-evidence',
        inspectedState: '11111111-1111-4111-8111-111111111111',
      },
      keywords: ['repair', 'mcp', 'remove'],
    },
    {
      type: 'installed_items.list_status',
      category: 'plugins',
      summary:
        'List installed plugins, skills, MCP configurations and collections, including Disabled items, removal scopes and provider notices.',
      fields: [],
      example: { type: 'installed_items.list_status' },
      keywords: ['installed', 'disabled', 'active', 'available', 'customize'],
    },
    ...(
      ['installed_items.set_status', 'installed_items.uninstall'] as const
    ).map((type) => ({
      type,
      category: 'plugins',
      summary:
        type === 'installed_items.set_status'
          ? 'Set Active, Available or Disabled on an installed item.'
          : 'Uninstall an installed item. Device MCP deletion removes every configuration; account MCP deletion affects the account and removes its sign-in.',
      fields: [
        {
          name: 'target',
          type: 'object',
          required: true,
          description: 'Exact target returned by installed_items.list_status.',
        },
        ...(type === 'installed_items.set_status'
          ? [
              {
                name: 'status',
                type: 'string',
                required: true,
                description: 'active, available or disabled.',
              },
            ]
          : []),
      ],
      example: {
        type,
        target: { kind: 'collection', collectionId: 'collection-id' },
        ...(type === 'installed_items.set_status'
          ? { status: 'available' }
          : {}),
      },
      keywords: ['installed', 'status', 'uninstall', 'disable'],
      notes: [
        'Inspect effective status and per-target errors. A partial outcome is retryable; use a new tool call to reconcile current state. Receipts describe state at commit.',
      ],
    })),
  ];
}
export const installedItemDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: {
    serverId: { type: 'string' },
    mode: { type: 'string', const: 'preserve-evidence' },
    inspectedState: { type: 'string', format: 'uuid' },
    recoveryId: { type: 'string', format: 'uuid' },
    finishUninstall: { type: 'boolean', const: true },
    target: z
      .json()
      .parse(
        JSON.parse(JSON.stringify(z.toJSONSchema(InstalledItemTargetSchema))),
      ),
    status: { type: 'string', enum: ['active', 'available', 'disabled'] },
  },
  allOf: [
    {
      if: {
        properties: { type: { const: 'installed_items.inspect_mcp_removal' } },
      },
      then: { required: ['serverId'] },
    },
    {
      if: {
        properties: { type: { const: 'installed_items.force_mcp_removal' } },
      },
      then: {
        required: ['serverId', 'mode'],
        oneOf: [
          { required: ['inspectedState'], not: { required: ['recoveryId'] } },
          { required: ['recoveryId'], not: { required: ['inspectedState'] } },
        ],
      },
    },
    {
      if: { properties: { type: { const: 'installed_items.set_status' } } },
      then: { required: ['target', 'status'] },
    },
    {
      if: { properties: { type: { const: 'installed_items.uninstall' } } },
      then: { required: ['target'] },
    },
  ],
};
export function createInstalledItemsActionFamily<H>(options: {
  port: AgentInstalledItemsPort<H>;
  receipts: AgentActionReceiptStore<H>;
  limits: AgentActionLimitsPort | null;
}): AgentActionFamily<H> {
  return defineAgentActionFamily({
    id: 'installed-items',
    types: INSTALLED_ITEM_ACTION_TYPES,
    supportedTypes: () =>
      INSTALLED_ITEM_ACTION_TYPES.filter((type) =>
        type === 'installed_items.list_mcp_removals'
          ? options.port.listMcpRemovals !== undefined
          : type === 'installed_items.inspect_mcp_removal'
            ? options.port.inspectMcpRemoval !== undefined
            : type === 'installed_items.force_mcp_removal'
              ? options.port.forceMcpRemoval !== undefined
              : true,
      ),
    actionSchema: installedItemActionSchema,
    catalog: installedItemActionCatalog,
    dispatchJsonSchema: installedItemDispatchJsonSchema,
    async dispatch(action, call) {
      try {
        if (action.type === 'installed_items.list_mcp_removals') {
          if (!options.port.listMcpRemovals)
            throw new AgentPortError(
              'surface_unavailable',
              'Device MCP repair is unavailable.',
            );
          return agentActionResult(call, action.type, {
            ...(await options.port.listMcpRemovals(call)),
          });
        }
        if (action.type === 'installed_items.inspect_mcp_removal') {
          if (!options.port.inspectMcpRemoval)
            throw new AgentPortError(
              'surface_unavailable',
              'Device MCP repair is unavailable.',
            );
          return agentActionResult(call, action.type, {
            ...(await options.port.inspectMcpRemoval(
              { serverId: action.serverId },
              call,
            )),
          });
        }
        if (action.type === 'installed_items.force_mcp_removal') {
          if (!options.port.forceMcpRemoval)
            throw new AgentPortError(
              'surface_unavailable',
              'Device MCP repair is unavailable.',
            );
          const request: ForceMcpRemovalRequest = {
            serverId: action.serverId,
            mode: action.mode,
            ...(action.inspectedState
              ? { inspectedState: action.inspectedState }
              : { recoveryId: action.recoveryId }),
            ...(action.finishUninstall ? { finishUninstall: true } : {}),
          };
          const outcome = await options.port.forceMcpRemoval(request, call);
          const response = agentActionResult(call, action.type, { ...outcome });
          if (
            (outcome.status !== 'complete' ||
              outcome.uninstall === 'pending') &&
            response.ok
          ) {
            response.ok = false;
            response.error = {
              code: 'execution_failed',
              message:
                'Removal is incomplete. Inspect the device server before retrying.',
              retryable: false,
            };
          }
          return response;
        }
        if (action.type === 'installed_items.list_status')
          return agentActionResult(call, action.type, {
            ...(await options.port.listStatus(call)),
          });
        return await runIdempotentWrite({
          receipts: options.receipts,
          limits: options.limits,
          kind: action.type,
          call,
          idempotencyKey: agentActionIdempotencyKey(action.type, call, action),
          payload: action,
          prepare: (): Promise<AgentWritePreparation> =>
            Promise.resolve({
              ok: true,
              parentDepth: 0,
              write: async (): Promise<AgentActionToolResult> => {
                const outcome =
                  action.type === 'installed_items.set_status'
                    ? await options.port.setStatus(
                        { target: action.target, status: action.status },
                        call,
                      )
                    : await options.port.uninstall(
                        { target: action.target },
                        call,
                      );
                const response = agentActionResult(call, action.type, {
                  ...outcome,
                });
                if (!outcome.success && response.ok) {
                  response.ok = false;
                  response.error = {
                    code: 'execution_failed',
                    message:
                      'Installed-item mutation is incomplete. Inspect the effective snapshot and errors.',
                    retryable: outcome.errors.some((error) => error.retryable),
                  };
                }
                return agentActionToolResult(response);
              },
            }),
        });
      } catch (error) {
        return portErrorResponse(call, action.type, error);
      }
    },
  });
}
