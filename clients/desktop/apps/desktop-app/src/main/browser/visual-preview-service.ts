import {
  app,
  BrowserWindow,
  type NativeImage,
  type WebFrameMain,
} from 'electron';
import {
  AGENT_VISUAL_DOCUMENT_HEIGHT_SOURCE,
  buildAgentVisualPreviewHostDocument,
  buildAgentVisualSrcDoc,
  buildAgentVisualWrapperSrcDoc,
} from '@canopy/ui-shared/lib/agent-visual-html';
import { isAllowedMainWindowFrameNavigation } from '../lib/subframe-navigation-guard';
import {
  getVisualPreviewSessionPolicy,
  type VisualPreviewBlockedRequests,
} from './visual-preview-session-policy';
import { resolveVisualPreviewTheme } from './visual-preview-theme';
import {
  VISUAL_PREVIEW_LIMITS,
  type VisualDiagnostic,
  type VisualCspViolation,
  type VisualMeasureRequest,
  type VisualMeasureResult,
  type VisualPreviewImage,
  type VisualPreviewRequest,
  type VisualPreviewResult,
  type VisualPreviewService,
  type VisualPreviewStatus,
} from './visual-preview-types';

const previewWindows = new Set<BrowserWindow>();
export function isVisualPreviewWindow(window: BrowserWindow): boolean {
  return previewWindows.has(window);
}
export function getVisualPreviewWindowCount(): number {
  return previewWindows.size;
}

const DEFAULT_TIMING = {
  queuedMs: 0,
  loadMs: 0,
  settleMs: 0,
  captureMs: 0,
  totalMs: 0,
};
function emptyPreview(status: VisualPreviewStatus): VisualPreviewResult {
  return {
    status,
    image: null,
    contentHeight: 0,
    capturedHeight: 0,
    console: [],
    cspViolations: [],
    blockedRequests: [],
    omitted: { console: 0, cspViolations: 0, blockedRequests: 0 },
    timing: DEFAULT_TIMING,
  };
}

class RunStopped extends Error {
  constructor(readonly status: VisualPreviewStatus) {
    super(status);
  }
}

interface Run {
  readonly started: number;
  readonly deadline: number;
  readonly signal?: AbortSignal;
  readonly stopped: Promise<never>;
  readonly stop: (status: VisualPreviewStatus) => void;
  dispose: () => void;
  ended: boolean;
  /** Why the run was stopped, kept for the check before the next step. */
  stopStatus?: VisualPreviewStatus;
  queuedMs: number;
  window?: BrowserWindow;
}

function createRun(deadlineMs: number, signal?: AbortSignal): Run {
  const started = Date.now();
  let rejectStopped: (error: Error) => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  // A rejected stop promise is normal even when work completes first.
  void stopped.catch(() => undefined);
  const run: Run = {
    started,
    deadline: started + Math.max(0, deadlineMs),
    signal,
    stopped,
    stop: (status): void => {
      if (run.ended) return;
      run.ended = true;
      run.stopStatus = status;
      rejectStopped(new RunStopped(status));
    },
    dispose: (): void => undefined,
    ended: false,
    queuedMs: 0,
  };
  const timeout = setTimeout(
    () => run.stop('timeout'),
    Math.max(0, deadlineMs),
  );
  const onAbort = (): void => run.stop('aborted');
  signal?.addEventListener('abort', onAbort, { once: true });
  run.dispose = (): void => {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  };
  if (signal?.aborted) run.stop('aborted');
  return run;
}

function checkRun(run: Run): void {
  if (run.signal?.aborted) throw new RunStopped('aborted');
  if (run.stopStatus) throw new RunStopped(run.stopStatus);
  if (Date.now() >= run.deadline) throw new RunStopped('timeout');
  if (run.ended) throw new RunStopped('error');
}

async function step<T>(run: Run, work: Promise<T>): Promise<T> {
  checkRun(run);
  const result = await Promise.race([work, run.stopped]);
  checkRun(run);
  return result;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.ceil(value)));
}

