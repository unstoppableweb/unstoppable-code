import type { JsonValue } from '@canopy/execution-engine/node/codex-runtime/generated/serde_json/JsonValue';
import type { CanopyRouteTool } from '../mcp/canopy-route-tools';
import { antigravityAdvertisedSchema } from './mcp-schema';

// agy 1.5.1 drops larger declarations when several MCP servers share a
// session. These summaries accompany the canonical parameter names and types.
const summaries = new Map(
  Object.entries({
    ReadPipelineYaml: 'Read pipeline YAML by line range or pattern.',
    ShowFiles:
      'Open requested files or deliverables beside the chat. Use raw view for source or line annotations.',
    ShowCapabilities:
      'Display recommended capabilities by source-qualified ID or unambiguous name.',
    GetFileComments:
      'Read file and plan comment threads. Omit threadId to list open threads.',
    RespondToFileComment:
      'Reply to a thread. Resolve only after addressing its comment.',
    SearchActions:
      'Find actions available in this chat. Search by actionType for exact fields and examples before DispatchAction.',
    DispatchAction:
      'Run an action returned by SearchActions with its exact type and fields.',
    SearchWatchers:
      'Find watcher triggers and target fields, or page active watchers. Use standard detail for setup guidance.',
    SetupWatchers:
      'Create requested watchers. Use SearchWatchers first for the trigger and target fields. Set target.runOn to "cloud" for cloud pipeline runs. The destination is this chat.',
    WatchGitHubItems:
      'Watch GitHub runs or PRs, one kind per call. For runs use IDs or URLs with notifyOn.run.statuses/conclusions or notifyOn.jobs.conclusions ("any" or a list). For PRs pass {kind:"pull_request",target:"owner/repo#123"}. For queue updates use notifyOn.queue.entered/phases. Register once and end the turn.',
    GetGitHubPullRequestStatus:
      'Read current checks, reviews, mergeability and queue state for one GitHub PR. Use WatchGitHubItems to wait.',
    WatchCommand:
      'Watch a short repeat-safe shell probe: exit 0 succeeds, 1 retries, others fail. Prefer dedicated watchers. No sleeps, polling loops or background jobs. Register once and end the turn.',
    SetWorkEntryAutoDelete:
      'Arm idle removal of this chat’s work entry, or disarm with enabled=false alone. archive keeps it indefinitely. Teardown and branch options apply only to worktrees.',
    AddFeedEntry:
      'Record work in this chat’s Feed. Nest tasks under operations with parentEntryId. For assignment use the owner token from SearchFeedEntries. Reuse requestKey only to retry the same operation.',
    SearchFeedEntries:
      'Search this chat’s Feed. Set includeAssignableOwners to get owner tokens. Keep filters when paging with cursor or ownersCursor.',
    UpdateFeedEntry:
      'Update your open Feed entry with its last-read revision. Use openChildren to close a parent with open children.',
    QueryCodeGraph:
      'Query the graph after GetCodeGraphContext. For ipc-channel, use the channel key, its string value, or path::ipc.<key>. Use a file path or path::Parent.name for file or symbol queries. Both path modes require target and to. Omit target for communities and hubs; it is optional for flows.',
    GetReviewContext:
      'Summarize changed symbols, impact and test gaps against a base ref. Call GetCodeGraphContext first.',
    DetectChangedSymbols:
      'Find symbols changed against a base ref. Call GetCodeGraphContext first.',
    CompareChangeImpact:
      'Inspect changed symbols and their transitive impact. Call GetCodeGraphContext first.',
    SearchDeferredTools:
      'Search installed tools absent from this chat only when the user requests one or an active skill requires one. Batch queries.',
    LoadDeferredTools:
      'Enable missing installed resources by ref from SearchDeferredTools. Batch refs. Success ends this turn and resumes with the tools available.',
  }),
);

type JsonObject = { [key: string]: JsonValue };

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// Advertise the positive argument structure. Bounds and conditional branches
// stay in the host parser. Project exclusive alternatives as inclusive ones:
// dropping constraints can make alternatives that used to be disjoint overlap.
function argumentShape(schema: JsonValue, includeEnums: boolean): JsonValue {
  if (!isObject(schema)) return schema;
  const shape: JsonObject = {};
  for (const key of [
    'type',
    'required',
    'const',
    ...(includeEnums ? ['enum'] : []),
  ]) {
    const value = schema[key];
    if (value !== undefined) shape[key] = value;
  }
  // agy closes object parameters by default. Explicitly preserve open maps
  // so dispatch payloads and watcher targets can carry discovered fields.
  if (schema.type === 'object' && schema.additionalProperties !== false) {
    shape.additionalProperties = true;
  }
  if (isObject(schema.properties)) {
    shape.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, child]) => [
        name,
        child === undefined ? {} : argumentShape(child, includeEnums),
      ]),
    );
  }
  if (isObject(schema.items))
    shape.items = argumentShape(schema.items, includeEnums);
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    shape.anyOf = alternatives.map((item) => argumentShape(item, includeEnums));
  }
  return shape;
}

// Replace the large nested fields only. Keep route-specific envelope fields
// such as expectedUiRevision. The host still parses every nested argument.
function compactFields(name: string): JsonObject | undefined {
  switch (name) {
    case 'DispatchAction':
      return {
        action: {
          type: 'object',
          properties: { type: { type: 'string' } },
          required: ['type'],
        },
      };
    case 'WatchGitHubItems':
      return {
        items: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'integer' },
              { type: 'string' },
              { type: 'object' },
            ],
          },
        },
        notifyOn: {
          type: 'object',
          properties: {
            run: { type: 'object' },
            jobs: { type: 'object' },
            queue: { type: 'object' },
          },
        },
      };
    case 'SetupWatchers':
      return {
        watchers: {
          type: 'array',
          items: {
            type: 'object',
            required: ['target'],
            properties: {
              trigger: { type: 'string' },
              target: {
                type: 'object',
                properties: {
                  runOn: { type: 'string', enum: ['local', 'cloud'] },
                },
              },
              label: { type: 'string' },
              followUpInstruction: { type: 'string' },
              allowDuplicate: { type: 'boolean' },
              armForNextCompletion: { type: 'boolean' },
            },
          },
        },
      };
  }
}

export function antigravityAppToolDeclaration(
  tool: CanopyRouteTool,
): CanopyRouteTool {
  const description = summaries.get(tool.name);
  let schema = tool.inputSchema;
  if (description) {
    const fields = compactFields(tool.name);
    if (fields && isObject(schema) && isObject(schema.properties)) {
      schema = { ...schema, properties: { ...schema.properties, ...fields } };
    }
    schema = argumentShape(schema, tool.name !== 'SearchFeedEntries');
  }
  return {
    ...tool,
    description: description ?? tool.description,
    inputSchema: antigravityAdvertisedSchema(schema),
  };
}
