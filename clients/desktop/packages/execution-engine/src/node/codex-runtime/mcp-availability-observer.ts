export type McpTransportEvidence =
  | { kind: 'connecting' }
  | { kind: 'tools'; initialized: true; complete: true; toolCount: number }
  | { kind: 'unavailable'; reasonCode: 'disconnected' | 'startup_failed' }
  | { kind: 'auth_required' };

/** Observes only messages carried by one provider-owned connection. */
export class McpAvailabilityObserver {
  private readonly pending = new Map<
    string | number,
    { method: string; cursor?: string }
  >();
  private initialized = false;
  private closed = false;
  private nextCursor: string | undefined;
  private readonly cursors = new Set<string>();
  private readonly tools = new Set<string>();
  private listing = false;
  constructor(
    private readonly publish: (evidence: McpTransportEvidence) => void,
  ) {}
  request(value: unknown): void {
    if (
      this.closed ||
      !record(value) ||
      value.jsonrpc !== '2.0' ||
      !(
        typeof value.id === 'string' ||
        (typeof value.id === 'number' && Number.isFinite(value.id))
      )
    )
      return;
    if (value.method !== 'initialize' && value.method !== 'tools/list') return;
    if (value.method === 'initialize') {
      this.initialized = false;
      this.resetList();
      this.publish({ kind: 'connecting' });
    }
    if (this.pending.size >= 128 || this.pending.has(value.id))
      return this.invalidate();
    const cursor = record(value.params) ? value.params.cursor : undefined;
    if (
      cursor !== undefined &&
      (typeof cursor !== 'string' || !cursor || cursor.length > 4096)
    )
      return this.invalidate();
    this.pending.set(value.id, {
      method: value.method,
      ...(typeof cursor === 'string' ? { cursor } : {}),
    });
    if (value.method === 'tools/list' && cursor === undefined)
      this.publish({ kind: 'connecting' });
  }
  response(value: unknown): void {
    if (this.closed || !record(value) || value.jsonrpc !== '2.0') return;
    if (value.method === 'notifications/tools/list_changed') {
      this.pending.clear();
      this.resetList();
      this.publish({ kind: 'connecting' });
      return;
    }
    if (typeof value.id !== 'string' && typeof value.id !== 'number') return;
    const request = this.pending.get(value.id);
    if (!request) return;
    this.pending.delete(value.id);
    if (value.error !== undefined) return this.invalidate();
    if (request.method === 'initialize') {
      if (!InitializeResultSchema.safeParse(value.result).success)
        return this.invalidate();
      this.initialized = true;
      this.resetList();
      return;
    }
    if (!this.initialized) return;
    const parsed = ListToolsResultSchema.safeParse(value.result);
    if (!parsed.success) return this.invalidate();
    const page = parsed.data;
    if (!request.cursor) {
      this.resetList();
      this.listing = true;
    } else if (!this.listing || request.cursor !== this.nextCursor)
      return this.invalidate();
    if (
      page.nextCursor !== undefined &&
      (!page.nextCursor ||
        page.nextCursor.length > 4096 ||
        this.cursors.has(page.nextCursor) ||
        this.cursors.size >= 100)
    )
      return this.invalidate();
    for (const tool of page.tools) {
      if (
        tool.name.length > 1024 ||
        this.tools.has(tool.name) ||
        this.tools.size >= 10_000
      )
        return this.invalidate();
      this.tools.add(tool.name);
    }
    this.nextCursor = page.nextCursor;
    if (page.nextCursor) {
      this.cursors.add(page.nextCursor);
      return;
    }
    this.listing = false;
    this.publish({
      kind: 'tools',
      initialized: true,
      complete: true,
      toolCount: this.tools.size,
    });
    this.resetList();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.clear();
    this.resetList();
    this.publish({ kind: 'unavailable', reasonCode: 'disconnected' });
  }
  authenticationRequired(): void {
    if (this.closed) return;
    this.pending.clear();
    this.resetList();
    this.initialized = false;
    this.publish({ kind: 'auth_required' });
  }
  private invalidate(): void {
    this.pending.clear();
    this.resetList();
    this.publish({ kind: 'unavailable', reasonCode: 'startup_failed' });
  }
  private resetList(): void {
    this.listing = false;
    this.nextCursor = undefined;
    this.tools.clear();
    this.cursors.clear();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
import {
  InitializeResultSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