/** The frame in the agent's place: the relay frame's child, whatever it shows. */
function findAgentSlot(window: BrowserWindow): WebFrameMain | null {
  const main = window.webContents.mainFrame;
  for (const frame of main.framesInSubtree) {
    if (
      !frame.detached &&
      frame.parent?.parent?.frameTreeNodeId === main.frameTreeNodeId
    )
      return frame;
  }
  return null;
}

function findAgentFrame(window: BrowserWindow): WebFrameMain | null {
  const frame = findAgentSlot(window);
  return frame?.url === 'about:srcdoc' ? frame : null;
}

// The page controls `Promise`, `document.fonts`, and `requestAnimationFrame`.
// An async function's own result is a native promise for its return value, so
// each program hands main only `true`, or never settles and hits the deadline.
const FRAME_SETTLE = `(async () => {
  try { await document.fonts.ready; } catch {}
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
})()`;
const SHELL_SETTLE = `(async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
})()`;
const MEASURE = `(() => { ${AGENT_VISUAL_DOCUMENT_HEIGHT_SOURCE}; const h = documentHeight(); return typeof h === 'number' && h === h ? h : -1; })()`;

const AGENT_FRAME_WATCH_MS = 25;

/**
 * Runs a program in the agent frame. A frame that navigates away never
 * answers, so the frame is checked while the program runs, and the wait ends
 * as soon as it is no longer the agent's document.
 */
async function runInAgentFrame(
  run: Run,
  window: BrowserWindow,
  frame: WebFrameMain,
  code: string,
): Promise<unknown> {
  const frameId = frame.frameTreeNodeId;
  let finished = false;
  const navigated = new Promise<never>((_resolve, reject) => {
    const timer = setInterval(() => {
      if (finished || run.ended) {
        clearInterval(timer);
        return;
      }
      let current: WebFrameMain | null = null;
      try {
        current = findAgentFrame(window);
      } catch {
        // A destroyed window has no frames; the run ends through its own event.
      }
      if (current?.frameTreeNodeId !== frameId) {
        clearInterval(timer);
        reject(new Error('Agent frame navigated'));
      }
    }, AGENT_FRAME_WATCH_MS);
  });
  // The run can stop first, which leaves this rejection with no listener.
  void navigated.catch(() => undefined);
  try {
    return await step(
      run,
      Promise.race([frame.executeJavaScript(code, false), navigated]),
    );
  } finally {
    finished = true;
  }
}

async function settle(run: Run, window: BrowserWindow): Promise<WebFrameMain> {
  let frame = findAgentFrame(window);
  while (!frame) {
    // A visual that navigated itself (the relay's CSP blocks the load and
    // leaves an error page) has no document to measure; fail now rather
    // than wait out the deadline.
    const slot = findAgentSlot(window);
    if (slot && slot.url !== '' && slot.url !== 'about:blank')
      throw new Error('Agent frame navigated');
    await step(run, new Promise<void>((resolve) => setTimeout(resolve, 10)));
    frame = findAgentFrame(window);
  }
  const frameId = frame.frameTreeNodeId;
  await runInAgentFrame(run, window, frame, FRAME_SETTLE);
  await step(run, window.webContents.executeJavaScript(SHELL_SETTLE, false));
  const current = findAgentFrame(window);
  if (!current || current.frameTreeNodeId !== frameId)
    throw new Error('Agent frame changed');
  return current;
}

async function measureHeight(
  run: Run,
  window: BrowserWindow,
  frame: WebFrameMain,
): Promise<number> {
  const raw = await runInAgentFrame(run, window, frame, MEASURE);
  if (
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    raw <= 0 ||
    raw > 1_000_000
  ) {
    throw new Error('Invalid visual height');
  }
  return raw;
}

function pinZoom(window: BrowserWindow): void {
  window.webContents.setZoomFactor(1);
  // Electron 45 rejects while the main frame's renderer is not live yet (as
  // right after window creation); the limits are already saved in the
  // window's preferences, so later loads still get them.
  window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
}

