import { z } from 'zod/v4';
import { BRAND } from '@canopy/brand/current';
import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';

const appName = BRAND.displayName;

export const SEARCH_DEFERRED_TOOLS_DESCRIPTION = [
  `Search already-installed, locally-managed ${appName} skills, plugins, and enabled MCP server configs that are not currently available in this chat.`,
  "First check the chat's current Skills list and callable tools; do not search for a skill, plugin, MCP server, or command that is already available to the agent.",
  'Batch multiple queries in one call.',
  'Use only when an active skill explicitly references a missing skill/plugin/MCP server, or when the user explicitly asks to use one that is not currently enabled.',
  'Do not use proactively, for recommendations, adjacent capabilities, speculative discovery, remote marketplace lookup, installation, OAuth setup, or catalog browsing.',
  'A skill search also searches skills and slash commands inside plugins; those matches return the parent plugin ref plus matchedMembers, because loading the plugin enables the member.',
  'Use plugin:skill syntax (for example, superpowers:brainstorming) to search for a skill or command specifically inside matching plugins.',
  'Unsupported resources are omitted from matches; each query result includes unsupportedMatches only when one or more matching resources are unsupported by the active provider.',
  'Search before LoadDeferredTools so refs come from live results.',
].join(' ');

export const LOAD_DEFERRED_TOOLS_DESCRIPTION = [
  `Enable already-installed, locally-managed ${appName} skills, plugins, and enabled MCP server configs for this same chat.`,
  "Use this only for resources absent from the chat's current Skills list and callable tools; never load something the agent can already use directly.",
  'Batch multiple items in one call.',
  'Use only for refs returned by SearchDeferredTools, when an active skill explicitly references a missing skill/plugin/MCP server, or when the user explicitly asks to use one that is not currently enabled.',
  'Do not use proactively, for recommendations, adjacent capabilities, speculative discovery, remote marketplace lookup, installation, OAuth setup, or catalog browsing.',
  'When at least one item is enabled, this turn will stop and resume automatically after the requested items are available.',
].join(' ');

export const DELEGATE_SEARCH_DEFERRED_TOOLS_DESCRIPTION = [
  `Search already-installed, locally-managed ${appName} skills, plugins, and enabled MCP server configs that are not currently available to this delegated task.`,
  "First check this delegated task's current Skills list and callable tools;",
  'do not search for a skill, plugin, MCP server, or command that is already available to the agent.',
  'Batch multiple queries in one call.',
  'Use only when an active skill explicitly references a missing skill/plugin/MCP server,',
  'or when this delegated task explicitly asks to use one that is not currently enabled.',
  'Do not use proactively, for recommendations, adjacent capabilities, speculative discovery, remote marketplace lookup, installation, OAuth setup, or catalog browsing.',
  'A skill search also searches skills and slash commands inside plugins; those matches return',
  'the parent plugin ref plus matchedMembers, because loading the plugin enables the member.',
  'Use plugin:skill syntax (for example, superpowers:brainstorming) to search for a skill or command specifically inside matching plugins.',
  'Unsupported resources are omitted from matches; each query result includes unsupportedMatches',
  'only when one or more matching resources are unsupported by the active provider.',
  'Search before LoadDeferredTools so refs come from live results.',
].join(' ');

export const DELEGATE_LOAD_DEFERRED_TOOLS_DESCRIPTION = [
  `Enable already-installed, locally-managed ${appName} skills, plugins, and enabled MCP server configs for this delegated task.`,
  "Use this only for resources absent from this delegated task's current Skills list and callable tools;",
  'never load something the agent can already use directly.',
  'Batch multiple items in one call.',
  'Use only for refs returned by SearchDeferredTools, when an active skill explicitly references',
  'a missing skill/plugin/MCP server, or when this delegated task explicitly asks to use one that is not currently enabled.',
  'Do not use proactively, for recommendations, adjacent capabilities, speculative discovery, remote marketplace lookup, installation, OAuth setup, or catalog browsing.',
  'When at least one item is enabled, this run pauses briefly and continues automatically with the requested items available.',
  "Loaded MCP tools still follow the parent's approval policy.",
].join(' ');

const deferredResourceKindSchema = z.enum(['skill', 'plugin', 'mcp']);

export const searchDeferredToolsSchema = z.object({
  queries: z
    .array(
      z.object({
        text: z.string().trim().min(1),
        kinds: z.array(deferredResourceKindSchema).min(1).max(3).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
    )
    .min(1)
    .max(20),
});

export const loadDeferredToolsSchema = z.object({
  items: z
    .array(
      z.object({
        ref: z.string().trim().min(1),
      }),
    )
    .min(1)
    .max(50),
});

export const searchDeferredToolsJsonSchema: JsonValue = {
  type: 'object',
  additionalProperties: false,
  required: ['queries'],
  properties: {
    queries: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            minLength: 1,
            pattern: '.*\\S.*',
            description: 'Trimmed non-empty search text.',
          },
          kinds: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
            items: {
              type: 'string',
              enum: ['skill', 'plugin', 'mcp'],
            },
            description:
              'Optional resource kind filter. Omit to search all kinds. The skill kind also searches plugin-owned skills and commands and returns their parent plugin refs.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            description: 'Maximum matches for this query. Defaults to 10.',
          },
        },
      },
    },
  },
};

export const loadDeferredToolsJsonSchema: JsonValue = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref'],
        properties: {
          ref: {
            type: 'string',
            minLength: 1,
            pattern: '.*\\S.*',
            description:
              'Trimmed non-empty opaque ref returned by SearchDeferredTools. Do not construct refs manually.',
          },
        },
      },
    },
  },
};
