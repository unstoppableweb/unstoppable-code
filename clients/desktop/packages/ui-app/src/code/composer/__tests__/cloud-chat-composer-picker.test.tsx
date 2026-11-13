/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PortalPluginCatalog } from '@canopy/protocol/portal';
import type { ChatComposerHostControls } from '../../ChatPanel';
import { CloudChatComposer } from '../CloudChatComposer';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no structuredClone; the editor clones its plain JSON empty value.
globalThis.structuredClone ??= <T,>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

// What the web core's snapshot maps to: an account MCP server the chat has
// not selected yet, beside one it has.
const catalog: PortalPluginCatalog = {
  collections: [],
  skills: [],
  plugins: [],
  mcpServers: [
    {
      serverId: 'linear',
      configId: 'default',
      serverName: 'Linear',
      configName: 'Linear',
      description: 'Issues',
      transport: 'http',
      connectionState: 'connected',
      connectionId: 'conn-linear',
    },
    {
      serverId: 'notion',
      configId: 'default',
      serverName: 'Notion',
      configName: 'Notion',
      description: 'Docs',
      transport: 'http',
      connectionState: 'connected',
      connectionId: 'conn-notion',
    },
  ],
};

describe('CloudChatComposer capability picker (CAN-5972)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('the picker offers every MCP server the web core catalog lists, selected or not', () => {
    const controls: ChatComposerHostControls = {
      onSend: () => undefined,
      isStreaming: false,
      planMode: false,
      onTogglePlanMode: () => undefined,
      onCycleThinking: () => undefined,
    };
    act(() =>
      root.render(
        <CloudChatComposer
          controls={controls}
          modelCatalog={[]}
          onSelectModel={() => undefined}
          pluginCatalog={catalog}
          selections={{
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
          }}
          onChangeSelections={() => undefined}
          attachments={[]}
          onAddFiles={() => undefined}
          onRemoveAttachment={() => undefined}
          onRetryAttachment={() => undefined}
          brandDisplayName="Canopy"
        />,
      ),
    );
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="cloud-chat-plus-button"]',
        )
        ?.click(),
    );
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="cloud-chat-plus-plugins"]',
        )
        ?.click(),
    );
    const text = document.body.textContent ?? '';
    expect(text).toContain('Linear');
    expect(text).toContain('Notion');
  });
});