async function loadDocument(
  run: Run,
  window: BrowserWindow,
  html: string,
  width: number,
  height: number,
  appearance?: 'light' | 'dark',
): Promise<void> {
  const theme = await step(run, resolveVisualPreviewTheme(appearance));
  const title = 'Visual preview';
  const document = buildAgentVisualPreviewHostDocument(
    buildAgentVisualWrapperSrcDoc(buildAgentVisualSrcDoc(html, theme), {
      title,
      appearance: theme.appearance,
    }),
    { title, width, height },
  );
  await step(run, window.loadURL('about:blank'));
  // Markup is a string literal in the injected program, never executable code.
  await step(
    run,
    window.webContents.executeJavaScript(
      `document.open();document.write(${JSON.stringify(document)});document.close();`,
      false,
    ),
  );
}

function imageCandidate(
  image: NativeImage,
  mime: 'image/png' | 'image/jpeg',
  quality: number,
): { bytes: Buffer; width: number; height: number } {
  const bytes = mime === 'image/png' ? image.toPNG() : image.toJPEG(quality);
  return {
    width: image.getSize().width,
    height: image.getSize().height,
    bytes,
  };
}

const IMAGE_OMITTED_BY_BUDGET = 'Image omitted by provider budget.';

/** At most four synchronous encodes; omit rather than exceed a provider budget. */
export function encodeForBudget(
  source: NativeImage,
  budget: number,
  cssWidth: number,
  cssHeight: number,
): { image: VisualPreviewImage | null; reason?: string } {
  if (!Number.isFinite(budget) || budget <= 0)
    return { image: null, reason: IMAGE_OMITTED_BY_BUDGET };
  let image = source.resize({ width: cssWidth, height: cssHeight });
  const minWidth = Math.min(240, cssWidth);
  const smallBudget = budget < 128 * 1024;
  if (smallBudget) {
    // JPEG at quality 80 is roughly a fifth of a byte per pixel for charts
    // and text; an over-budget first try is shrunk from its real size.
    const estimatedScale = Math.min(
      1,
      Math.sqrt(budget / Math.max(1, cssWidth * cssHeight * 0.2)),
    );
    const firstWidth = clamp(
      Math.floor(cssWidth * estimatedScale),
      minWidth,
      cssWidth,
    );
    if (firstWidth < cssWidth) image = image.resize({ width: firstWidth });
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const mime = smallBudget || attempt >= 2 ? 'image/jpeg' : 'image/png';
    const quality = attempt === 3 ? 60 : 80;
    const candidate = imageCandidate(image, mime, quality);
    if (candidate.bytes.byteLength <= budget)
      return {
        image: {
          dataUrl: `data:${mime};base64,${candidate.bytes.toString('base64')}`,
          mime,
          width: candidate.width,
          height: candidate.height,
          bytes: candidate.bytes.byteLength,
        },
      };
    if (image.getSize().width <= minWidth) {
      if (mime === 'image/jpeg' && quality === 60) break;
    } else {
      const nextWidth = Math.max(
        minWidth,
        Math.floor(
          image.getSize().width *
            Math.sqrt(budget / candidate.bytes.byteLength) *
            0.9,
        ),
      );
      image = image.resize({
        width: Math.min(image.getSize().width - 1, nextWidth),
      });
    }
  }
  return { image: null, reason: 'Screenshot exceeds the image budget.' };
}

function boundedMessage(value: string): string {
  return value.slice(0, VISUAL_PREVIEW_LIMITS.diagnostics.chars);
}

/**
 * Chromium's console text for a CSP violation, in its current wording
 * ("Loading the image '<url>' violates the following Content Security Policy
 * directive: "img-src data:"…") and its older one ("Refused to load '<url>'
 * because it violates…"). Best effort: the text is browser-authored, but the
 * page controls the URL in it.
 */
function parseCsp(message: string): VisualCspViolation | null {
  const directive = message.match(
    /violates the following Content Security Policy directive:?\s*["']([^"]+)["']/,
  );
  if (!directive) return null;
  const blocked = message.match(/'([^']+)' (?:because it )?violates/);
  return {
    directive: boundedMessage(directive[1]?.split(' ')[0] ?? 'unknown'),
    blockedUri: boundedMessage(blocked?.[1] ?? 'inline'),
  };
}

