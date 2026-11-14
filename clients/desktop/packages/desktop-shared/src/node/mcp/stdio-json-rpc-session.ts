import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

/** A started stdio MCP server process that passes JSON-RPC messages through. */
export interface StdioJsonRpcSession {
  /** Sends one JSON-RPC message; rejects for one that isn't. */
  send(message: unknown): Promise<void>;
  onMessage(listener: (message: unknown) => void): void;
  /** Called once when the process exits or the session closes. */
  onClose(listener: () => void): void;
  close(): Promise<void>;
}

/**
 * Starts a stdio MCP server through a launcher command (the stdio broker's
 * route, which supplies the server's own command and environment), and
 * relays raw JSON-RPC: no MCP client sits in between, so the caller keeps
 * the protocol session as its own. The server's stderr is dropped.
 */
export async function openStdioJsonRpcSession(launch: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Added to the launcher's default environment. */
  readonly env?: Readonly<Record<string, string>>;
}): Promise<StdioJsonRpcSession> {
  const transport = new StdioClientTransport({
    command: launch.command,
    args: [...launch.args],
    ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
    ...(launch.env === undefined ? {} : { env: { ...launch.env } }),
    stderr: 'ignore',
  });
  const messageListeners = new Set<(message: unknown) => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;
  transport.onmessage = (message): void => {
    for (const listener of messageListeners) listener(message);
  };
  transport.onclose = (): void => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  };
  await transport.start();
  return {
    send: (message) => transport.send(JSONRPCMessageSchema.parse(message)),
    onMessage: (listener) => {
      messageListeners.add(listener);
    },
    onClose: (listener) => {
      if (closed) listener();
      else closeListeners.add(listener);
    },
    close: () => transport.close(),
  };
}
