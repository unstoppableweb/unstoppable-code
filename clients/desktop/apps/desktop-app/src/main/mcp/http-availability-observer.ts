import { StringDecoder } from 'node:string_decoder';
import type { McpAvailabilityObserver } from '@canopy/execution-engine/node/codex-runtime/mcp-availability-observer';

const MAX_BYTES = 2 * 1024 * 1024;

/** Bounded metadata-only observation; the proxy forwards original bytes independently. */
export class McpHttpAvailabilityObserver {
  private readonly connections = new Map<string, McpAvailabilityObserver>();
  constructor(private readonly create: () => McpAvailabilityObserver) {}

  request(
    body: string | null,
    sessionId: string,
  ): McpAvailabilityObserver | undefined {
    if (
      sessionId.length > 4096 ||
      (body !== null && Buffer.byteLength(body) > MAX_BYTES)
    )
      return undefined;
    let request: unknown;
    try {
      request = body === null ? undefined : JSON.parse(body);
    } catch {
      return undefined;
    }
    let connection = this.connections.get(sessionId);
    if (
      typeof request === 'object' &&
      request !== null &&
      'method' in request &&
      request.method === 'initialize'
    ) {
      connection?.close();
      this.connections.delete(sessionId);
      if (this.connections.size >= 64) return undefined;
      connection = this.create();
      this.connections.set(sessionId, connection);
    }
    connection?.request(request);
    return connection;
  }

  response(
    connection: McpAvailabilityObserver,
    sessionId: string | undefined,
    contentType: string,
  ): { data(chunk: Buffer): void; end(): void } {
    if (!Array.from(this.connections.values()).includes(connection))
      return { data: (): void => {}, end: (): void => {} };
    if (sessionId && sessionId.length <= 4096) {
      // The initialize response assigns the owning connection's session id.
      if (this.connections.get('') === connection) this.connections.delete('');
      if (this.connections.size < 64)
        this.connections.set(sessionId, connection);
    }
    const decoder = new StringDecoder('utf8');
    const sse = contentType.split(';')[0].trim() === 'text/event-stream';
    let pending = '';
    let eventData: string[] = [];
    let bytes = 0;
    let discarded = false;
    const parse = (text: string): void => {
      try {
        const value: unknown = JSON.parse(text);
        connection.response(value);
      } catch {
        /* Never infer readiness from invalid JSON. */
      }
    };
    const consume = (text: string): void => {
      pending += text;
      if (!sse) return;
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) return;
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (!line) {
          if (eventData.length) parse(eventData.join('\n'));
          eventData = [];
          bytes = Buffer.byteLength(pending);
        } else if (line.startsWith('data:'))
          eventData.push(line.slice(5).replace(/^ /, ''));
      }
    };
    return {
      data(chunk): void {
        if (discarded) return;
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          discarded = true;
          pending = '';
          eventData = [];
          connection.close();
          return;
        }
        consume(decoder.write(chunk));
      },
      end(): void {
        if (discarded) return;
        consume(decoder.end());
        if (!sse) parse(pending);
        pending = '';
        eventData = [];
      },
    };
  }

  close(): void {
    for (const connection of Array.from(this.connections.values()))
      connection.close();
    this.connections.clear();
  }

  authenticationRequired(): void {
    if (this.connections.size === 0) this.connections.set('', this.create());
    for (const connection of Array.from(new Set(this.connections.values())))
      connection.authenticationRequired();
  }
}