function destroyRunWindow(window: BrowserWindow): void {
  previewWindows.delete(window);
  try {
    window.webContents.removeAllListeners('will-navigate');
    window.webContents.removeAllListeners('will-frame-navigate');
    window.webContents.removeAllListeners('will-attach-webview');
    window.webContents.removeAllListeners('render-process-gone');
    window.webContents.removeAllListeners('console-message');
    window.removeAllListeners('unresponsive');
    window.removeAllListeners('closed');
    if (!window.isDestroyed()) window.destroy();
  } catch {
    // Electron may already have torn down webContents after a crash or close.
  }
}

class PreviewRenderer implements VisualPreviewService {
  private active = 0;
  private readonly waiters: Array<{ granted: boolean; grant: () => void }> = [];
  private readonly runs = new Set<Run>();
  constructor() {
    app.on('before-quit', (): void => this.stopAll());
  }

  private stopAll(): void {
    this.runs.forEach((run) => run.stop('error'));
    previewWindows.forEach((window) => window.destroy());
  }

  private async acquire(run: Run): Promise<void> {
    checkRun(run);
    if (this.active < VISUAL_PREVIEW_LIMITS.maxConcurrent) {
      this.active++;
      run.queuedMs = Date.now() - run.started;
      return;
    }
    if (this.waiters.length >= VISUAL_PREVIEW_LIMITS.maxWaiters)
      throw new RunStopped('busy');
    const waiter = { granted: false, grant: (): void => undefined };
    const available = new Promise<void>((resolve) => {
      waiter.grant = (): void => {
        waiter.granted = true;
        resolve();
      };
    });
    this.waiters.push(waiter);
    try {
      await step(run, available);
    } catch (error) {
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
      // A slot handed over as this run stopped goes to the next in line.
      if (waiter.granted) this.release();
      throw error;
    }
    run.queuedMs = Date.now() - run.started;
  }

  /**
   * A freed slot passes straight to the waiter and stays counted, so a caller
   * arriving before the waiter resumes cannot take it too.
   */
  private release(): void {
    const next = this.waiters.shift();
    if (next) next.grant();
    else this.active--;
  }

