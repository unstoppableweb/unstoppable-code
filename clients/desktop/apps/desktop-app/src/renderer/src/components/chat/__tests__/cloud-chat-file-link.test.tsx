/** @jest-environment jsdom */
import '../../../cloud-chats/__tests__/jsdom-globals';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  WORKER_FILESYSTEM_QUERY_DEFINITIONS,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import { FILE_LINK_RESOLVE_CASES } from '../../../../../../../../packages/ui-app/src/file-link-status/__tests__/fixtures/file-link-resolve-cases';
import type {
  CanopyCoreRelayReply,
  CanopyCoreRelayRequest,
} from '../../../../../shared/canopy-core-relay';
import { webCoreFilePath } from '@/lib/chat-authority';
import { useChatStore } from '@/stores/chatStore';
import { ChatMarkdownLink } from '../ChatMarkdownLink';
import { ChatMarkdownFileTargetContext } from '../chat-markdown-file-target';

// A file link in a cloud chat's reply on desktop (CAN-6587): it resolves on
// the web core, for the task's sandbox, and opens in the file viewer. It
// never goes to this computer's file IPC, which would read the sandbox path
// as a local one and is handed the cloud task's ids. A link outside the task
// folder is refused, says so, and opens nothing.

const LINK =
  WORKER_FILESYSTEM_QUERY_DEFINITIONS['worker.filesystem.link.resolve'];
const TASK = '33333333-3333-4333-8333-333333333333';
const OTHER_CHAT = '44444444-4444-4444-8444-444444444444';
const TARGET = {
  projectId: 'web-core:11111111-1111-4111-8111-111111111111',
  worktreeId: `web-core:${TASK}`,
};

const requests: CanopyCoreRelayRequest[] = [];
let sandboxAsleep = false;
/** The web core's answer to every link, when a case sets it (CAN-6665). */
let refusal: CanopyErrorPayload | null = null;
/** What the web core resolves a link to, when a case sets it. */
let resolvedKind: 'file' | 'directory' = 'file';
/** The task's chats that saved the linked deliverable, for a sleeping sandbox. */
let savers: readonly string[] = [];

/** One of the task's chats, as core.chat.list lists it. */
function chatRow(chatId: string): unknown {
  return {
    chatId,
    workspaceId: '11111111-1111-4111-8111-111111111111',
    worktreeId: TASK,
    title: chatId,
    state: 'idle',
    revision: 1,
    createdAt: '2026-11-10T09:00:00.000Z',
  };
}

/** A deliverable a chat saved, as core.artifact.list lists it. */
function savedCopy(chatId: string): unknown {
  return {
    artifactId: `dlv:${chatId}:00000000-0000-4000-8000-0000000000d1`,
    owner: { kind: 'chat', id: chatId },
    kind: 'file',
    name: 'ericeira_weather.csv',
    mediaType: 'text/csv',
    sizeBytes: 4,
    sha256: 'e'.repeat(64),
    createdAt: '2026-11-10T09:00:00.000Z',
    availability: 'available',
    transfer: null,
  };
}
const resolveFileReference = jest.fn();
const getFileTreeRoots = jest.fn();
const openFileTab = jest.fn((): string | null => 'file-tab-1');

beforeEach(() => {
  requests.length = 0;
  sandboxAsleep = false;
  refusal = null;
  resolvedKind = 'file';
  savers = [];
  resolveFileReference.mockReset();
  getFileTreeRoots.mockReset();
  openFileTab.mockClear();
  Object.assign(window, {
    api: { resolveFileReference, getFileTreeRoots },
    canopyCore: {
      invoke: (
        request: CanopyCoreRelayRequest,
      ): Promise<CanopyCoreRelayReply> => {
        requests.push(request);
        const params = 'params' in request ? request.params : undefined;
        // While the sandbox sleeps, a deliverable's link looks for its saved
        // copy among the task's chats first (CAN-6587).
        if ('method' in request && request.method === 'core.chat.list')
          return Promise.resolve({
            ok: true,
            value: { items: [TASK, OTHER_CHAT].map(chatRow), nextCursor: null },
          });
        if ('method' in request && request.method === 'core.artifact.list') {
          const owner = String(
            Reflect.get(Object(Reflect.get(Object(params), 'owner')), 'id'),
          );
          return Promise.resolve({
            ok: true,
            value: {
              artifacts: savers.includes(owner) ? [savedCopy(owner)] : [],
              nextCursor: null,
            },
          });
        }
        expect(LINK.params.safeParse(params).error).toBeUndefined();
        const href = String((params as { href: string }).href);
        if (refusal !== null)
          return Promise.resolve({ ok: false, error: refusal });
        // As the web core refuses a link to a missing path, and every link
        // while the sandbox sleeps (CAN-6648, CAN-6658).
        if (href.endsWith('/does-not-exist.txt'))
          return Promise.resolve({
            ok: false,
            error: {
              kind: 'not_found',
              code: 'worker.filesystem.link.notFound',
              message: 'The linked file does not exist.',
              retry: { kind: 'never' },
            },
          });
        if (sandboxAsleep)
          return Promise.resolve({
            ok: false,
            error: {
              kind: 'failed_precondition',
              code: 'worker.filesystem.link.invalidState',
              message: 'The sandbox is asleep.',
              details: { reason: 'sandbox_sleeping', wakeAllowed: true },
              retry: {
                kind: 'after_refresh',
                resource: 'worker.filesystem.link',
              },
            },
          });
        if (href.endsWith('/escape-link'))
          return Promise.resolve({
            ok: false,
            error: {
              kind: 'not_found',
              code: 'worker.filesystem.link.symlinkEscape',
              message: 'The link leaves the workspace.',
              retry: { kind: 'never' },
            },
          });
        if (!href.startsWith('/vercel/sandbox/workspace/'))
          return Promise.resolve({
            ok: false,
            error: {
              kind: 'failed_precondition',
              code: 'worker.filesystem.link.outsideRoots',
              message: 'The link points outside the task folder.',
              retry: { kind: 'never' },
            },
          });
        const value = {
          fileRootId: 'root-1',
          relativePath: 'deliverables/run-1/ericeira_weather.csv',
          name: 'ericeira_weather.csv',
          kind: resolvedKind,
        };
        expect(LINK.result.safeParse(value).error).toBeUndefined();
        return Promise.resolve({ ok: true, value });
      },
    },
  });
  useChatStore.setState({ openFileTab } as never);
});

