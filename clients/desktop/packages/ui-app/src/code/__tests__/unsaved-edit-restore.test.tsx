/** @jest-environment jsdom */
/**
 * Restoring an unsaved queued edit (CAN-6801). The shared helper hands text
 * to the composer of one chat and reports whether a composer took it; the
 * shared card keeps an edit until one did. ui-app's composer takes text for
 * its own chat, the way desktop's and the web ChatInput do, and every
 * composer appends it after the draft, never at the caret.
 *
 * A jsdom suite kept as a golden by the CAN-6801 exception in
 * docs/golden-tests.md: it mounts the real shared card and composer.
 */
import { act, createRef, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor, Transforms } from 'slate';
import {
  INSERT_CHAT_TEXT_EVENT,
  insertChatTextIsFor,
  requestChatComposerText,
  type InsertChatTextDetail,
} from '@canopy/app-core';
import {
  ComposerEditor,
  type ComposerEditorHandle,
} from '@canopy/ui-rich/editor';
import {
  UnsavedMessageEdits,
  type UnsavedMessageEdit,
} from '@canopy/ui-shared/components';
import { ChatComposer } from '../ChatComposer';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom omits structuredClone, which the editor's draft values use.
if (typeof globalThis.structuredClone === 'undefined')
  globalThis.structuredClone = <T,>(value: T): T =>
    JSON.parse(JSON.stringify(value)) as T;

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

function composerText(chatId: string): string {
  return (
    container.querySelector<HTMLElement>(
      `[data-chat="${chatId}"] [data-testid="chat-composer-input"]`,
    )?.textContent ?? ''
  );
}

/** The card and a chat's composer, wired as ChatPanel wires them. */
function ChatWithKeptEdit({
  chatId,
  drafts,
  composers,
  disabled = false,
}: {
  chatId: string;
  drafts: readonly UnsavedMessageEdit[];
  composers: readonly string[];
  disabled?: boolean;
}): JSX.Element {
  const [kept, setKept] = useState(drafts);
  return (
    <>
      <UnsavedMessageEdits
        drafts={kept}
        onDismiss={(draft): void =>
          setKept((current) => current.filter((item) => item !== draft))
        }
        onRestore={(draft): void => {
          if (requestChatComposerText({ chatId, text: draft.text }))
            setKept((current) => current.filter((item) => item !== draft));
        }}
      />
      {composers.map((composerChatId) => (
        <div key={composerChatId} data-chat={composerChatId}>
          <ChatComposer
            insertChatId={composerChatId}
            onSend={(): void => undefined}
            disabled={disabled}
          />
        </div>
      ))}
    </>
  );
}

function restoreButton(): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Restore',
    ) ?? null
  );
}

describe('restoring an unsaved queued edit (CAN-6801)', () => {
  it("puts the edit in its own chat's composer, and the card goes", () => {
    act(() => {
      root.render(
        <ChatWithKeptEdit
          chatId="chat-a"
          drafts={[{ id: 'q-1', text: 'Draft the launch plan' }]}
          composers={['chat-a', 'chat-b']}
        />,
      );
    });
    expect(container.textContent).toContain('Draft the launch plan');
    act(() => {
      restoreButton()?.click();
    });
    expect(composerText('chat-a')).toContain('Draft the launch plan');
    expect(composerText('chat-b')).not.toContain('Draft the launch plan');
    expect(restoreButton()).toBeNull();
  });

  it.each([
    ['no composer of its chat is open', ['chat-b'], false],
    ["its chat's composer is read-only", ['chat-a'], true],
  ])('keeps the edit when %s', (_case, composers, disabled) => {
    act(() => {
      root.render(
        <ChatWithKeptEdit
          chatId="chat-a"
          drafts={[{ id: 'q-1', text: 'Draft the launch plan' }]}
          composers={composers}
          disabled={disabled}
        />,
      );
    });
    act(() => {
      restoreButton()?.click();
    });
    expect(restoreButton()).not.toBeNull();
    expect(container.textContent).toContain('Draft the launch plan');
  });

  it('keeps a cleared edit, and sends nothing to the composer', () => {
    const sent: string[] = [];
    const listener = (event: Event): void => {
      sent.push((event as CustomEvent<InsertChatTextDetail>).detail.text);
    };
    document.addEventListener(INSERT_CHAT_TEXT_EVENT, listener);
    try {
      act(() => {
        root.render(
          <ChatWithKeptEdit
            chatId="chat-a"
            drafts={[{ id: 'q-1', text: '' }]}
            composers={['chat-a']}
          />,
        );
      });
      act(() => {
        restoreButton()?.click();
      });
    } finally {
      document.removeEventListener(INSERT_CHAT_TEXT_EVENT, listener);
    }
    expect(sent).toEqual([]);
    expect(restoreButton()).not.toBeNull();
  });

  // CAN-7196 (SWAN Q3): an edit whose save's answer never came may have
  // saved, so its card says it couldn't confirm it, never that it is unsaved,
  // and keeps the same text and actions.
  it('labels an edit that may have saved "Couldn\'t confirm this edit", with the same text and actions', () => {
    act(() => {
      root.render(
        <ChatWithKeptEdit
          chatId="chat-a"
          drafts={[
            { id: 'q-1', text: 'Draft the launch plan', unconfirmed: true },
            { id: 'q-2', text: 'Book the room' },
          ]}
          composers={['chat-a']}
        />,
      );
    });
    const cards = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-testid="queued-message-unsaved-edit"]',
      ),
    ];
    expect(cards).toHaveLength(2);
    const [unconfirmed, unsaved] = cards;
    expect(unconfirmed?.textContent).toContain("Couldn't confirm this edit");
    expect(unconfirmed?.textContent).not.toContain('Unsaved edit');
    expect(unconfirmed?.textContent).toContain('Draft the launch plan');
    expect(unsaved?.textContent).toContain('Unsaved edit');
    for (const card of cards)
      expect(
        [...card.querySelectorAll('button')].map(
          (button) => button.textContent,
        ),
      ).toEqual(expect.arrayContaining(['Copy', 'Restore', 'Dismiss']));
  });

  it('adds a later edit after the draft, a blank line apart', () => {
    act(() => {
      root.render(
        <ChatWithKeptEdit
          chatId="chat-a"
          drafts={[
            { id: 'q-1', text: 'First edit' },
            { id: 'q-2', text: 'Second edit' },
          ]}
          composers={['chat-a']}
        />,
      );
    });
    act(() => {
      restoreButton()?.click();
    });
    act(() => {
      restoreButton()?.click();
    });
    const paragraphs = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-chat="chat-a"] [data-testid="chat-composer-input"] [data-slate-node="element"]',
      ),
    ].map((node) => node.textContent?.replace(/\uFEFF/g, '') ?? '');
    expect(paragraphs).toEqual(['First edit', '', 'Second edit']);
  });
});

