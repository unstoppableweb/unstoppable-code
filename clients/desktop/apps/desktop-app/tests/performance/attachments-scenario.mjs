import {
  copyFileSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';
import { expect } from '@playwright/test';

/*
 * A Cowork project's Attachments section over a large folder (PR #10104).
 *
 * Opt-in. Two Cowork projects: a small one that is open at the start, and one
 * whose attachments folder holds ATTACHMENTS_PICTURES pictures of mixed sizes
 * and ATTACHMENTS_FILES other files. The measured window opens the large
 * project's work entry from the small one with the Activity rail's
 * Attachments section showing, waits until the section settles, then
 * wheel-scrolls the section to its end and back at a fixed step and cadence.
 * The section lists rows and reads no file's picture; the scenario counts
 * the `file:read-preview` calls main receives meanwhile, failed ones too,
 * which stay at none unless something starts drawing pictures. The harness's
 * own monitor reports frames, long tasks and memory for the window; this
 * scenario adds the open and settle times, the scroll windows for the frame
 * report and the preview calls main received.
 *
 * The fixture is generated once per fixture version under the system temp
 * folder: PNG pictures from a seeded generator, so a baseline and a candidate
 * read byte-identical files. Seeding goes through the on-disk workspace files
 * both sides of a comparison read, not through either build's own API.
 */

const FIXTURE_VERSION = 1;
export const ATTACHMENTS_PICTURES = 200;
export const ATTACHMENTS_FILES = 50;
const PICTURE_SIZES = Object.freeze([
  // Most pictures are screen-sized; three in ten are camera-sized. The
  // largest (1800x1200, a tenth of them) encode just over the preview's 5 MB
  // cap, so the folder also holds pictures that get no preview.
  ...Array.from({ length: 6 }, () => [800, 600]),
  ...Array.from({ length: 3 }, () => [1600, 1000]),
  [1800, 1200],
]);
const SCROLL_STEP_PX = 300;
const SCROLL_INTERVAL_MS = 100;
const SETTLE_QUIET_MS = 500;
const SETTLE_TIMEOUT_MS = 180_000;
const CREATED_AT = '2026-11-10T12:00:00.000Z';
const ITEM = '[data-testid="workspace-attachments-item"]';
const SECTION = '[data-testid="activity-section-attachments"]';
const SMALL = Object.freeze({
  workspace: 'perf-attachments-small',
  entry: 'perf-attachments-small-entry',
  name: 'Warm-up',
  text: 'Three files to start with.',
});
const LARGE = Object.freeze({
  workspace: 'perf-attachments-large',
  entry: 'perf-attachments-large-entry',
  name: 'Launch',
  text: 'Everything for the launch is in the folder.',
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** A gradient with grain: compresses about as poorly as a photo export. */
function encodePicture(width, height, seed) {
  const random = mulberry32(seed);
  const hue = random() * 255;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  let noise = seed >>> 0 || 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      noise ^= noise << 13;
      noise ^= noise >>> 17;
      noise ^= noise << 5;
      const grain = (noise >>> 0) % 24;
      const offset = row + 1 + x * 3;
      raw[offset] = (hue + (x * 160) / width + grain) & 255;
      raw[offset + 1] = ((y * 180) / height + grain) & 255;
      raw[offset + 2] =
        (255 - hue + ((x + y) * 90) / (width + height) + grain) & 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function fillerText(random, bytes) {
  const words = [
    'launch',
    'review',
    'quarter',
    'revenue',
    'summary',
    'notes',
    'draft',
    'plan',
  ];
  let text = '';
  while (text.length < bytes) {
    text += `${words[Math.floor(random() * words.length)]}${random() < 0.12 ? '\n' : ' '}`;
  }
  return text.slice(0, bytes);
}

/** The large folder's files, generated once and reused across launches. */
function ensureAttachmentsFixture() {
  const dir = path.join(
    os.tmpdir(),
    `canopy-perf-attachments-v${FIXTURE_VERSION}`,
  );
  const manifestPath = path.join(dir, 'manifest.json');
  // The cache sits at a fixed path in the temporary folder, which may be
  // shared: use it only when it is this user's own private directory, and
  // write into it only files this run creates.
  const existing = lstatSync(dir, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (
      !existing.isDirectory() ||
      (typeof process.getuid === 'function' &&
        existing.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (existing.mode & 0o022) !== 0)
    ) {
      throw new Error(
        `attachments-list-scroll will not use its fixture cache ${dir}: it is not this user's own directory, closed to others' writes. Remove it and run again.`,
      );
    }
    if (existsSync(manifestPath)) {
      return {
        dir,
        files: JSON.parse(readFileSync(manifestPath, 'utf8')).files,
      };
    }
    // A generation that stopped part way: start again.
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { mode: 0o700 });
  const random = mulberry32(10104);
  const files = [];
  for (let index = 0; index < ATTACHMENTS_PICTURES; index += 1) {
    const [width, height] = PICTURE_SIZES[index % PICTURE_SIZES.length];
    const name = `picture-${String(index + 1).padStart(3, '0')}.png`;
    writeFileSync(
      path.join(dir, name),
      encodePicture(width, height, index + 1),
      { flag: 'wx' },
    );
    files.push({ name, kind: 'image' });
  }
  for (let index = 0; index < ATTACHMENTS_FILES; index += 1) {
    const ordinal = String(index + 1).padStart(2, '0');
    const csv = index % 2 === 0;
    const name = csv ? `export-${ordinal}.csv` : `notes-${ordinal}.txt`;
    const content = csv
      ? `quarter,region,revenue\n${Array.from({ length: 50 + Math.floor(random() * 2_000) }, (_, row) => `Q${(row % 4) + 1},R${row % 9},${Math.floor(random() * 1e6)}`).join('\n')}\n`
      : fillerText(random, 2_000 + Math.floor(random() * 60_000));
    writeFileSync(path.join(dir, name), content, { flag: 'wx' });
    files.push({ name, kind: 'file' });
  }
  // The folder lists newest first; mix the kinds once.
  const ordered = files
    .map((file) => ({ file, key: random() }))
    .sort((a, b) => a.key - b.key)
    .map(({ file }) => file);
  writeFileSync(manifestPath, JSON.stringify({ files: ordered }), {
    flag: 'wx',
  });
  return { dir, files: ordered };
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedProject(userDataDir, project, order, files) {
  const workspaceDir = path.join(userDataDir, 'workspaces', project.workspace);
  const cowork = { createdAt: CREATED_AT, archiveRetentionDays: 7 };
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork,
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [
      { id: project.entry, title: project.name, createdAt: CREATED_AT },
    ],
  });
  // The Canopy brand's managed folder; reads accept either brand's name.
  const attachmentsDir = path.join(
    workspaceDir,
    'home',
    '.canopy',
    'attachments',
  );
  mkdirSync(attachmentsDir, { recursive: true });
  const newest = Date.parse('2026-11-10T11:00:00.000Z') / 1000;
  files.forEach((file, index) => {
    const target = path.join(attachmentsDir, file.name);
    copyFileSync(file.from, target, fsConstants.COPYFILE_FICLONE);
    utimesSync(target, newest - index * 60, newest - index * 60);
  });
  writeJson(path.join(workspaceDir, 'chats', `${project.entry}.json`), {
    version: 1,
    activeTabId: `chat-${project.entry}`,
    tabs: [
      {
        id: `chat-${project.entry}`,
        title: project.name,
        kind: 'chat',
        providerType: 'claude',
        createdAt: CREATED_AT,
        messages: [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: project.text }],
            timestamp: Date.parse('2026-11-10T12:01:00.000Z'),
          },
        ],
      },
    ],
  });
  return {
    id: project.workspace,
    name: project.name,
    type: 'cowork',
    color: '#7C9B6D',
    collapsed: false,
    order,
    cowork,
  };
}

