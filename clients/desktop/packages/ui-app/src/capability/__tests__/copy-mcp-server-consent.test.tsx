/** @jest-environment jsdom */
/**
 * The consent to copy a desktop MCP server to the cloud account (CAN-6176
 * D30): every secret is a separate unchecked box showing its name, never its
 * value; no secret leaves unless its box was ticked, and Add stays disabled
 * until one is (a server with no saved secret is added without any). The
 * boxes offer a server's headers and its configuration's bearer token only:
 * never an environment variable or the OAuth client secret.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CopyMcpServerDialog,
  mcpServerCopySlots,
} from '../CopyMcpServerDialog';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SERVER = {
  definition: {
    type: 'http',
    headers: { 'X-Api-Key': { kind: 'stored-secret', ref: 'ref-1' } },
    oauth: { clientSecret: { kind: 'stored-secret', ref: 'ref-2' } },
  },
  configs: [
    {
      id: 'default',
      envVars: { TOKEN: { kind: 'stored-secret', ref: 'ref-3' } },
      extraHeaders: { 'X-Team': { kind: 'stored-secret', ref: 'ref-4' } },
      authToken: { kind: 'stored-secret', ref: 'ref-5' },
    },
  ],
};

describe('copying a desktop MCP server to the cloud account (CAN-6176 D30)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let copied: string[][];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    copied = [];
    act(() => {
      root.render(
        <CopyMcpServerDialog
          serverName="Tracker"
          host="mcp.tracker.example"
          slots={mcpServerCopySlots(SERVER, 'default')}
          signsInOnCloud={false}
          onCopy={(slots): Promise<void> => {
            copied.push(slots);
            return Promise.resolve();
          }}
          onClose={(): void => undefined}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const byTestId = (id: string): HTMLElement => {
    const element = document.body.querySelector<HTMLElement>(
      `[data-testid="${id}"]`,
    );
    if (element === null) throw new Error(`No ${id}.`);
    return element;
  };
  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  it('offers only headers and the bearer token, by name, none ticked', () => {
    expect(
      mcpServerCopySlots(SERVER, 'default').map((item) => item.slot),
    ).toEqual([
      'definition/headers/X-Api-Key',
      'config/default/extraHeaders/X-Team',
      'config/default/authToken',
    ]);
    const rows = byTestId('copy-mcp-server-secrets').querySelectorAll(
      'input[type="checkbox"]',
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toHaveProperty('checked', false);
    expect(document.body.textContent).not.toMatch(/ref-\d/);
    // A command server has nothing to copy.
    expect(
      mcpServerCopySlots(
        { ...SERVER, definition: { ...SERVER.definition, type: 'command' } },
        'default',
      ),
    ).toEqual([]);
  });

  it('sends no secret unless its box was ticked, and only what is ticked', async () => {
    const add = byTestId('copy-mcp-server-confirm');
    expect(add).toHaveProperty('disabled', true);
    act(() => add.click());
    await flush();
    expect(copied).toEqual([]);
    act(() =>
      byTestId('copy-mcp-server-secret-config/default/authToken').click(),
    );
    act(() => byTestId('copy-mcp-server-confirm').click());
    await flush();
    expect(copied).toEqual([['config/default/authToken']]);
  });

  it('adds a server with no saved secret, saying none will be sent', async () => {
    act(() => {
      root.render(
        <CopyMcpServerDialog
          serverName="Docs"
          host="mcp.docs.example"
          slots={[]}
          signsInOnCloud
          onCopy={(slots): Promise<void> => {
            copied.push(slots);
            return Promise.resolve();
          }}
          onClose={(): void => undefined}
        />,
      );
    });
    expect(byTestId('copy-mcp-server-no-secrets').textContent).toContain(
      'No secrets will be sent',
    );
    act(() => byTestId('copy-mcp-server-confirm').click());
    await flush();
    expect(copied).toEqual([[]]);
  });
});
