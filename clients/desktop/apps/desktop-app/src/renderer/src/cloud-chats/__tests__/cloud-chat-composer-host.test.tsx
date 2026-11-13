/** @jest-environment jsdom */
import './jsdom-globals';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createCloudChatCatalog } from '@canopy/app-state/core-cowork';
import { CLOUD_ATTACHMENT_MAX_BYTES } from '@canopy/protocol/cloud-attachments';
import type { ChatComposerHostControls } from '@canopy/ui-app/chat-panel';
import type { CloudChatAttachmentUploadResult } from '@canopy/desktop-shared/types';
import { CloudChatComposerHost } from '../CloudChatComposerHost';

jest.mock('@canopy/desktop-instrumentation/client', () => ({
  reportClientAppError: jest.fn(),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TARGET = {
  key: 'web-core:chat-1',
  workspaceId: 'workspace-1',
  worktreeId: 'task-1',
  chatId: 'chat-1',
};

describe('CloudChatComposerHost (CAN-5972)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const uploadAttachment = jest.fn<
    Promise<CloudChatAttachmentUploadResult>,
    [string, unknown]
  >();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { cloudChats: { uploadAttachment } },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('an oversized file is refused before its bytes are read or sent to main', async () => {
    const catalog = createCloudChatCatalog(
      {
        request: () =>
          Promise.resolve({
            ok: false,
            error: {
              kind: 'unavailable',
              message: 'Offline.',
              retry: { kind: 'never' },
            },
          }),
        openStream: () => Promise.reject(new Error('No streams.')),
      },
      TARGET,
    );
    const controls: ChatComposerHostControls = {
      onSend: () => undefined,
      isStreaming: false,
      planMode: false,
      onTogglePlanMode: () => undefined,
      onCycleThinking: () => undefined,
    };
    await act(async () => {
      root.render(
        <CloudChatComposerHost
          controls={controls}
          target={TARGET}
          catalog={catalog}
        />,
      );
      await Promise.resolve();
    });

    const big = new File(['x'], 'huge.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', {
      value: CLOUD_ATTACHMENT_MAX_BYTES + 1,
    });
    const readBytes = jest.fn(() => Promise.resolve(new ArrayBuffer(0)));
    Object.defineProperty(big, 'arrayBuffer', { value: readBytes });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="cloud-chat-file-input"]',
    );
    expect(input).not.toBeNull();
    if (input === null) return;
    Object.defineProperty(input, 'files', { configurable: true, value: [big] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(readBytes).not.toHaveBeenCalled();
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(
      container.querySelector(
        '[data-testid="portal-pending-attachments"] [data-state="error"]',
      )?.textContent,
    ).toContain('huge.pdf');
  });
});