export function prepareAttachmentsListScroll(userDataDir) {
  const fixture = ensureAttachmentsFixture();
  const large = fixture.files.map((file) => ({
    ...file,
    from: path.join(fixture.dir, file.name),
  }));
  const small = large
    .filter((file) => file.kind === 'image')
    .slice(0, 2)
    .concat(large.filter((file) => file.kind === 'file').slice(0, 1));
  writeJson(path.join(userDataDir, 'preferences.json'), {
    version: 1,
    preferences: { onboardingCompleted: ['v1'] },
  });
  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      seedProject(userDataDir, SMALL, 0, small),
      seedProject(userDataDir, LARGE, 1, large),
    ],
  });
  return {
    expectedItems: large.length,
    pictures: ATTACHMENTS_PICTURES,
    files: ATTACHMENTS_FILES,
  };
}

async function expandProject(page, project) {
  const toggle = page.getByTestId(
    `sidebar-cowork-project-${project.workspace}-toggle`,
  );
  await toggle.waitFor({ state: 'visible', timeout: 30_000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true')
    await toggle.click();
  await page
    .getByTestId(`sidebar-work-entry-${project.entry}`)
    .waitFor({ state: 'visible', timeout: 15_000 });
}

/** The Activity rail open on the Attachments section, its items showing. */
async function showAttachments(page) {
  const section = page.locator(SECTION);
  if (!(await section.isVisible().catch(() => false))) {
    await page
      .getByTestId('panel-group-group-activity')
      .getByTestId('panel-group-expand-group-activity')
      .click({ timeout: 10_000 });
  }
  await section.waitFor({ state: 'visible', timeout: 30_000 });
  try {
    await page
      .locator(ITEM)
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    const shown = await section.innerText().catch(() => '');
    throw new Error(
      `attachments-list-scroll: the Attachments section lists no file; it shows "${shown.slice(0, 200)}"`,
      { cause: error },
    );
  }
}

/**
 * A signed-in account, which the Attachments section needs (a guest's asks to
 * sign in instead of listing). An E2E build comes up signed out and takes a
 * mock key. A production bundle comes up as the mock cloud's guest, and a
 * manual key cannot replace a guest session, so it signs in through its own
 * desktop sign-in flow: the runner stands in for the browser, taking the
 * authorize URL main would open and answering main's loopback callback with
 * a code, which the mock exchanges for a real account's key.
 */
async function signInForAttachments(page, electronApp) {
  const manual = await page.evaluate(async () => {
    const result = await window.api.saveCanopyCloudApiKey({
      apiKey: 'csk_attachments_list_perf',
    });
    return {
      authenticated: result.status?.authenticated === true,
      guest:
        result.account?.credentialSource === 'guest' ||
        result.account?.authMode === 'guest',
      error: result.status?.error ?? null,
    };
  });
  if (manual.authenticated) {
    await page.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    return;
  }
  if (!manual.guest) {
    throw new Error(
      `attachments-list-scroll could not sign in: ${String(manual.error)}`,
    );
  }
  await electronApp.evaluate(({ shell }) => {
    const original = shell.openExternal;
    globalThis.__attachmentsSignIn = { url: null, original };
    shell.openExternal = async (url) => {
      globalThis.__attachmentsSignIn.url = url;
    };
  });
  try {
    const login = page.evaluate(async () => {
      const result = await window.api.startCanopyCloudOAuthLogin();
      return {
        authenticated: result.status?.authenticated === true,
        guest:
          result.account?.credentialSource === 'guest' ||
          result.account?.authMode === 'guest',
        error: result.status?.error ?? null,
      };
    });
    // Awaited below; a failure before then must not go unhandled.
    login.catch(() => undefined);
    let authorizeUrl = null;
    const deadline = Date.now() + 30_000;
    while (authorizeUrl === null) {
      authorizeUrl = await electronApp.evaluate(
        () => globalThis.__attachmentsSignIn?.url ?? null,
      );
      if (authorizeUrl !== null) break;
      if (Date.now() > deadline) {
        throw new Error(
          'attachments-list-scroll: the desktop sign-in never opened its authorize URL',
        );
      }
      await delay(100);
    }
    const authorize = new URL(authorizeUrl);
    const redirect = authorize.searchParams.get('redirect_uri');
    const state = authorize.searchParams.get('state');
    if (redirect === null || state === null) {
      throw new Error(
        'attachments-list-scroll: the authorize URL has no redirect or state',
      );
    }
    const callback = new URL(redirect);
    callback.searchParams.set('code', 'attachments-perf');
    callback.searchParams.set('state', state);
    const answered = await fetch(callback);
    await answered.arrayBuffer();
    const signedIn = await login;
    if (!signedIn.authenticated || signedIn.guest) {
      throw new Error(
        `attachments-list-scroll could not sign in through the desktop sign-in: ${String(signedIn.error)}`,
      );
    }
  } finally {
    await electronApp.evaluate(({ shell }) => {
      const signIn = globalThis.__attachmentsSignIn;
      if (signIn !== undefined) shell.openExternal = signIn.original;
      delete globalThis.__attachmentsSignIn;
    });
  }
  await page.evaluate(() =>
    window.dispatchEvent(new Event('canopy:cloud-account-changed')),
  );
}

/**
 * Counts `file:read-preview` calls on main's own handler: every call when it
 * starts, so a read that fails still counts, and the failures on their own.
 */
async function countPreviewReads(electronApp) {
  const wrapped = await electronApp.evaluate(({ ipcMain }) => {
    const channel = 'file:read-preview';
    const handlers = ipcMain._invokeHandlers;
    const original = handlers?.get(channel);
    if (!handlers || !original) return false;
    const state = {
      inFlight: 0,
      maxInFlight: 0,
      calls: 0,
      failures: 0,
      replies: 0,
      bytes: 0,
      lastActivity: 0,
    };
    globalThis.__attachmentsPreviewReads = state;
    handlers.set(channel, async (...args) => {
      state.calls += 1;
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      state.lastActivity = Date.now();
      try {
        const result = await original(...args);
        state.replies += 1;
        if (typeof result?.content === 'string')
          state.bytes += result.content.length;
        return result;
      } catch (error) {
        state.failures += 1;
        throw error;
      } finally {
        state.inFlight -= 1;
        state.lastActivity = Date.now();
      }
    });
    return true;
  });
  if (!wrapped)
    throw new Error(
      'attachments-list-scroll found no file:read-preview handler',
    );
}

function previewState(electronApp) {
  return electronApp.evaluate(() => ({
    ...globalThis.__attachmentsPreviewReads,
    now: Date.now(),
  }));
}

/** Listed, no preview read in flight, and the section unchanged for a while. */
async function waitUntilSettled(page, electronApp, expectedItems) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const [listed, quietForMs] = await page.evaluate(
      ({ selector }) => [
        document.querySelectorAll(selector).length,
        performance.now() - (window.__attachmentsListLastChange ?? 0),
      ],
      { selector: ITEM },
    );
    const preview = await previewState(electronApp);
    const readQuietMs = preview.now - preview.lastActivity;
    if (
      listed >= expectedItems &&
      preview.inFlight === 0 &&
      quietForMs >= SETTLE_QUIET_MS &&
      readQuietMs >= SETTLE_QUIET_MS
    )
      return;
    if (Date.now() > deadline)
      throw new Error(
        `attachments-list-scroll did not settle: ${String(listed)} of ${String(expectedItems)} listed, ${String(preview.inFlight)} reads in flight`,
      );
    await delay(50);
  }
}

