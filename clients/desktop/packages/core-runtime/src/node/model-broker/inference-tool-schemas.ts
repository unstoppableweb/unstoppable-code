import {
  flattenToolJsonSchema,
  type JsonSchemaValue,
} from '@canopy/protocol/tool-schemas';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bound the entire request before calling the recursive schema projector. */
function isBoundedJson(value: unknown): value is JsonSchemaValue {
  const pending: [unknown, number][] = [[value, 0]];
  let nodes = 0;
  let chars = 0;
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) break;
    const [node, depth] = entry;
    if (++nodes > 100_000 || depth > 128) return false;
    if (typeof node === 'string') chars += node.length;
    else if (Array.isArray(node)) {
      for (const child of node) pending.push([child, depth + 1]);
    } else if (isRecord(node)) {
      for (const [key, child] of Object.entries(node)) {
        chars += key.length;
        pending.push([child, depth + 1]);
      }
    } else if (
      node !== null &&
      typeof node !== 'boolean' &&
      !(typeof node === 'number' && Number.isFinite(node))
    )
      return false;
    if (chars > 1024 * 1024) return false;
  }
  return true;
}

/** Only the advertised schemas change. Native validation and approval stay intact. */
export function flattenOpenCodeInferenceTools(payload: object): void {
  const tools: unknown = Reflect.get(payload, 'tools');
  if (tools === undefined) return;
  if (!Array.isArray(tools) || tools.length > 256 || !isBoundedJson(tools))
    throw new Error('OpenCode tool definitions exceed the supported limits.');
  for (const tool of tools) {
    if (!isRecord(tool)) throw new Error('Invalid OpenCode tool definition.');
    // Messages input_schema and Responses function parameters are the only
    // schemas emitted by the pinned native runtime. Never traverse prompt data.
    for (const field of ['input_schema', 'parameters']) {
      const schema = tool[field];
      if (schema === undefined) continue;
      if (!isRecord(schema) || !isBoundedJson(schema))
        throw new Error('Invalid OpenCode tool schema.');
      tool[field] = flattenToolJsonSchema(schema);
    }
  }
}
