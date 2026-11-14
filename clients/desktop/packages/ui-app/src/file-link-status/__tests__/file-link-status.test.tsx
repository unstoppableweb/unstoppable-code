/** @jest-environment jsdom */
/**
 * Why a cloud chat's file link didn't open, said the same way on desktop and
 * web (CAN-6665). The refusal set is a security boundary: a link that names
 * nothing inside the task's folder opens nothing, and only
 * `worker.filesystem.link.notFound` leaves that set. Desktop and web each
 * run the same table through their own resolve as well.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Markdown } from '@canopy/ui-shared/components';
import type { TurnFileRecord } from '@canopy/protocol/turn-files';
import {
  TRANSCRIPT_FILE_LINK_MARKDOWN_OPTIONS,
  TranscriptFileLinkInteractionProvider,
} from '../../code/TranscriptFileLinks';
import { TurnFiles } from '../../code/TurnFiles';
import {
  classifyFileLinkRefusal,
  fileLinkFailureOf,
  fileLinkFailureText,
  fileLinkTargetOrNull,
  MISSING_FILE_LINK_CODE,
  REFUSED_FILE_LINK_CODES,
  withFileLinkFailure,
  type FileLinkFailure,
} from '../file-link-status';
import { FILE_LINK_RESOLVE_CASES } from './fixtures/file-link-resolve-cases';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("a cloud chat file link's refusals (CAN-6665)", () => {
  it('refuses exactly the codes desktop refused before, and treats only link.notFound as missing', () => {
    expect([...REFUSED_FILE_LINK_CODES].sort()).toEqual([
      'worker.filesystem.link.outsideRoots',
      'worker.filesystem.link.symlinkEscape',
      'worker.filesystem.link.unsupported',
    ]);
    expect(MISSING_FILE_LINK_CODE).toBe('worker.filesystem.link.notFound');
    expect(
      FILE_LINK_RESOLVE_CASES.filter(({ outcome }) => outcome !== 'refused')
        .map(({ refusal }) => refusal)
        .filter(({ kind }) => kind === 'not_found')
        .map(({ code }) => code),
    ).toEqual([MISSING_FILE_LINK_CODE]);
  });

  it.each(FILE_LINK_RESOLVE_CASES)(
    '$name: $outcome, "$text"',
    ({ refusal, outcome, text }) => {
      const failure = classifyFileLinkRefusal(refusal);
      expect(failure.kind).toBe(outcome);
      expect(fileLinkFailureText(failure)).toBe(text);
    },
  );

  it('carries the reason on a rejection, and reads nothing from an unmarked one', () => {
    const failures: readonly FileLinkFailure[] = [
      { kind: 'refused' },
      { kind: 'missing' },
      { kind: 'not-awake', message: 'Project is sleeping.' },
      { kind: 'failed' },
    ];
    for (const failure of failures)
      expect(
        fileLinkFailureOf(withFileLinkFailure(new Error('x'), failure)),
      ).toEqual(failure);
    expect(fileLinkFailureOf(new Error('x'))).toBeNull();
    expect(fileLinkFailureOf(null)).toBeNull();
    expect(
      fileLinkFailureOf(Object.assign(new Error('x'), { fileLinkFailure: 1 })),
    ).toBeNull();
    expect(
      fileLinkFailureOf(
        Object.assign(new Error('x'), {
          fileLinkFailure: { kind: 'not-awake' },
        }),
      ),
    ).toBeNull();
  });
});

describe("the shared transcript link's status (CAN-6665)", () => {
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

  async function click(
    openFileLink: (href: string) => Promise<boolean>,
  ): Promise<void> {
    act(() => {
      root.render(
        <TranscriptFileLinkInteractionProvider value={{ openFileLink }}>
          <Markdown options={TRANSCRIPT_FILE_LINK_MARKDOWN_OPTIONS}>
            {'[the CSV](/vercel/sandbox/workspace/a.csv)'}
          </Markdown>
        </TranscriptFileLinkInteractionProvider>,
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="markdown-file-link"]')
        ?.click();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
  }

  function linkState(): string | null {
    return (
      container
        .querySelector('[data-file-link-state]')
        ?.getAttribute('data-file-link-state') ?? null
    );
  }

  function status(): string | null {
    return (
      container.querySelector('[data-testid="file-link-status"]')
        ?.textContent ?? null
    );
  }

  it('says a missing file was not found, and leaves the link inert', async () => {
    await click(() =>
      Promise.reject(
        withFileLinkFailure(new Error('gone'), { kind: 'missing' }),
      ),
    );
    expect(linkState()).toBe('unavailable');
    expect(status()).toBe('File not found');
  });

  it('says the project is sleeping, and keeps the link to try again', async () => {
    const openFileLink = jest
      .fn<Promise<boolean>, [string]>()
      .mockRejectedValueOnce(
        withFileLinkFailure(new Error('asleep'), {
          kind: 'not-awake',
          message: 'Project is sleeping. Send a message to wake it.',
        }),
      )
      .mockResolvedValueOnce(true);
    await click(openFileLink);
    expect(linkState()).toBe('idle');
    expect(status()).toBe('Project is sleeping. Send a message to wake it.');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="markdown-file-link"]')
        ?.click();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(openFileLink).toHaveBeenCalledTimes(2);
    expect(status()).toBeNull();
  });

  it('shows nothing for a link the host refuses, as before', async () => {
    await click(() => Promise.resolve(false));
    expect(linkState()).toBe('unavailable');
    expect(status()).toBeNull();
  });

  it('keeps an unmarked failure retryable and silent, as before', async () => {
    await click(() => Promise.reject(new Error('offline')));
    expect(linkState()).toBe('idle');
    expect(status()).toBeNull();
  });
});

describe("a turn's files when one of them is gone (CAN-6665)", () => {
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

  it("reads a missing file as gone, so it hides only itself, not the turn's other files", async () => {
    const files: readonly TurnFileRecord[] = [
      { path: 'notes/gone.txt', state: 'ready', saved: true },
      { path: 'notes/shown.md', state: 'ready' },
    ];
    // As the web resolves a turn's files: a missing one rejects marked, for
    // the link, and the turn-files host reads it as no target.
    const resolveLink = (path: string): Promise<{ path: string } | null> =>
      path === 'notes/gone.txt'
        ? Promise.reject(
            withFileLinkFailure(new Error('gone'), { kind: 'missing' }),
          )
        : Promise.resolve({ path });
    const resolve = jest.fn(async (file: TurnFileRecord) => {
      const resolution = await fileLinkTargetOrNull(resolveLink(file.path));
      return { identity: file.path, exists: resolution !== null };
    });
    await act(async () => {
      root.render(
        <TranscriptFileLinkInteractionProvider
          value={{
            openFileLink: () => Promise.resolve(true),
            turnFiles: { collect: () => files, resolve },
          }}
        >
          <TurnFiles messages={[]} complete latest turnId="turn-1" />
        </TranscriptFileLinkInteractionProvider>,
      );
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('shown.md');
    expect(container.textContent).not.toContain('gone.txt');
  });

  it('still rejects anything but a missing file', async () => {
    await expect(
      fileLinkTargetOrNull(Promise.reject(new Error('offline'))),
    ).rejects.toThrow('offline');
    await expect(
      fileLinkTargetOrNull(
        Promise.reject(
          withFileLinkFailure(new Error('asleep'), {
            kind: 'not-awake',
            message: 'Project is sleeping.',
          }),
        ),
      ),
    ).rejects.toThrow('asleep');
  });
});
