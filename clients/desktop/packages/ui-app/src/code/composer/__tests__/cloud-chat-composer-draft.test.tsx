/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PortalChatCloudAttachmentRef } from '@canopy/protocol/portal';
import type * as UiRich from '@canopy/ui-rich';
import { createEmptyValue } from '@canopy/ui-rich';
import type { ChatComposerHostControls } from '../../ChatPanel';
import { CloudChatComposer } from '../CloudChatComposer';

// The real shared editor. Its first empty value is the person's draft, so the
// test starts from typed text without driving the editor's input events.
jest.mock('@canopy/ui-rich', () => {
  const actual = jest.requireActual<typeof UiRich>('@canopy/ui-rich');
  return { ...actual, createEmptyValue: jest.fn(actual.createEmptyValue) };
});

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no structuredClone; the editor clones its plain JSON empty value.
globalThis.structuredClone ??= <T,>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

const ref: PortalChatCloudAttachmentRef = {
  attachmentId: 'att-ready',
  filename: 'ready.txt',
  mediaType: 'text/plain',
  size: 3,
  contentSha256: 'abc',
  storageKind: 'blob',
  source: 'user',
};

describe('CloudChatComposer draft (CAN-5972)', () => {
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

  it('a rejected send keeps the draft', async () => {
    jest
      .mocked(createEmptyValue)
      .mockImplementationOnce(() => [
        { type: 'paragraph', children: [{ text: 'Ship the fix' }] },
      ]);
    let reject: (error: Error) => void = () => undefined;
    const onSend = jest.fn<Promise<void>, [string, unknown?]>(
      () =>
        new Promise<void>((_resolve, rejectSend) => {
          reject = rejectSend;
        }),
    );
    const onRemoveAttachment = jest.fn<void, [string]>();
    const controls: ChatComposerHostControls = {
      onSend,
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
          pluginCatalog={null}
          selections={{ collectionIds: [], skillRefs: [], pluginRefs: [] }}
          onChangeSelections={() => undefined}
          attachments={[
            {
              localId: 'a',
              name: 'ready.txt',
              state: 'ready',
              attachment: ref,
            },
          ]}
          onAddFiles={() => undefined}
          onRemoveAttachment={onRemoveAttachment}
          onRetryAttachment={() => undefined}
          brandDisplayName="Canopy"
        />,
      ),
    );
    const editorText = (): string =>
      container.querySelector('[data-testid="chat-composer-input"]')
        ?.textContent ?? '';
    const sendButton = (): HTMLButtonElement | null =>
      container.querySelector('[data-testid="chat-composer-send"]');
    expect(editorText()).toContain('Ship the fix');

    act(() => sendButton()?.click());
    expect(onSend).toHaveBeenCalledWith('Ship the fix', {
      cloudAttachments: [ref],
    });
    // While the send is pending the editor is clear and Send stays off, so
    // the same attachments cannot go out twice.
    expect(editorText()).not.toContain('Ship the fix');
    expect(sendButton()?.disabled).toBe(true);

    await act(async () => {
      reject(new Error('Your message wasn’t sent: offline'));
      await Promise.resolve();
    });

    expect(editorText()).toContain('Ship the fix');
    expect(onRemoveAttachment).not.toHaveBeenCalled();
    expect(
      container.querySelectorAll(
        '[data-testid="portal-pending-attachments"] [data-state="ready"]',
      ),
    ).toHaveLength(1);
    expect(sendButton()?.disabled).toBe(false);
  });
});
