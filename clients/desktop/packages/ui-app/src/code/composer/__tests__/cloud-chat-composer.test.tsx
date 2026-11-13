/** @jest-environment jsdom */
import { act, isValidElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PortalChatCloudAttachmentRef,
  PortalPluginCatalog,
} from '@canopy/protocol/portal';
import type { ChatComposerProps } from '../../ChatComposer';
import type { ChatComposerHostControls } from '../../ChatPanel';
import {
  CloudChatComposer,
  type CloudComposerAttachment,
} from '../CloudChatComposer';

// The shared editor is the ChatComposer every host renders; the test drives
// its send and reads its send gate, which is what this composer adds.
const mockComposerProps: { current: ChatComposerProps | null } = {
  current: null,
};
jest.mock('../../ChatComposer', () => ({
  ChatComposer: (props: ChatComposerProps): ReactNode => {
    mockComposerProps.current = props;
    return <div data-testid="editor">{props.aboveEditor}</div>;
  },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ref: PortalChatCloudAttachmentRef = {
  attachmentId: 'att-ready',
  filename: 'ready.txt',
  mediaType: 'text/plain',
  size: 3,
  contentSha256: 'abc',
  storageKind: 'blob',
  source: 'user',
};

describe('CloudChatComposer (CAN-5972)', () => {
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

  it('send waits for uploading attachments and sends ready ones as references', async () => {
    const onSend = jest.fn<Promise<void>, [string, unknown?]>(() =>
      Promise.resolve(),
    );
    const onRemoveAttachment = jest.fn();
    const controls: ChatComposerHostControls = {
      onSend,
      isStreaming: false,
      planMode: false,
      onTogglePlanMode: () => undefined,
      thinkingLevel: 'high',
      onCycleThinking: () => undefined,
    };
    const render = (attachments: readonly CloudComposerAttachment[]): void =>
      act(() =>
        root.render(
          <CloudChatComposer
            controls={controls}
            modelCatalog={[]}
            onSelectModel={() => undefined}
            pluginCatalog={null}
            selections={{ collectionIds: [], skillRefs: [], pluginRefs: [] }}
            onChangeSelections={() => undefined}
            attachments={attachments}
            onAddFiles={() => undefined}
            onRemoveAttachment={onRemoveAttachment}
            onRetryAttachment={() => undefined}
            brandDisplayName="Canopy"
          />,
        ),
      );

    render([
      { localId: 'a', name: 'ready.txt', state: 'ready', attachment: ref },
      { localId: 'b', name: 'big.pdf', state: 'uploading' },
    ]);
    expect(mockComposerProps.current?.sendBlocked).toBe(true);
    // Plan and effort never reach the web core (no send field, and
    // chat.patch_tab_settings serves neither), so their chips stay out.
    expect(mockComposerProps.current?.onTogglePlanMode).toBeUndefined();
    expect(mockComposerProps.current?.onCycleThinking).toBeUndefined();
    expect(mockComposerProps.current?.thinkingLevel).toBeUndefined();
    expect(
      container.querySelectorAll(
        '[data-testid="portal-pending-attachments"] [data-state]',
      ),
    ).toHaveLength(2);

    render([
      { localId: 'a', name: 'ready.txt', state: 'ready', attachment: ref },
      { localId: 'b', name: 'big.pdf', state: 'failed' },
    ]);
    expect(mockComposerProps.current?.sendBlocked).toBe(false);
    await act(async () => {
      await mockComposerProps.current?.onSend?.('hello');
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('hello', { cloudAttachments: [ref] });
    // Only what was sent leaves the composer; a failed upload stays to retry.
    expect(onRemoveAttachment.mock.calls).toEqual([['a']]);
  });

  it('send waits for a model change to save', async () => {
    let finishSave: () => void = () => undefined;
    const onSelectModel = jest.fn<Promise<void>, [string]>(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
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
          onSelectModel={onSelectModel}
          pluginCatalog={null}
          selections={{ collectionIds: [], skillRefs: [], pluginRefs: [] }}
          onChangeSelections={() => undefined}
          attachments={[]}
          onAddFiles={() => undefined}
          onRemoveAttachment={() => undefined}
          onRetryAttachment={() => undefined}
          brandDisplayName="Canopy"
        />,
      ),
    );
    const picker = mockComposerProps.current?.modelSlot;
    expect(
      isValidElement<{ onSelect: (modelId: string) => void }>(picker),
    ).toBe(true);
    if (!isValidElement<{ onSelect: (modelId: string) => void }>(picker))
      return;

    act(() => picker.props.onSelect('claude-sonnet'));
    expect(onSelectModel).toHaveBeenCalledWith('claude-sonnet');
    // The send carries no model; the web core reads the saved one.
    expect(mockComposerProps.current?.sendBlocked).toBe(true);

    await act(async () => {
      finishSave();
      await Promise.resolve();
    });
    expect(mockComposerProps.current?.sendBlocked).toBe(false);
  });

  it('send waits for a capability change to save', async () => {
    let finishSave: () => void = () => undefined;
    const onChangeSelections = jest.fn<Promise<void>, [unknown]>(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const controls: ChatComposerHostControls = {
      onSend: () => undefined,
      isStreaming: false,
      planMode: false,
      onTogglePlanMode: () => undefined,
      onCycleThinking: () => undefined,
    };
    const selections = { collectionIds: [], skillRefs: [], pluginRefs: [] };
    act(() =>
      root.render(
        <CloudChatComposer
          controls={controls}
          modelCatalog={[]}
          onSelectModel={() => undefined}
          pluginCatalog={null}
          selections={selections}
          onChangeSelections={onChangeSelections}
          attachments={[]}
          onAddFiles={() => undefined}
          onRemoveAttachment={() => undefined}
          onRetryAttachment={() => undefined}
          brandDisplayName="Canopy"
        />,
      ),
    );
    const picker = mockComposerProps.current?.pluginsSlot;
    type PickerProps = { onChange: (next: unknown) => unknown };
    expect(isValidElement<PickerProps>(picker)).toBe(true);
    if (!isValidElement<PickerProps>(picker)) return;

    act(() => {
      void picker.props.onChange(selections);
    });
    expect(onChangeSelections).toHaveBeenCalledWith(selections);
    expect(mockComposerProps.current?.sendBlocked).toBe(true);

    await act(async () => {
      finishSave();
      await Promise.resolve();
    });
    expect(mockComposerProps.current?.sendBlocked).toBe(false);
  });

  it('capabilities cannot be edited until the selection loads or while a change saves', async () => {
    const onChangeSelections = jest.fn<Promise<void>, [unknown]>(() =>
      Promise.resolve(),
    );
    const controls: ChatComposerHostControls = {
      onSend: () => undefined,
      isStreaming: false,
      planMode: false,
      onTogglePlanMode: () => undefined,
      onCycleThinking: () => undefined,
    };
    const render = (pluginCatalog: PortalPluginCatalog | null): void =>
      act(() =>
        root.render(
          <CloudChatComposer
            controls={controls}
            modelCatalog={[]}
            onSelectModel={() => undefined}
            pluginCatalog={pluginCatalog}
            selections={{ collectionIds: [], skillRefs: [], pluginRefs: [] }}
            onChangeSelections={onChangeSelections}
            attachments={[]}
            onAddFiles={() => undefined}
            onRemoveAttachment={() => undefined}
            onRetryAttachment={() => undefined}
            brandDisplayName="Canopy"
          />,
        ),
      );
    type MenuProps = { rows: { id: string; disabled?: boolean }[] };
    const pluginsRowDisabled = (): boolean | undefined => {
      const menu = mockComposerProps.current?.leadingSlot;
      if (!isValidElement<MenuProps>(menu)) return undefined;
      return menu.props.rows.find((row) => row.id === 'plugins')?.disabled;
    };

    render(null);
    expect(pluginsRowDisabled()).toBe(true);
    render({ collections: [], skills: [], plugins: [], mcpServers: [] });
    expect(pluginsRowDisabled()).toBe(false);

    // While a change saves, reopening would start from the stale selection.
    let finishSave: () => void = () => undefined;
    onChangeSelections.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const picker = mockComposerProps.current?.pluginsSlot;
    type PickerProps = { onChange: (next: unknown) => unknown };
    if (!isValidElement<PickerProps>(picker)) throw new Error('No picker.');
    act(() => {
      void picker.props.onChange({
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
      });
    });
    expect(pluginsRowDisabled()).toBe(true);
    await act(async () => {
      finishSave();
      await Promise.resolve();
    });
    expect(pluginsRowDisabled()).toBe(false);
  });
});