/**
 * Definitions with the harness helpers injected, so this file never imports
 * `scenarios.mjs`, which imports it.
 */
export function attachmentsScenarios({
  recordTask,
  recordFrameWindow,
  openMainPage,
}) {
  return {
    'attachments-list-scroll': {
      prepare: prepareAttachmentsListScroll,
      // Not timed: a signed-in account (a production bundle can come up as a
      // guest), the small project open with its Attachments section showing,
      // and main's preview reads counted.
      beforeCapture: async ({ page, electronApp }) => {
        await signInForAttachments(page, electronApp);
        await openMainPage(page);
        await expandProject(page, SMALL);
        await expandProject(page, LARGE);
        await countPreviewReads(electronApp);
        // Each work entry keeps its own panel layout: open the Activity rail
        // in the large one too, as a returning user's layout would have it,
        // so the measured open shows the section without opening the rail.
        await page.getByTestId(`sidebar-work-entry-${LARGE.entry}`).click();
        await page
          .getByText(LARGE.text)
          .first()
          .waitFor({ state: 'visible', timeout: 30_000 });
        await showAttachments(page);
        await page.getByTestId(`sidebar-work-entry-${SMALL.entry}`).click();
        await page
          .getByText(SMALL.text)
          .first()
          .waitFor({ state: 'visible', timeout: 30_000 });
        await showAttachments(page);
        await expect(page.locator(ITEM)).toHaveCount(3, { timeout: 30_000 });
        await page.evaluate((selector) => {
          new MutationObserver((records) => {
            for (const record of records) {
              const element =
                record.target instanceof Element
                  ? record.target
                  : record.target.parentElement;
              if (element?.closest(selector)) {
                window.__attachmentsListLastChange = performance.now();
                return;
              }
            }
          }).observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
        }, SECTION);
        // Anything the large entry's first open read ends before the window.
        await waitUntilSettled(page, electronApp, 3);
      },
      run: async ({ page, electronApp, tasks, fixture }) => {
        // The peak of reads in flight counts the measured window only, as
        // the reply and byte totals do, not the setup's reads.
        await electronApp.evaluate(() => {
          globalThis.__attachmentsPreviewReads.maxInFlight = 0;
        });
        const readsAtStart = await previewState(electronApp);
        // The open runs as one task, `attachments_open`, which brackets the
        // harness's work and renderer marks. Its milestones are timed inside
        // it, from just before the click to the moment each is seen, so no
        // instrumentation lands between them: listed, then settled, and the
        // whole open (`attachments_open_to_settled`).
        const marks = await recordTask(tasks, 'attachments_open', async () => {
          const clickedAt = performance.now();
          await page.getByTestId(`sidebar-work-entry-${LARGE.entry}`).click();
          await expect(page.locator(ITEM)).toHaveCount(fixture.expectedItems, {
            timeout: 60_000,
          });
          const listedAt = performance.now();
          await waitUntilSettled(page, electronApp, fixture.expectedItems);
          return { clickedAt, listedAt, settledAt: performance.now() };
        });
        const openToSettledMs = marks.settledAt - marks.clickedAt;
        tasks.push(
          {
            kind: 'attachments_open_listed',
            status: 'ok',
            durationMs: marks.listedAt - marks.clickedAt,
          },
          {
            kind: 'attachments_listed_to_settled',
            status: 'ok',
            durationMs: marks.settledAt - marks.listedAt,
          },
          {
            kind: 'attachments_open_to_settled',
            status: 'ok',
            durationMs: openToSettledMs,
          },
        );
        const readsAfterOpen = await previewState(electronApp);

        // The scroll container, and a point inside it that is on no item: a
        // row under a resting pointer opens its hover preview, which would
        // take the wheel.
        const target = await page.evaluate((selector) => {
          const first = document.querySelector(selector);
          let scroller = first?.parentElement ?? null;
          while (
            scroller &&
            !(
              /(auto|scroll)/.test(getComputedStyle(scroller).overflowY) &&
              scroller.scrollHeight > scroller.clientHeight + 4
            )
          ) {
            scroller = scroller.parentElement;
          }
          if (!scroller) {
            const chain = [];
            for (let node = first; node; node = node.parentElement) {
              const style = getComputedStyle(node);
              chain.push(
                `${node.tagName.toLowerCase()}[${node.getAttribute('data-testid') ?? ''}] ${style.overflowY} ${String(node.scrollHeight)}/${String(node.clientHeight)}`,
              );
            }
            return {
              error: `no scrollable ancestor: ${chain.slice(0, 16).join(' < ')}; window ${String(window.innerWidth)}x${String(window.innerHeight)}`,
            };
          }
          scroller.setAttribute('data-perf-attachments-scroller', '');
          const rect = scroller.getBoundingClientRect();
          // The nearest point to the middle that is inside the scroller and
          // on no item: an edge, or a gap between rows.
          const middle = rect.top + rect.height / 2;
          for (let dy = 0; dy < rect.height / 2; dy += 2) {
            for (const y of [middle + dy, middle - dy]) {
              for (let x = rect.left + 1; x < rect.right - 1; x += 1) {
                const hit = document.elementFromPoint(x, y);
                if (hit && scroller.contains(hit) && !hit.closest(selector)) {
                  return {
                    x: Math.round(x),
                    y: Math.round(y),
                    maxTop: scroller.scrollHeight - scroller.clientHeight,
                  };
                }
              }
            }
          }
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return {
            error: `no point beside the items in ${JSON.stringify(rect.toJSON())}; the middle hits ${hit?.outerHTML.slice(0, 160) ?? 'nothing'}`,
          };
        }, ITEM);
        if ('error' in target) {
          throw new Error(`attachments-list-scroll: ${target.error}`);
        }
        await page.mouse.move(target.x, target.y);
        const scrollTop = () =>
          page.evaluate(
            () =>
              document.querySelector('[data-perf-attachments-scroller]')
                ?.scrollTop ?? -1,
          );
        const wheel = async (direction) => {
          const startedAt = performance.now();
          let steps = 0;
          for (; steps < 400; steps += 1) {
            await page.mouse.wheel(0, direction * SCROLL_STEP_PX);
            const wait =
              startedAt + (steps + 1) * SCROLL_INTERVAL_MS - performance.now();
            if (wait > 0) await delay(wait);
            const top = await scrollTop();
            // A missing scroller is a failed pass, never a top reached.
            if (top < 0) {
              throw new Error(
                'attachments-list-scroll: the scroll container went away mid-scroll',
              );
            }
            if (
              (direction > 0 && top >= target.maxTop - 1) ||
              (direction < 0 && top <= 0)
            )
              return steps + 1;
          }
          throw new Error(
            `attachments-list-scroll: the scroll did not reach its ${direction > 0 ? 'end' : 'top'} in 400 steps`,
          );
        };
        const downSteps = await recordFrameWindow(
          tasks,
          'scroll',
          'attachments-down',
          () => recordTask(tasks, 'attachments_scroll_down', () => wheel(1)),
        );
        await recordTask(tasks, 'attachments_bottom_settled', () =>
          waitUntilSettled(page, electronApp, fixture.expectedItems),
        );
        const upSteps = await recordFrameWindow(
          tasks,
          'scroll',
          'attachments-up',
          () => recordTask(tasks, 'attachments_scroll_up', () => wheel(-1)),
        );
        await recordTask(tasks, 'attachments_top_settled', () =>
          waitUntilSettled(page, electronApp, fixture.expectedItems),
        );
        const readsAtEnd = await previewState(electronApp);
        return {
          attachmentsListed: fixture.expectedItems,
          attachmentsOpenToSettledMs: Math.round(openToSettledMs),
          attachmentsPictures: fixture.pictures,
          attachmentsOtherFiles: fixture.files,
          attachmentsScrollHeightPx: target.maxTop,
          attachmentsScrollDownSteps: downSteps,
          attachmentsScrollUpSteps: upSteps,
          attachmentsPreviewReadsOnOpen:
            readsAfterOpen.calls - readsAtStart.calls,
          attachmentsPreviewReads: readsAtEnd.calls - readsAtStart.calls,
          attachmentsPreviewReadFailures:
            readsAtEnd.failures - readsAtStart.failures,
          // The replies' encoded size (data URL characters), not bytes read
          // from disk.
          attachmentsPreviewReplyChars: readsAtEnd.bytes - readsAtStart.bytes,
          attachmentsPreviewMaxInFlight: readsAtEnd.maxInFlight,
        };
      },
    },
  };
}