  private createWindow(
    run: Run,
    width: number,
    height: number,
  ): {
    window: BrowserWindow;
    blocked: VisualPreviewBlockedRequests;
    unregister: () => void;
    diagnostics: VisualDiagnostic[];
    violations: VisualCspViolation[];
    omitted: { console: number; cspViolations: number };
  } {
    const policy = getVisualPreviewSessionPolicy();
    const window = new BrowserWindow({
      width,
      height,
      show: false,
      paintWhenInitiallyHidden: true,
      enableLargerThanScreen: true,
      useContentSize: true,
      skipTaskbar: true,
      focusable: false,
      frame: false,
      webPreferences: {
        session: policy.native,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        webviewTag: false,
        spellcheck: false,
        safeDialogs: true,
        backgroundThrottling: false,
      },
    });
    run.window = window;
    previewWindows.add(window);
    const blocked: VisualPreviewBlockedRequests = { urls: [], omitted: 0 };
    const unregister = policy.register(window.webContents.id, blocked);
    const diagnostics: VisualDiagnostic[] = [];
    const violations: VisualCspViolation[] = [];
    const omitted = { console: 0, cspViolations: 0 };
    window.webContents.setAudioMuted(true);
    pinZoom(window);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-frame-navigate', (event) => {
      if (
        (event.url !== 'about:srcdoc' &&
          !isAllowedMainWindowFrameNavigation(event, () => false)) ||
        event.isMainFrame
      )
        event.preventDefault();
    });
    window.webContents.on('will-attach-webview', (event) =>
      event.preventDefault(),
    );
    window.webContents.on('render-process-gone', () => run.stop('error'));
    window.on('unresponsive', () => run.stop('error'));
    window.on('closed', () => run.stop('error'));
    let lastMessage = '';
    window.webContents.on('console-message', (details) => {
      // Electron attributes console API calls in the visual to the relay
      // frame and Chromium's own messages (CSP, uncaught errors) to the agent
      // frame. The shell and anything else in the window are not page output.
      // The slot, not only a live document: a blocked navigation is reported
      // after the agent frame has left about:srcdoc.
      let agent: WebFrameMain | null;
      try {
        agent = findAgentSlot(window);
      } catch {
        // A disposed frame throws on access; a throw here would be uncaught.
        return;
      }
      const source = details.frame?.frameTreeNodeId;
      if (
        !agent ||
        source === undefined ||
        (source !== agent.frameTreeNodeId &&
          source !== agent.parent?.frameTreeNodeId)
      )
        return;
      // The relay's CSP and the document's own both report a violation, so
      // Chromium logs it twice in a row.
      const key = `${details.level}\u0000${String(details.lineNumber)}\u0000${details.message}`;
      if (key === lastMessage) return;
      lastMessage = key;
      const diagnostic: VisualDiagnostic = {
        level: details.level === 'debug' ? 'log' : details.level,
        message: boundedMessage(details.message),
        line: details.lineNumber,
        source: boundedMessage(details.sourceId),
      };
      if (diagnostics.length < VISUAL_PREVIEW_LIMITS.diagnostics.console)
        diagnostics.push(diagnostic);
      else omitted.console++;
      const csp = parseCsp(details.message);
      if (csp) {
        if (violations.length < VISUAL_PREVIEW_LIMITS.diagnostics.cspViolations)
          violations.push(csp);
        else omitted.cspViolations++;
      }
    });
    return { window, blocked, unregister, diagnostics, violations, omitted };
  }

  async preview(request: VisualPreviewRequest): Promise<VisualPreviewResult> {
    const run = createRun(VISUAL_PREVIEW_LIMITS.deadlineMs, request.signal);
    this.runs.add(run);
    let acquired = false;
    let instance: ReturnType<PreviewRenderer['createWindow']> | undefined;
    let loadMs = 0,
      settleMs = 0,
      captureMs = 0;
    let contentHeight = 0,
      capturedHeight = 0;
    try {
      await this.acquire(run);
      acquired = true;
      const width = clamp(
        request.width,
        VISUAL_PREVIEW_LIMITS.minWidth,
        VISUAL_PREVIEW_LIMITS.maxWidth,
      );
      instance = this.createWindow(
        run,
        width,
        VISUAL_PREVIEW_LIMITS.captureMaxHeight,
      );
      const { window } = instance;
      const loadStart = Date.now();
      await loadDocument(
        run,
        window,
        request.prepared.html,
        width,
        VISUAL_PREVIEW_LIMITS.captureMaxHeight,
        request.appearance,
      );
      loadMs = Date.now() - loadStart;
      const settleStart = Date.now();
      const agent = await settle(run, window);
      settleMs += Date.now() - settleStart;
      contentHeight = await measureHeight(run, window, agent);
      capturedHeight = clamp(
        contentHeight,
        80,
        VISUAL_PREVIEW_LIMITS.captureMaxHeight,
      );
      await step(
        run,
        window.webContents.executeJavaScript(
          `document.querySelector('iframe').style.height='${capturedHeight}px';`,
          false,
        ),
      );
      window.setContentSize(width, capturedHeight);
      const secondSettle = Date.now();
      await settle(run, window);
      settleMs += Date.now() - secondSettle;
      // A provider with no image budget gets diagnostics only, so the page
      // is not captured for it.
      let encoded: ReturnType<typeof encodeForBudget> = {
        image: null,
        reason: IMAGE_OMITTED_BY_BUDGET,
      };
      if (request.imageBudgetBytes > 0) {
        const captureStart = Date.now();
        const captured = await step(
          run,
          window.webContents.capturePage({
            x: 0,
            y: 0,
            width,
            height: capturedHeight,
          }),
        );
        captureMs = Date.now() - captureStart;
        checkRun(run);
        encoded = encodeForBudget(
          captured,
          request.imageBudgetBytes,
          width,
          capturedHeight,
        );
      }
      checkRun(run);
      return {
        status: 'ok',
        image: encoded.image,
        imageOmittedReason: encoded.reason,
        contentHeight,
        capturedHeight,
        console: instance.diagnostics,
        cspViolations: instance.violations,
        blockedRequests: instance.blocked.urls,
        omitted: {
          console: instance.omitted.console,
          cspViolations: instance.omitted.cspViolations,
          blockedRequests: instance.blocked.omitted,
        },
        timing: {
          queuedMs: run.queuedMs,
          loadMs,
          settleMs,
          captureMs,
          totalMs: Date.now() - run.started,
        },
      };
    } catch (error) {
      const status = request.signal?.aborted
        ? 'aborted'
        : error instanceof RunStopped
          ? error.status
          : 'error';
      return {
        ...emptyPreview(status),
        contentHeight,
        capturedHeight,
        console: instance?.diagnostics ?? [],
        cspViolations: instance?.violations ?? [],
        blockedRequests: instance?.blocked.urls ?? [],
        omitted: {
          console: instance?.omitted.console ?? 0,
          cspViolations: instance?.omitted.cspViolations ?? 0,
          blockedRequests: instance?.blocked.omitted ?? 0,
        },
        timing: {
          queuedMs: run.queuedMs,
          loadMs,
          settleMs,
          captureMs,
          totalMs: Date.now() - run.started,
        },
      };
    } finally {
      run.ended = true;
      run.dispose();
      instance?.unregister();
      if (instance) destroyRunWindow(instance.window);
      if (acquired) this.release();
      this.runs.delete(run);
    }
  }

  async measure(request: VisualMeasureRequest): Promise<VisualMeasureResult> {
    const run = createRun(request.deadlineMs, request.signal);
    this.runs.add(run);
    let acquired = false;
    let instance: ReturnType<PreviewRenderer['createWindow']> | undefined;
    try {
      await this.acquire(run);
      acquired = true;
      const height = clamp(
        request.maxHeight,
        80,
        VISUAL_PREVIEW_LIMITS.captureMaxHeight,
      );
      const rawFirstWidth = request.widths[0];
      if (
        rawFirstWidth === undefined ||
        !Number.isFinite(rawFirstWidth) ||
        request.widths.length > 32
      )
        throw new Error('Invalid widths');
      const firstWidth = clamp(
        rawFirstWidth,
        VISUAL_PREVIEW_LIMITS.minWidth,
        VISUAL_PREVIEW_LIMITS.maxWidth,
      );
      instance = this.createWindow(run, firstWidth, height);
      const { window } = instance;
      await loadDocument(
        run,
        window,
        request.prepared.html,
        firstWidth,
        height,
        request.appearance,
      );
      const heights: Array<readonly [number, number]> = [];
      for (const rawWidth of request.widths) {
        const width = clamp(
          rawWidth,
          VISUAL_PREVIEW_LIMITS.minWidth,
          VISUAL_PREVIEW_LIMITS.maxWidth,
        );
        pinZoom(window);
        window.setContentSize(width, height);
        await step(
          run,
          window.webContents.executeJavaScript(
            `document.querySelector('iframe').style.width='${width}px';document.querySelector('iframe').style.height='${height}px';`,
            false,
          ),
        );
        const frame = await settle(run, window);
        const measured = await measureHeight(run, window, frame);
        heights.push([width, clamp(measured, 80, height)]);
      }
      return { status: 'ok', heights };
    } catch (error) {
      return {
        status: request.signal?.aborted
          ? 'aborted'
          : error instanceof RunStopped
            ? error.status
            : 'error',
        heights: [],
      };
    } finally {
      run.ended = true;
      run.dispose();
      instance?.unregister();
      if (instance) destroyRunWindow(instance.window);
      if (acquired) this.release();
      this.runs.delete(run);
    }
  }
}

let service: VisualPreviewService | undefined;
export function getVisualPreviewService(): VisualPreviewService {
  if (!service) service = new PreviewRenderer();
  return service;
}
