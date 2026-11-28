import {
  VISUAL_MAX_HEIGHT,
  VISUAL_MIN_HEIGHT,
} from '@canopy/agent-transcript/lib/visual-ref';

import {
  AGENT_VISUAL_FONT_FACES_PROPERTY,
  AGENT_VISUAL_FONT_FACES_SOURCE,
  AGENT_VISUAL_FONTS_METHOD,
} from './agent-visual-fonts';
import { stripHttpEquivMetaTags } from './strip-http-equiv-meta';

export const AGENT_VISUAL_CDN_HOSTS = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
] as const;

/**
 * Build the visual's content security policy. With `remoteAssets` false (a
 * host whose `agentVisualRemoteAssets` capability is off) no CDN host is
 * allowed: CDN scripts and styles are dropped, and fonts come only from the
 * faces the host posts or the bundled fallbacks.
 */
export function buildAgentVisualCsp(remoteAssets: boolean): string {
  const cdnHosts = remoteAssets ? ` ${AGENT_VISUAL_CDN_HOSTS.join(' ')}` : '';
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval'${cdnHosts}`,
    `style-src 'unsafe-inline'${cdnHosts}`,
    `font-src data:${cdnHosts}`,
    'img-src data: blob:',
    'media-src data: blob:',
    'worker-src blob:',
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export const AGENT_VISUAL_CSP = buildAgentVisualCsp(true);

/** Options shared by the documents that carry the visual's policy. */
export interface AgentVisualDocumentOptions {
  /**
   * Whether the visual may load CDN scripts, styles and fonts. Defaults to
   * true; hosts pass `allowsAgentVisualRemoteAssets(capabilities)`.
   */
  remoteAssets?: boolean;
}

export const AGENT_VISUAL_STRIPPED_HTTP_EQUIV: ReadonlySet<string> = new Set([
  'refresh',
  'content-security-policy',
  'x-dns-prefetch-control',
  'set-cookie',
]);

export const AGENT_VISUAL_FRAME_SANDBOX = 'allow-scripts';
export const AGENT_VISUAL_FRAME_ALLOW =
  "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'";

export const AGENT_VISUAL_THEME_VARIABLES = [
  '--bg-base',
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  '--bg-subtle',
  '--bg-muted',
  '--bg-accent',
  '--bg-accent-muted',
  '--bg-positive',
  '--bg-positive-muted',
  '--bg-attention',
  '--bg-attention-muted',
  '--bg-destructive',
  '--bg-destructive-muted',
  '--fg-primary',
  '--fg-secondary',
  '--fg-tertiary',
  '--fg-quaternary',
  '--fg-emphasis',
  '--fg-accent',
  '--fg-positive',
  '--fg-attention',
  '--fg-destructive',
  '--line-base',
  '--line-primary',
  '--line-secondary',
  '--line-accent',
  '--line-focus',
  '--categorical-1',
  '--categorical-2',
  '--categorical-3',
  '--categorical-4',
  '--categorical-5',
  '--categorical-6',
  '--chart-categorical-1',
  '--chart-categorical-2',
  '--chart-categorical-3',
  '--chart-categorical-4',
  '--chart-categorical-5',
  '--chart-categorical-6',
  '--font-sans',
  '--font-mono',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
] as const;

export type AgentVisualTheme = {
  appearance: 'light' | 'dark';
  variables: Readonly<Record<string, string>>;
};

export const AGENT_VISUAL_HOST_CONTEXT_CHANGED_METHOD =
  'ui/notifications/host-context-changed';
export const AGENT_VISUAL_SIZE_CHANGED_METHOD = 'ui/notifications/size-changed';
export const AGENT_VISUAL_OPEN_LINK_METHOD = 'ui/open-link';
export const AGENT_VISUAL_HELLO_METHOD = 'canopy/visual/hello';
export const AGENT_VISUAL_PING_METHOD = 'canopy/visual/ping';
export const AGENT_VISUAL_PONG_METHOD = 'canopy/visual/pong';
export const AGENT_VISUAL_STATUS_METHOD = 'canopy/visual/status';
/**
 * The host hands the agent document to a relay that was served as a shell
 * (`buildAgentVisualShellDocument`) and asked for it with the
 * `awaiting-document` status. A relay built around its document inline never
 * takes one.
 */
export const AGENT_VISUAL_LOAD_METHOD = 'canopy/visual/load';
/**
 * The longest agent document a shell takes: the 4 MiB a visual may reach once
 * its images are inlined, with room for the bridge and theme around it. A
 * shared artifact may be 8 MiB of bytes (`MAX_SHARED_ARTIFACT_BYTES`), which
 * decodes to at most as many characters, and the builder wraps it in about
 * 10 KB, so the cap carries a fixed 64 KiB of headroom over 8 MiB (CAN-8017).
 * A size bound, not a security boundary.
 */
export const AGENT_VISUAL_LOAD_MAX_CHARS = 8 * 1024 * 1024 + 64 * 1024;
/**
 * The host asks the relay whether focus entered the visual by the user's own
 * press inside it, and the relay answers from its user activation. A gesture
 * in the agent frame activates its ancestors, the relay among them; a gesture
 * in the host does not reach the relay, and no script can fake one.
 *
 * A key typed into a field the page focused by itself activates the frame
 * too, so activation alone is not enough: the relay answers `inside` only
 * when it saw the activation before it saw focus enter, `none` when it saw
 * focus first or no activation at all, and `unclear` when it first saw both
 * in the same sample, as when the visual's thread was busy.
 */
export const AGENT_VISUAL_GESTURE_METHOD = 'canopy/visual/gesture';
/**
 * Tells the relay to sample its focus and activation, which it does only
 * while the pointer has the visual open, so that it can order the two.
 */
export const AGENT_VISUAL_GESTURE_WATCH_METHOD = 'canopy/visual/gesture-watch';
/** How often a watching relay samples focus and activation. */
export const AGENT_VISUAL_GESTURE_SAMPLE_MS = 5;
/**
 * A press and the focus it moves arrive in one task when the visual and its
 * relay share a renderer, so the relay first sees them in the same sample.
 * That counts as a press only when the sample ran on time: a later one means
 * the thread was held, and a key typed meanwhile cannot be told apart.
 */
export const AGENT_VISUAL_GESTURE_PROMPT_SAMPLE_MS = 40;

export type AgentVisualGesture = 'inside' | 'none' | 'unclear';

/**
 * The relay pings the agent frame at this interval and reports `alive` for
 * each answer. Both frames share one renderer process, so a busy agent frame
 * stalls the relay too: the host must treat missing `alive` reports as
 * unresponsive instead of waiting for the relay to say so.
 */
export const AGENT_VISUAL_HEARTBEAT_INTERVAL_MS = 3000;
export const AGENT_VISUAL_HEARTBEAT_MISSES = 3;

const THEME_VARIABLE_SET: ReadonlySet<string> = new Set(
  AGENT_VISUAL_THEME_VARIABLES,
);

const FORBIDDEN_THEME_CHARACTERS = ['<', '>', '{', '}', ';', '\\', '\r', '\n'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isThemeValueSafe(value: string): boolean {
  if (value.length > 512) return false;
  if (
    FORBIDDEN_THEME_CHARACTERS.some((character) => value.includes(character))
  ) {
    return false;
  }
  const lowerValue = value.toLowerCase();
  return (
    !lowerValue.includes('/*') &&
    !lowerValue.includes('*/') &&
    !lowerValue.includes('url(')
  );
}

/** Keep only bounded values for the CSS variables exposed to agent visuals. */
export function sanitizeAgentVisualTheme(input: unknown): AgentVisualTheme {
  const emptyTheme: AgentVisualTheme = { appearance: 'light', variables: {} };
  try {
    if (!isRecord(input)) return emptyTheme;
    const appearance = input.appearance === 'dark' ? 'dark' : 'light';
    const rawVariables = input.variables;
    if (!isRecord(rawVariables)) return { appearance, variables: {} };

    const variables: Record<string, string> = {};
    for (const [name, candidate] of Object.entries(rawVariables)) {
      if (!THEME_VARIABLE_SET.has(name) || typeof candidate !== 'string')
        continue;
      if (!isThemeValueSafe(candidate)) continue;
      const value = candidate.trim();
      if (value.length > 0) variables[name] = value;
    }
    return { appearance, variables };
  } catch {
    return emptyTheme;
  }
}

function buildThemeStyles(theme: AgentVisualTheme): string {
  const variables = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join('');
  return `:root{${variables}color-scheme:${theme.appearance}}`;
}

function stripLeadingDoctype(content: string): string {
  return content.replace(/^\s*<!doctype[^>]*>/i, '');
}

function cspMeta(options: AgentVisualDocumentOptions | undefined): string {
  const csp = buildAgentVisualCsp(options?.remoteAssets !== false);
  return `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
}
const DNS_PREFETCH_META =
  '<meta http-equiv="x-dns-prefetch-control" content="off">';
/** Runs first in the agent frame: theme, size reports, links, liveness. */

/**
 * The bridge's height rule, as source. The preview service evaluates exactly
 * this in the agent frame, so a measured hint matches what the frame reports.
 */
export const AGENT_VISUAL_DOCUMENT_HEIGHT_SOURCE = `function documentHeight(){
    const root = document.documentElement;
    if (!root) return 0;
    // scrollHeight never drops below the frame's own height, so it counts only
    // when the document overflows; the root box measures shorter content.
    const overflow = root.scrollHeight > root.clientHeight ? root.scrollHeight : 0;
    return Math.ceil(Math.max(root.getBoundingClientRect().height, overflow));
  }`;

export const AGENT_VISUAL_BRIDGE_SCRIPT = `
(function(){
  'use strict';
  const METHODS = ${JSON.stringify({
    hostContextChanged: AGENT_VISUAL_HOST_CONTEXT_CHANGED_METHOD,
    sizeChanged: AGENT_VISUAL_SIZE_CHANGED_METHOD,
    openLink: AGENT_VISUAL_OPEN_LINK_METHOD,
    hello: AGENT_VISUAL_HELLO_METHOD,
    ping: AGENT_VISUAL_PING_METHOD,
    pong: AGENT_VISUAL_PONG_METHOD,
    fonts: AGENT_VISUAL_FONTS_METHOD,
  })};
  const THEME_VARIABLES = ${JSON.stringify(AGENT_VISUAL_THEME_VARIABLES)};
  const THEME_VARIABLE_SET = new Set(THEME_VARIABLES);
  const installedFonts = new Set();
  let lastHeight = null;
  let heightFrameQueued = false;

  function isRecord(value){
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function post(method, params){
    const message = {jsonrpc:'2.0', method:method};
    if (params !== undefined) message.params = params;
    window.parent.postMessage(message, '*');
  }

  ${AGENT_VISUAL_DOCUMENT_HEIGHT_SOURCE}
  ${AGENT_VISUAL_FONT_FACES_SOURCE}

  function reportHeight(){
    const height = documentHeight();
    if (height <= 0 || height === lastHeight) return;
    lastHeight = height;
    post(METHODS.sizeChanged, {height:height});
  }

  function scheduleHeight(){
    if (heightFrameQueued) return;
    heightFrameQueued = true;
    requestAnimationFrame(function(){
      heightFrameQueued = false;
      reportHeight();
    });
  }

  function observeBody(){
    if (!observer || !document.body || observedBody === document.body) return;
    observedBody = document.body;
    observer.observe(observedBody);
    scheduleHeight();
  }

  function decodeFragment(fragment){
    try { return decodeURIComponent(fragment); }
    catch { return fragment; }
  }

  function scrollToFragment(rawHref){
    const fragment = decodeFragment(rawHref.slice(1));
    if (fragment.length === 0) {
      window.scrollTo(0, 0);
      return;
    }
    const target = document.getElementById(fragment);
    if (target) {
      target.scrollIntoView();
      return;
    }
    const namedAnchors = document.querySelectorAll('a[name]');
    for (let index = 0; index < namedAnchors.length; index += 1) {
      const anchor = namedAnchors[index];
      if (anchor.getAttribute('name') === fragment) {
        anchor.scrollIntoView();
        return;
      }
    }
  }

  function anchorForTarget(target){
    let element = target;
    if (element && element.nodeType !== 1) element = element.parentElement;
    if (!element || typeof element.closest !== 'function') return null;
    return element.closest('a');
  }

  function handleClick(event){
    if (event.type === 'auxclick' && event.button !== 1) return;
    if (!event.isTrusted) return;
    const anchor = anchorForTarget(event.target);
    if (!anchor) return;
    let rawHref = anchor.getAttribute('href');
    if (rawHref === null) rawHref = anchor.getAttribute('xlink:href');
    if (rawHref === null) return;
    event.preventDefault();
    if (rawHref.startsWith('#')) {
      scrollToFragment(rawHref);
      return;
    }
    try {
      const resolved = new URL(rawHref, document.baseURI);
      const absolute = new URL(rawHref);
      if (absolute.protocol === 'http:' || absolute.protocol === 'https:') {
        post(METHODS.openLink, {url:resolved.href});
      }
    } catch {}
  }

  function applyTheme(theme){
    if (!isRecord(theme) || !isRecord(theme.variables)) return;
    const root = document.documentElement;
    if (!root) return;
    for (const name of THEME_VARIABLES) {
      const value = theme.variables[name];
      if (THEME_VARIABLE_SET.has(name) && typeof value === 'string') {
        root.style.setProperty(name, value);
      }
    }
    if (theme.appearance === 'light' || theme.appearance === 'dark') {
      root.style.colorScheme = theme.appearance;
    }
  }

  // The app's own font faces, registered under the family names the theme
  // variables use, so var(--font-sans) resolves here as it does in the app.
  function installFonts(value){
    if (typeof FontFace !== 'function' || !document.fonts) return;
    const faces = cleanFontFaces(value);
    const pending = [];
    for (let index = 0; index < faces.length; index += 1) {
      const face = faces[index];
      const key = [face.family, face.style, face.weight, face.stretch, face.unicodeRange].join('|');
      if (installedFonts.has(key)) continue;
      installedFonts.add(key);
      try {
        const loaded = new FontFace(JSON.stringify(face.family), face.data, {
          style: face.style,
          weight: face.weight,
          stretch: face.stretch,
          unicodeRange: face.unicodeRange,
        });
        document.fonts.add(loaded);
        pending.push(loaded.loaded.then(function(){}, function(){}));
      } catch {}
    }
    if (pending.length === 0) return;
    Promise.all(pending).then(function(){
      // HTML and SVG text take the faces by themselves; text already drawn on
      // a canvas does not. A page that redraws on a theme change watches the
      // root's style, so mark the arrival there.
      const root = document.documentElement;
      if (root) root.style.setProperty(${JSON.stringify(AGENT_VISUAL_FONT_FACES_PROPERTY)}, String(installedFonts.size));
      scheduleHeight();
    });
  }

  function handleMessage(event){
    if (event.source !== window.parent || !isRecord(event.data) || event.data.jsonrpc !== '2.0') return;
    if (event.data.method === METHODS.hostContextChanged) {
      const params = event.data.params;
      if (isRecord(params)) applyTheme(params.theme);
      return;
    }
    if (event.data.method === METHODS.fonts) {
      const params = event.data.params;
      if (isRecord(params)) installFonts(params.faces);
      return;
    }
    if (event.data.method === METHODS.ping) {
      const params = event.data.params;
      if (isRecord(params) && typeof params.id === 'number' && Number.isFinite(params.id)) {
        post(METHODS.pong, {id:params.id});
      }
    }
  }

  let observer = null;
  let observedBody = null;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(scheduleHeight);
    if (document.documentElement) observer.observe(document.documentElement);
    observeBody();
  }
  document.addEventListener('DOMContentLoaded', observeBody, {once:true});
  document.addEventListener('DOMContentLoaded', scheduleHeight);
  window.addEventListener('load', scheduleHeight);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('auxclick', handleClick, true);
  window.addEventListener('message', handleMessage);
  post(METHODS.hello);
})();
`;

/** Runs in the wrapper frame and forwards validated messages both ways. */
export const AGENT_VISUAL_RELAY_SCRIPT = `
(function(){
  'use strict';
  const METHODS = ${JSON.stringify({
    hostContextChanged: AGENT_VISUAL_HOST_CONTEXT_CHANGED_METHOD,
    sizeChanged: AGENT_VISUAL_SIZE_CHANGED_METHOD,
    openLink: AGENT_VISUAL_OPEN_LINK_METHOD,
    hello: AGENT_VISUAL_HELLO_METHOD,
    ping: AGENT_VISUAL_PING_METHOD,
    pong: AGENT_VISUAL_PONG_METHOD,
    status: AGENT_VISUAL_STATUS_METHOD,
    fonts: AGENT_VISUAL_FONTS_METHOD,
    gesture: AGENT_VISUAL_GESTURE_METHOD,
    gestureWatch: AGENT_VISUAL_GESTURE_WATCH_METHOD,
    load: AGENT_VISUAL_LOAD_METHOD,
  })};
  const LOAD_MAX_CHARS = ${JSON.stringify(AGENT_VISUAL_LOAD_MAX_CHARS)};
  const FRAME_SANDBOX = ${JSON.stringify(AGENT_VISUAL_FRAME_SANDBOX)};
  const FRAME_ALLOW = ${JSON.stringify(AGENT_VISUAL_FRAME_ALLOW)};
  const GESTURE_SAMPLE_MS = ${JSON.stringify(AGENT_VISUAL_GESTURE_SAMPLE_MS)};
  const GESTURE_PROMPT_SAMPLE_MS = ${JSON.stringify(AGENT_VISUAL_GESTURE_PROMPT_SAMPLE_MS)};
  const THEME_VARIABLES = ${JSON.stringify(AGENT_VISUAL_THEME_VARIABLES)};
  const THEME_VARIABLE_SET = new Set(THEME_VARIABLES);
  const HEARTBEAT_INTERVAL_MS = ${JSON.stringify(AGENT_VISUAL_HEARTBEAT_INTERVAL_MS)};
  const HEARTBEAT_MISSES = ${JSON.stringify(AGENT_VISUAL_HEARTBEAT_MISSES)};
  // Built around its agent frame, or served as a shell that takes the agent
  // document from its host once.
  let agentFrame = document.querySelector('iframe');
  let nextPingId = 0;
  let currentPingId = 0;
  let awaitingPong = false;
  let missedPings = 0;
  let reportedUnresponsive = false;
  let stopped = false;
  let hasReceivedHello = false;
  let loadCount = 0;
  let helloSinceLastLoad = false;
  let navigationTimer = null;
  let heartbeatTimer = null;

  function isRecord(value){
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function post(method, params){
    const message = {jsonrpc:'2.0', method:method};
    if (params !== undefined) message.params = params;
    window.parent.postMessage(message, '*');
  }

  function postToAgent(method, params){
    if (!agentFrame || !agentFrame.contentWindow) return;
    const message = {jsonrpc:'2.0', method:method};
    if (params !== undefined) message.params = params;
    agentFrame.contentWindow.postMessage(message, '*');
  }

  function validEnvelope(data, method){
    return isRecord(data) && data.jsonrpc === '2.0' && data.method === method;
  }

  ${AGENT_VISUAL_FONT_FACES_SOURCE}

  function cleanTheme(value){
    if (!isRecord(value) || (value.appearance !== 'light' && value.appearance !== 'dark') || !isRecord(value.variables)) return null;
    const variables = {};
    for (const name of THEME_VARIABLES) {
      const candidate = value.variables[name];
      if (THEME_VARIABLE_SET.has(name) && typeof candidate === 'string') variables[name] = candidate;
    }
    return {appearance:value.appearance, variables:variables};
  }

  function validUrl(value){
    if (typeof value !== 'string' || value.length > 8192) return null;
    try {
      const url = new URL(value);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
      return url.href;
    } catch { return null; }
  }

  function sendStatus(state){
    post(METHODS.status, {state:state});
  }

  // Focus and activation, in the order this frame first saw them. A press
  // inside the agent frame activates it before focus moves there; a key typed
  // into a field the page focused by itself comes after.
  let gestureTimer = null;
  let sampleCount = 0;
  let lastSampleAt = null;
  let sawFocus = false;
  let focusSample = 0;
  let focusSampleGap = Infinity;
  let sawActive = false;
  let activeSample = 0;

  function resetGestureSamples(){
    sampleCount = 0;
    lastSampleAt = null;
    sawFocus = false;
    sawActive = false;
  }

  function sampleGesture(){
    const now = Date.now();
    const gap = lastSampleAt === null ? Infinity : now - lastSampleAt;
    lastSampleAt = now;
    sampleCount += 1;
    const focused = !!agentFrame && document.activeElement === agentFrame;
    const active = !!(navigator.userActivation && navigator.userActivation.isActive);
    if (focused && !sawFocus) {
      focusSample = sampleCount;
      focusSampleGap = gap;
    }
    sawFocus = focused;
    if (active && !sawActive) activeSample = sampleCount;
    sawActive = active;
  }

  function watchGestures(watching){
    if (watching && gestureTimer === null) {
      resetGestureSamples();
      sampleGesture();
      gestureTimer = setInterval(sampleGesture, GESTURE_SAMPLE_MS);
    } else if (!watching && gestureTimer !== null) {
      clearInterval(gestureTimer);
      gestureTimer = null;
    }
  }

  function gestureState(){
    if (gestureTimer === null) resetGestureSamples();
    sampleGesture();
    if (!sawActive) return 'none';
    if (!sawFocus) return 'unclear';
    // An activation already in effect when watching began came from an
    // earlier press; it says nothing about how focus got here this time.
    if (gestureTimer !== null && activeSample === 1) return 'unclear';
    if (activeSample === focusSample) {
      // Seen together: one task, as a press is, when the sample came on time.
      return gestureTimer !== null && focusSampleGap <= GESTURE_PROMPT_SAMPLE_MS ? 'inside' : 'unclear';
    }
    return activeSample < focusSample ? 'inside' : 'none';
  }

  function watchAgentFrame(){
    agentFrame.addEventListener('load', handleAgentLoad);
    sendPing();
    heartbeatTimer = setInterval(sendPing, HEARTBEAT_INTERVAL_MS);
  }

  // The frame gets its sandbox before its document, and both before it is
  // attached, so the agent document never loads outside the sandbox.
  function loadDocument(params){
    if (agentFrame || !isRecord(params)) return;
    const srcdoc = params.srcdoc;
    const title = params.title;
    const appearance = params.appearance;
    if (typeof srcdoc !== 'string' || srcdoc.length === 0 || srcdoc.length > LOAD_MAX_CHARS) return;
    if (typeof title !== 'string' || title.length > 512) return;
    if (appearance !== 'light' && appearance !== 'dark') return;
    document.documentElement.style.colorScheme = appearance;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', FRAME_SANDBOX);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', FRAME_ALLOW);
    frame.setAttribute('title', title);
    frame.setAttribute('srcdoc', srcdoc);
    agentFrame = frame;
    document.body.appendChild(frame);
    watchAgentFrame();
  }

  function handleHostMessage(data){
    if (validEnvelope(data, METHODS.load)) {
      loadDocument(data.params);
      return;
    }
    if (validEnvelope(data, METHODS.gestureWatch) && isRecord(data.params)) {
      if (typeof data.params.watching === 'boolean') watchGestures(data.params.watching);
      return;
    }
    if (validEnvelope(data, METHODS.gesture) && isRecord(data.params)) {
      const id = data.params.id;
      // Answered here and never passed on: this frame's activation comes only
      // from a real press inside the agent frame, which the agent cannot fake.
      if (typeof id === 'number' && Number.isFinite(id)) {
        post(METHODS.gesture, {id:id, gesture:gestureState()});
      }
      return;
    }
    if (validEnvelope(data, METHODS.fonts) && isRecord(data.params)) {
      const faces = cleanFontFaces(data.params.faces);
      if (faces.length > 0) postToAgent(METHODS.fonts, {faces:faces});
      return;
    }
    if (!validEnvelope(data, METHODS.hostContextChanged) || !isRecord(data.params)) return;
    const theme = cleanTheme(data.params.theme);
    if (!theme) return;
    document.documentElement.style.colorScheme = theme.appearance;
    postToAgent(METHODS.hostContextChanged, {theme:theme});
  }

  function handleChildMessage(data){
    if (!isRecord(data) || data.jsonrpc !== '2.0' || typeof data.method !== 'string') return;
    if (validEnvelope(data, METHODS.sizeChanged) && isRecord(data.params)) {
      const height = data.params.height;
      if (typeof height === 'number' && Number.isFinite(height) && height > 0 && height <= 1000000) {
        post(METHODS.sizeChanged, {height:height});
      }
      return;
    }
    if (validEnvelope(data, METHODS.openLink) && isRecord(data.params)) {
      const url = validUrl(data.params.url);
      // A host activation gesture does not activate this cross-origin relay.
      // Only an actual gesture inside the agent frame propagates here.
      if (url && navigator.userActivation && navigator.userActivation.isActive) post(METHODS.openLink, {url:url});
      return;
    }
    if (validEnvelope(data, METHODS.hello)) {
      helloSinceLastLoad = true;
      if (navigationTimer !== null) {
        clearTimeout(navigationTimer);
        navigationTimer = null;
      }
      if (!hasReceivedHello) {
        hasReceivedHello = true;
        sendStatus('ready');
      }
      return;
    }
    if (validEnvelope(data, METHODS.pong) && isRecord(data.params)) {
      const id = data.params.id;
      if (typeof id !== 'number' || !Number.isFinite(id) || id !== currentPingId || !awaitingPong) return;
      awaitingPong = false;
      missedPings = 0;
      reportedUnresponsive = false;
      sendStatus('alive');
    }
  }

  function handleMessage(event){
    if (event.source === window.parent) {
      handleHostMessage(event.data);
      return;
    }
    if (agentFrame && event.source === agentFrame.contentWindow) handleChildMessage(event.data);
  }

  function sendPing(){
    if (stopped) return;
    if (awaitingPong) {
      missedPings += 1;
      if (missedPings >= HEARTBEAT_MISSES && !reportedUnresponsive) {
        reportedUnresponsive = true;
        sendStatus('unresponsive');
      }
    }
    nextPingId += 1;
    currentPingId = nextPingId;
    awaitingPong = true;
    postToAgent(METHODS.ping, {id:currentPingId});
  }

  function handleAgentLoad(){
    loadCount += 1;
    if (loadCount < 2) {
      helloSinceLastLoad = false;
      return;
    }
    const receivedFreshHello = helloSinceLastLoad;
    helloSinceLastLoad = false;
    if (navigationTimer !== null) clearTimeout(navigationTimer);
    if (receivedFreshHello) return;
    navigationTimer = setTimeout(function(){
      navigationTimer = null;
      if (helloSinceLastLoad || stopped) return;
      stopped = true;
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      sendStatus('navigated');
    }, HEARTBEAT_INTERVAL_MS);
  }

  if (agentFrame) {
    window.addEventListener('message', handleMessage);
    watchAgentFrame();
    return;
  }
  // A shell opened outside a frame has no host to take a document from.
  if (window.parent === window) return;
  window.addEventListener('message', handleMessage);
  sendStatus('awaiting-document');
})();
`;

/** Build the sandboxed agent document with its policy and host bridge first. */
export function buildAgentVisualSrcDoc(
  document: string,
  theme: AgentVisualTheme,
  options?: AgentVisualDocumentOptions,
): string {
  const withoutBom = document.startsWith('\uFEFF')
    ? document.slice(1)
    : document;
  const stripped = stripHttpEquivMetaTags(
    withoutBom,
    AGENT_VISUAL_STRIPPED_HTTP_EQUIV,
  );
  const markup = stripLeadingDoctype(stripped);
  const sanitizedTheme = sanitizeAgentVisualTheme(theme);
  const themeStyle = `<style>${buildThemeStyles(sanitizedTheme)}</style>`;
  const baseStyle =
    '<style>html{background:var(--bg-base);color:var(--fg-primary);font:14px/1.5 var(--font-sans)}body{margin:0}html{scrollbar-width:none}html::-webkit-scrollbar{display:none}</style>';
  return `<!doctype html>\n${cspMeta(options)}\n${DNS_PREFETCH_META}\n<meta charset="utf-8">\n${themeStyle}\n${baseStyle}\n<script>${AGENT_VISUAL_BRIDGE_SCRIPT}</script>\n${markup}`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');
}

function escapeSrcDocAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Build the trusted relay document that contains exactly one agent frame. */
export function buildAgentVisualWrapperSrcDoc(
  agentSrcDoc: string,
  options: {
    title: string;
    appearance: 'light' | 'dark';
  } & AgentVisualDocumentOptions,
): string {
  const title = escapeHtmlAttribute(options.title);
  const srcdoc = escapeSrcDocAttribute(agentSrcDoc);
  const style = `<style>html,body{margin:0;height:100%;overflow:hidden}html{color-scheme:${options.appearance}}iframe{display:block;width:100%;height:100%;border:0}</style>`;
  return `<!doctype html>\n${cspMeta(options)}\n<meta charset="utf-8">\n${style}\n<iframe sandbox="${AGENT_VISUAL_FRAME_SANDBOX}" referrerpolicy="no-referrer" allow="${AGENT_VISUAL_FRAME_ALLOW}" title="${title}" srcdoc="${srcdoc}"></iframe>\n<script>${AGENT_VISUAL_RELAY_SCRIPT}</script>`;
}

const WRAPPER_FRAME_STYLE =
  'html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}';

/**
 * The relay with no agent frame yet, for a host whose own page policy would
 * otherwise apply to an inline frame. A `srcdoc` frame inherits the policy of
 * the page that holds it; a document the host serves does not. The host
 * serves this one with `buildAgentVisualShellHeaders`, frames it by URL, and
 * hands it the agent document when it asks (`AGENT_VISUAL_LOAD_METHOD`). It is
 * the same for every visual and holds nothing about any of them.
 */
export function buildAgentVisualShellDocument(): string {
  return `<!doctype html>\n${cspMeta(undefined)}\n<meta charset="utf-8">\n<style>${WRAPPER_FRAME_STYLE}</style>\n<body><script>${AGENT_VISUAL_RELAY_SCRIPT}</script>`;
}

/**
 * Response headers for the shell document. The policy is the visual's own,
 * as in the document's meta tag, with the two directives a meta tag cannot
 * carry: `sandbox`, so the document has an opaque origin even when it is
 * opened outside the sandboxed frame, and `frame-ancestors`, so only its own
 * origin can frame it.
 */
export function buildAgentVisualShellHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `${AGENT_VISUAL_CSP}; sandbox ${AGENT_VISUAL_FRAME_SANDBOX}; frame-ancestors 'self'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // The shell and the host that frames it speak one protocol version.
    'Cache-Control': 'no-store',
  };
}

/** Hand the agent document to a shell that asked for it. */
export function buildAgentVisualLoadMessage(input: {
  srcdoc: string;
  title: string;
  appearance: 'light' | 'dark';
}): {
  jsonrpc: '2.0';
  method: typeof AGENT_VISUAL_LOAD_METHOD;
  params: { srcdoc: string; title: string; appearance: 'light' | 'dark' };
} {
  return {
    jsonrpc: '2.0',
    method: AGENT_VISUAL_LOAD_METHOD,
    params: {
      srcdoc: input.srcdoc,
      title: input.title,
      appearance: input.appearance,
    },
  };
}

/** A downloadable document keeps agent markup in an opaque, sandboxed child. */
export function buildAgentVisualExportDocument(
  document: string,
  theme: AgentVisualTheme,
  title: string,
  options?: AgentVisualDocumentOptions,
): string {
  const safeTheme = sanitizeAgentVisualTheme(theme);
  const srcdoc = escapeSrcDocAttribute(
    buildAgentVisualSrcDoc(document, safeTheme, options),
  );
  const safeTitle = escapeHtmlAttribute(title);
  return `<!doctype html>\n${cspMeta(options)}\n<meta charset="utf-8">\n<title>${safeTitle}</title>\n<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}html{color-scheme:${safeTheme.appearance}}iframe{display:block;width:100%;height:100%;border:0}</style>\n<iframe sandbox="${AGENT_VISUAL_FRAME_SANDBOX}" referrerpolicy="no-referrer" allow="${AGENT_VISUAL_FRAME_ALLOW}" title="${safeTitle}" srcdoc="${srcdoc}"></iframe>`;
}

export type AgentVisualHostContextMessage = {
  jsonrpc: '2.0';
  method: typeof AGENT_VISUAL_HOST_CONTEXT_CHANGED_METHOD;
  params: { theme: AgentVisualTheme };
};

/** Create the theme message sent from the host to the wrapper frame. */
export function buildAgentVisualHostContextMessage(
  theme: AgentVisualTheme,
): AgentVisualHostContextMessage {
  return {
    jsonrpc: '2.0',
    method: AGENT_VISUAL_HOST_CONTEXT_CHANGED_METHOD,
    params: { theme: sanitizeAgentVisualTheme(theme) },
  };
}

/** Start or stop the relay's sampling of focus and activation. */
export function buildAgentVisualGestureWatchMessage(watching: boolean): {
  jsonrpc: '2.0';
  method: typeof AGENT_VISUAL_GESTURE_WATCH_METHOD;
  params: { watching: boolean };
} {
  return {
    jsonrpc: '2.0',
    method: AGENT_VISUAL_GESTURE_WATCH_METHOD,
    params: { watching },
  };
}

/** Ask the relay whether focus entered the visual by a press inside it. */
export function buildAgentVisualGestureRequest(id: number): {
  jsonrpc: '2.0';
  method: typeof AGENT_VISUAL_GESTURE_METHOD;
  params: { id: number };
} {
  return {
    jsonrpc: '2.0',
    method: AGENT_VISUAL_GESTURE_METHOD,
    params: { id },
  };
}

export type AgentVisualFrameMessage =
  | { kind: 'size-changed'; height: number }
  | { kind: 'open-link'; url: string }
  | { kind: 'gesture'; id: number; gesture: AgentVisualGesture }
  | {
      kind: 'status';
      state:
        | 'ready'
        | 'alive'
        | 'unresponsive'
        | 'navigated'
        // A shell with no agent document yet; the host answers with one.
        | 'awaiting-document';
    };

function parseSafeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

/** Validate one frame-originated protocol message without throwing. */
export function parseAgentVisualFrameMessage(
  data: unknown,
): AgentVisualFrameMessage | null {
  try {
    if (
      !isRecord(data) ||
      data.jsonrpc !== '2.0' ||
      typeof data.method !== 'string'
    ) {
      return null;
    }
    const params = data.params;
    if (!isRecord(params)) return null;
    if (data.method === AGENT_VISUAL_SIZE_CHANGED_METHOD) {
      const height = params.height;
      if (
        typeof height === 'number' &&
        Number.isFinite(height) &&
        height > 0 &&
        height <= 1_000_000
      ) {
        return { kind: 'size-changed', height };
      }
      return null;
    }
    if (data.method === AGENT_VISUAL_OPEN_LINK_METHOD) {
      const url = parseSafeHttpUrl(params.url);
      return url === null ? null : { kind: 'open-link', url };
    }
    if (data.method === AGENT_VISUAL_GESTURE_METHOD) {
      const { id, gesture } = params;
      return typeof id === 'number' &&
        Number.isFinite(id) &&
        (gesture === 'inside' || gesture === 'none' || gesture === 'unclear')
        ? { kind: 'gesture', id, gesture }
        : null;
    }
    if (data.method === AGENT_VISUAL_STATUS_METHOD) {
      const state = params.state;
      if (
        state === 'ready' ||
        state === 'alive' ||
        state === 'unresponsive' ||
        state === 'navigated' ||
        state === 'awaiting-document'
      ) {
        return { kind: 'status', state };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Round a visual height upward and keep it within the supported range. */
export function clampAgentVisualHeight(
  height: number,
  maxHeight: number,
): number {
  const safeMaxHeight =
    Number.isFinite(maxHeight) &&
    maxHeight >= VISUAL_MIN_HEIGHT &&
    maxHeight <= VISUAL_MAX_HEIGHT
      ? Math.floor(maxHeight)
      : VISUAL_MAX_HEIGHT;
  const upperBound = Math.max(VISUAL_MIN_HEIGHT, safeMaxHeight);
  if (!Number.isFinite(height)) return upperBound;
  return Math.max(VISUAL_MIN_HEIGHT, Math.min(Math.ceil(height), upperBound));
}

/**
 * The reserved height for a visual before its first report: the measured pair
 * whose width is nearest the frame's width, else the visual's `maxHeight`.
 * Without a known width there is no basis to pick a pair.
 */
export function pickAgentVisualHeightHint(
  heights: ReadonlyArray<readonly [number, number]> | undefined,
  width: number | undefined,
  maxHeight: number,
): number {
  const bound = Math.min(maxHeight, VISUAL_MAX_HEIGHT);
  if (!heights || heights.length === 0 || !width || !Number.isFinite(width)) {
    return clampAgentVisualHeight(maxHeight, bound);
  }
  let best: readonly [number, number] | undefined;
  for (const pair of heights) {
    if (!best) {
      best = pair;
      continue;
    }
    const distance = Math.abs(pair[0] - width);
    const bestDistance = Math.abs(best[0] - width);
    // On a tie, reserve the taller height so the first paint does not clip.
    if (
      distance < bestDistance ||
      (distance === bestDistance && pair[1] > best[1])
    ) {
      best = pair;
    }
  }
  return clampAgentVisualHeight(best ? best[1] : maxHeight, bound);
}

/**
 * The trusted top-level document for an offscreen preview. It holds one relay
 * frame with the same attributes as `AgentVisualFrame`'s iframe, kept inert as
 * a view-only visual is, at an exact CSS size.
 */
export function buildAgentVisualPreviewHostDocument(
  wrapperSrcDoc: string,
  options: { title: string; width: number; height: number },
): string {
  const title = escapeHtmlAttribute(options.title);
  const srcdoc = escapeSrcDocAttribute(wrapperSrcDoc);
  const width = Math.max(1, Math.floor(options.width));
  const height = Math.max(1, Math.floor(options.height));
  const style = `<style>html,body{margin:0;overflow:hidden;background:transparent}iframe{display:block;border:0;width:${width}px;height:${height}px}</style>`;
  return `<!doctype html>\n<meta charset="utf-8">\n${style}\n<iframe sandbox="${AGENT_VISUAL_FRAME_SANDBOX}" referrerpolicy="no-referrer" allow="${AGENT_VISUAL_FRAME_ALLOW}" title="${title}" inert srcdoc="${srcdoc}"></iframe>`;
}