async function click(href: string): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      <ChatMarkdownFileTargetContext.Provider value={TARGET}>
        <ChatMarkdownLink href={href}>the CSV</ChatMarkdownLink>
      </ChatMarkdownFileTargetContext.Provider>,
    );
  });
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[data-testid="chat-local-file-link"]')
      ?.click();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
  return container;
}

describe('a file link in a cloud chat on desktop (CAN-6587)', () => {
  it('resolves on the web core and opens in the file viewer, never through local IPC', async () => {
    await click(
      '/vercel/sandbox/workspace/deliverables/run-1/ericeira_weather.csv',
    );
    expect(requests).toEqual([
      expect.objectContaining({
        kind: 'request',
        method: 'worker.filesystem.link.resolve',
        authority: 'web-core',
        params: expect.objectContaining({
          scope: { chatId: TASK },
          mode: 'transcript',
        }) as unknown,
      }),
    ]);
    expect(openFileTab).toHaveBeenCalledWith(
      expect.objectContaining({
        absolutePath: webCoreFilePath({
          chatId: TASK,
          fileRootId: 'root-1',
          relativePath: 'deliverables/run-1/ericeira_weather.csv',
        }),
        filename: 'ericeira_weather.csv',
      }),
      TARGET,
    );
    expect(resolveFileReference).not.toHaveBeenCalled();
    expect(getFileTreeRoots).not.toHaveBeenCalled();
  });

  it('refuses a link outside the task folder, says so, and opens nothing', async () => {
    const container = await click('/etc/passwd');
    expect(openFileTab).not.toHaveBeenCalled();
    expect(resolveFileReference).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "This file isn't in the task's folder",
    );
  });

  it('still refuses a link that leaves the workspace by a symlink, as before (CAN-6648)', async () => {
    const container = await click(
      '/vercel/sandbox/workspace/notes/escape-link',
    );
    expect(openFileTab).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "This file isn't in the task's folder",
    );
  });

  it("says a link to a missing file wasn't found, apart from one outside the folder (CAN-6648)", async () => {
    const container = await click(
      '/vercel/sandbox/workspace/notes/does-not-exist.txt',
    );
    expect(openFileTab).not.toHaveBeenCalled();
    expect(container.textContent).toContain('File not found');
    expect(container.textContent).not.toContain("isn't in the task's folder");
  });

  it('says the project is sleeping when the sandbox sleeps, as Files does, not that the file failed (CAN-6658)', async () => {
    sandboxAsleep = true;
    const container = await click(
      '/vercel/sandbox/workspace/deliverables/run-1/ericeira_weather.csv',
    );
    expect(openFileTab).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'Project is sleeping. Send a message to wake it.',
    );
    expect(container.textContent).not.toContain("Couldn't open file");
  });

  it('says which name more than one chat saved while the sandbox sleeps, rather than open one (CAN-6587)', async () => {
    sandboxAsleep = true;
    savers = [TASK, OTHER_CHAT];
    const container = await click(
      '/vercel/sandbox/workspace/deliverables/run-1/ericeira_weather.csv',
    );
    expect(openFileTab).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'More than one chat in this task saved ericeira_weather.csv. Send a message in the task to wake it, then open the file from its folder.',
    );
  });
});

// The shared table every platform runs (CAN-6665): the refusal set is a
// security boundary, and only link.notFound leaves it.
describe("a cloud chat link's resolve outcomes on desktop, as shared with web (CAN-6665)", () => {
  it.each(FILE_LINK_RESOLVE_CASES)(
    '$name: $outcome, "$text"',
    async ({ refusal: answer, text }) => {
      refusal = answer;
      const container = await click(
        '/vercel/sandbox/workspace/deliverables/run-1/ericeira_weather.csv',
      );
      expect(openFileTab).not.toHaveBeenCalled();
      expect(resolveFileReference).not.toHaveBeenCalled();
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        text,
      );
    },
  );

  it('refuses a resolve that names no file, and opens nothing', async () => {
    resolvedKind = 'directory';
    const container = await click('/vercel/sandbox/workspace/deliverables');
    expect(openFileTab).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "This file isn't in the task's folder",
    );
  });
});