describe('the shared composer request (CAN-6801)', () => {
  it("names the chat for desktop's and the web's composers, and answers whether one took it", () => {
    const seen: InsertChatTextDetail[] = [];
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<InsertChatTextDetail>).detail;
      seen.push(detail);
      detail.markHandled?.();
    };
    expect(requestChatComposerText({ chatId: 'chat-a', text: 'x' })).toBe(
      false,
    );
    document.addEventListener(INSERT_CHAT_TEXT_EVENT, listener);
    try {
      expect(requestChatComposerText({ chatId: 'chat-a', text: 'x' })).toBe(
        true,
      );
      expect(requestChatComposerText({ chatId: 'chat-a', text: '' })).toBe(
        false,
      );
    } finally {
      document.removeEventListener(INSERT_CHAT_TEXT_EVENT, listener);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      text: 'x',
      targetTabId: 'chat-a',
      targetChatId: 'chat-a',
    });
  });

  it.each([
    ['its own chat', 'chat-a', false, true],
    ['another chat', 'chat-b', false, false],
    ['no chat', undefined, false, true],
    ['its own chat, taking only its own', 'chat-a', true, true],
    ['no chat, taking only its own', undefined, true, false],
  ])(
    "routes a web composer's requests: one naming %s",
    (_case, targetChatId, ownChatOnly, taken) => {
      const detail: InsertChatTextDetail = {
        text: 'x',
        ...(targetChatId === undefined ? {} : { targetChatId }),
      };
      expect(
        insertChatTextIsFor(detail, { chatId: 'chat-a', ownChatOnly }),
      ).toBe(taken);
    },
  );

  it('takes nothing for a composer with no chat that takes only its own', () => {
    expect(
      insertChatTextIsFor(
        { text: 'x', targetChatId: 'chat-a' },
        { chatId: undefined, ownChatOnly: true },
      ),
    ).toBe(false);
  });
});

describe("the web composer's editor appends a request after the draft (CAN-6801)", () => {
  function renderEditor(initialText: string): ComposerEditorHandle {
    const handle = createRef<ComposerEditorHandle>();
    act(() => {
      root.render(<ComposerEditor ref={handle} initialText={initialText} />);
    });
    if (handle.current === null) throw new Error('editor not mounted');
    return handle.current;
  }

  it('keeps selected draft text', () => {
    const handle = renderEditor('Keep this draft');
    act(() => {
      Transforms.select(handle.editor, Editor.range(handle.editor, []));
      handle.appendText('Restored edit');
    });
    expect(handle.serialize().text).toBe('Keep this draft\n\nRestored edit');
  });

  it('adds after the draft with the caret mid-text', () => {
    const handle = renderEditor('Keep this draft');
    act(() => {
      Transforms.select(handle.editor, { path: [0, 0], offset: 4 });
      handle.appendText('Restored edit');
    });
    expect(handle.serialize().text).toBe('Keep this draft\n\nRestored edit');
  });

  it('fills an empty draft with no blank line', () => {
    const handle = renderEditor('');
    act(() => {
      handle.appendText('Restored edit');
    });
    expect(handle.serialize().text).toBe('Restored edit');
  });
});
