import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { existsSync } from 'node:fs';
import { release } from 'node:os';
import {
  getBundledDictateBinaryPath,
  getEnhancedEnv,
} from '@canopy/execution-engine/pipelines/config-paths';
import { BRAND } from '@canopy/brand/current';
import {
  UNSUPPORTED_VOICE_DICTATION_RESPONSE,
  isVoiceDictationPlatform,
  isVoiceSystemAccessPlatform,
} from '@canopy/desktop-shared/platform-capabilities';
import type {
  VoiceEventPayload,
  VoiceIsSupportedResponse,
  VoiceSpeechRecognitionAccess,
} from '@canopy/desktop-shared/types';

const UNSUPPORTED_VOICE_RESPONSE: VoiceIsSupportedResponse =
  UNSUPPORTED_VOICE_DICTATION_RESPONSE;

export type VoiceEventListener = (event: VoiceEventPayload) => void;

interface ActiveSession {
  sessionId: string;
  child: ChildProcessWithoutNullStreams;
  stderrBuffer: string;
  stdoutBuffer: string;
  closed: boolean;
  stdinEnded: boolean;
  sawStoppedEvent: boolean;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDictateMacOSVersionSupported(): boolean {
  // Darwin 25 is macOS 26. Older hosts can fail in dyld before Swift's
  // availability checks run, including in probe and authorization modes.
  // Only the macOS helper has a version floor.
  if (hostPlatformOperatingSystem() !== 'darwin') return true;
  return Number(release().split('.')[0]) >= 25;
}

/**
 * The Linux helper's `--probe` codes, as Settings and the composer say them.
 * Its own reason stays for any other code.
 */
const LINUX_PROBE_REASONS: Readonly<
  Record<NonNullable<VoiceIsSupportedResponse['code']>, string>
> = {
  'model-missing': 'Download the speech model to use dictation.',
  'cpu-unsupported':
    "This computer's processor doesn't support dictation. It needs AVX.",
};

/** The Linux helper's probe code, when it is one the app knows. */
function linuxProbeCode(value: unknown): VoiceIsSupportedResponse['code'] {
  if (hostPlatformOperatingSystem() !== 'linux') return undefined;
  return value === 'model-missing' || value === 'cpu-unsupported'
    ? value
    : undefined;
}

/**
 * Arguments that point the Linux helper at the verified speech model. With
 * none installed it gets no model, and its probe reports `model-missing`.
 */
async function helperArgs(): Promise<string[]> {
  if (hostPlatformOperatingSystem() !== 'linux') return [];
  const { resolveInstalledSpeechModel } = await import('./speech-model-source');
  const model = await resolveInstalledSpeechModel();
  return model
    ? ['--model-dir', model.directory, '--model-arch', model.architecture]
    : [];
}

export class VoiceService {
  private activeSession: ActiveSession | null = null;
  private listeners = new Set<VoiceEventListener>();
  private cachedSupport: VoiceIsSupportedResponse | null = null;
  private supportProbePromise: Promise<VoiceIsSupportedResponse> | null = null;
  // Session IDs whose `start()` is awaiting setup but has not yet spawned
  // the child. If `cancel()` arrives for one of these, we mark it as aborted
  // so the eventual resume of `start()` bails before spawning.
  private pendingStartIds = new Set<string>();
  private abortedStartIds = new Set<string>();

  onEvent(listener: VoiceEventListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  async isSupported(): Promise<VoiceIsSupportedResponse> {
    if (!isVoiceDictationPlatform(hostPlatformOperatingSystem())) {
      return UNSUPPORTED_VOICE_RESPONSE;
    }
    if (!isDictateMacOSVersionSupported()) {
      return {
        supported: false,
        reason: 'Voice dictation needs macOS 26 or later.',
      };
    }
    if (this.cachedSupport) {
      return this.cachedSupport;
    }
    if (this.supportProbePromise) {
      return this.supportProbePromise;
    }
    this.supportProbePromise = this.probe();
    try {
      const support = await this.supportProbePromise;
      // On Linux the answer follows the speech model, which can be
      // downloaded or removed at any time, so every check probes again.
      if (hostPlatformOperatingSystem() === 'darwin')
        this.cachedSupport = support;
      return support;
    } finally {
      this.supportProbePromise = null;
    }
  }

  /** Forget cached probe result so `isSupported` runs the helper again. */
  resetSupportCache(): void {
    this.cachedSupport = null;
  }

  async requestSpeechRecognitionAccess(): Promise<VoiceSpeechRecognitionAccess> {
    if (!isVoiceDictationPlatform(hostPlatformOperatingSystem())) {
      return 'unavailable';
    }
    if (!isDictateMacOSVersionSupported()) {
      return 'unavailable';
    }
    if (!isVoiceSystemAccessPlatform(hostPlatformOperatingSystem())) {
      // Linux has no speech-recognition permission to ask for.
      return 'authorized';
    }
    const binary = resolveBinary();
    if (!binary) {
      return 'unavailable';
    }
    return new Promise((resolvePromise) => {
      execFile(
        binary,
        ['--request-authorization'],
        {
          env: getEnhancedEnv({ environment: { runtime: 'canopy' } }),
          timeout: 30_000,
          windowsHide: hostPlatformOperatingSystem() === 'win32',
        },
        (_error, stdout) => {
          const line = stdout
            .split('\n')
            .map((segment) => segment.trim())
            .filter(Boolean)
            .pop();
          if (!line) {
            resolvePromise('unknown');
            return;
          }
          try {
            const parsed: unknown = JSON.parse(line);
            if (!isJsonObject(parsed)) {
              resolvePromise('unknown');
              return;
            }
            resolvePromise(readSpeechRecognitionAccess(parsed));
          } catch {
            resolvePromise('unknown');
          }
        },
      );
    });
  }

  async start(sessionId: string): Promise<void> {
    // Self-heal: if a prior session's child exited without the JS side
    // observing a `stopped`/`error` event (e.g. the renderer unmounted
    // mid-start before its cancel path could reach us), the `activeSession`
    // marker may linger even though the process is gone. Detect that here
    // instead of permanently rejecting every subsequent start attempt.
    if (this.activeSession) {
      const prior = this.activeSession;
      const stillAlive =
        prior.child && prior.child.exitCode === null && !prior.closed;
      if (stillAlive) {
        throw new Error('Voice session already active');
      }
      if (this.activeSession === prior) {
        this.activeSession = null;
      }
    }
    // Reject concurrent starts that arrive while a prior start is still
    // awaiting its support probe. Without this, both continuations would pass
    // the activeSession guard, both spawn helpers after the probe resolves,
    // and the second would overwrite `activeSession` — leaving the first
    // child untracked and un-killable by cancel()/shutdown().
    if (this.pendingStartIds.size > 0) {
      throw new Error('Voice session already active');
    }
    this.pendingStartIds.add(sessionId);
    let support: VoiceIsSupportedResponse;
    let args: string[];
    try {
      // On Linux the model is resolved once, and the probe and the session
      // use the same arguments, so a model removed in between can't start
      // the helper without one.
      args = await helperArgs();
      support =
        hostPlatformOperatingSystem() === 'linux'
          ? await this.probe(args)
          : await this.isSupported();
    } finally {
      this.pendingStartIds.delete(sessionId);
    }
    if (this.abortedStartIds.delete(sessionId)) {
      // A concurrent `cancel(sessionId)` arrived while we were awaiting setup.
      // Abort before spawning so we never leak a child the renderer has
      // already forgotten about.
      return;
    }
    if (!support.supported) {
      throw new Error(
        support.reason
          ? `Voice input unavailable: ${support.reason}`
          : 'Voice input unavailable',
      );
    }
    const binary = resolveBinary();
    const child = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: getEnhancedEnv({ environment: { runtime: 'canopy' } }),
      windowsHide: hostPlatformOperatingSystem() === 'win32',
    });
    const session: ActiveSession = {
      sessionId,
      child,
      stderrBuffer: '',
      stdoutBuffer: '',
      closed: false,
      stdinEnded: false,
      sawStoppedEvent: false,
    };
    this.activeSession = session;

    child.stdout.on('data', (chunk: Buffer) => {
      session.stdoutBuffer += chunk.toString('utf8');
      this.drainStdout(session);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      session.stderrBuffer += chunk.toString('utf8');
    });
    child.stdin.on('error', (error: Error) => {
      if (session.closed || session.stdinEnded) {
        return;
      }
      this.emit({
        type: 'error',
        sessionId: session.sessionId,
        message: error.message,
      });
      this.closeSession(session);
    });
    child.on('error', (error) => {
      this.emit({
        type: 'error',
        sessionId: session.sessionId,
        message: error.message,
      });
      this.closeSession(session);
    });
    child.on('exit', (code, signal) => {
      this.drainStdout(session);
      if (session.closed) return;
      session.closed = true;
      // A non-null signal means the OS terminated the child (e.g. SIGABRT
      // from macOS TCC when the host bundle's Info.plist is missing the
      // NSSpeechRecognitionUsageDescription key). Surface it as an error so
      // the UI does not silently revert to idle.
      if (signal) {
        const reason =
          session.stderrBuffer.trim() ||
          `${BRAND.dictation.displayName} terminated by ${signal}`;
        this.emit({
          type: 'error',
          sessionId: session.sessionId,
          message: reason,
        });
      } else if (code !== null && code !== 0) {
        const reason = session.stderrBuffer.trim() || `exit code ${code}`;
        this.emit({
          type: 'error',
          sessionId: session.sessionId,
          message: reason,
        });
      } else if (!session.sawStoppedEvent) {
        this.emit({ type: 'stopped', sessionId: session.sessionId });
      }
      if (this.activeSession === session) {
        this.activeSession = null;
      }
    });
  }

  pushAudio(sessionId: string, buffer: Buffer): void {
    const session = this.activeSession;
    if (!session || session.sessionId !== sessionId) {
      return;
    }
    if (
      session.closed ||
      session.stdinEnded ||
      session.child.stdin.writableEnded ||
      session.child.stdin.destroyed
    ) {
      return;
    }
    session.child.stdin.write(buffer);
  }

  stop(sessionId: string): void {
    const session = this.activeSession;
    if (!session || session.sessionId !== sessionId) {
      return;
    }
    if (session.closed || session.stdinEnded) {
      return;
    }
    // Closing stdin signals end-of-audio to the Swift helper so it can emit a
    // final transcript before exiting.
    session.stdinEnded = true;
    try {
      session.child.stdin.end();
    } catch {
      // ignore — will be reaped by exit handler
    }
  }

  cancel(sessionId: string): void {
    if (this.pendingStartIds.delete(sessionId)) {
      // `start(sessionId)` is mid-await and has not spawned the child yet.
      // Remove it from the pending set so a subsequent start() can claim the
      // slot without waiting for the old probe to resolve, and mark it aborted
      // so the resume of start() bails before spawning.
      this.abortedStartIds.add(sessionId);
      return;
    }
    const session = this.activeSession;
    if (!session || session.sessionId !== sessionId) {
      return;
    }
    this.closeSession(session);
  }

  /**
   * Synchronously tear down any active or pending sidecar. Called from the
   * main-process quit/fatal-exit path to guarantee the Swift helper is not
   * left running after the app exits.
   */
  shutdown(): void {
    this.pendingStartIds.forEach((pending) => {
      this.abortedStartIds.add(pending);
    });
    const session = this.activeSession;
    if (session) {
      this.closeSession(session);
    }
  }

  private closeSession(session: ActiveSession): void {
    if (session.closed) return;
    session.closed = true;
    session.stdinEnded = true;
    try {
      session.child.kill('SIGTERM');
    } catch {
      // ignore
    }
    if (this.activeSession === session) {
      this.activeSession = null;
    }
  }

  private drainStdout(session: ActiveSession): void {
    const lines = session.stdoutBuffer.split('\n');
    session.stdoutBuffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      this.dispatchLine(session.sessionId, line);
    }
  }

  private dispatchLine(sessionId: string, line: string): void {
    const event = parseHelperEvent(sessionId, line);
    if (event) {
      if (event.type === 'stopped') {
        const session = this.activeSession;
        if (session && session.sessionId === sessionId) {
          if (session.sawStoppedEvent) {
            return;
          }
          session.sawStoppedEvent = true;
        }
      }
      this.emit(event);
    }
  }

  private emit(event: VoiceEventPayload): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch {
        // Never let a listener failure crash the service.
      }
    });
  }

  private async probe(knownArgs?: string[]): Promise<VoiceIsSupportedResponse> {
    if (!isVoiceDictationPlatform(hostPlatformOperatingSystem())) {
      return UNSUPPORTED_VOICE_RESPONSE;
    }
    const args = knownArgs ?? (await helperArgs());
    return new Promise((resolvePromise) => {
      const binary = resolveBinary();
      if (!binary) {
        resolvePromise({
          supported: false,
          // Linux builds stage the helper only once dictation ships there;
          // say so instead of naming a file.
          reason:
            hostPlatformOperatingSystem() === 'linux'
              ? "Dictation isn't included in this build."
              : `${BRAND.dictation.binaryName} binary not found`,
        });
        return;
      }
      execFile(
        binary,
        ['--probe', ...args],
        {
          env: getEnhancedEnv({ environment: { runtime: 'canopy' } }),
          timeout: 5_000,
          windowsHide: hostPlatformOperatingSystem() === 'win32',
        },
        (_error, stdout) => {
          const line = stdout
            .split('\n')
            .map((segment) => segment.trim())
            .filter(Boolean)
            .pop();
          if (!line) {
            resolvePromise({
              supported: false,
              reason: 'probe returned no output',
            });
            return;
          }
          try {
            const parsed: unknown = JSON.parse(line);
            if (!isJsonObject(parsed)) {
              resolvePromise({ supported: false });
              return;
            }
            const supported = parsed.supported === true;
            const code = linuxProbeCode(parsed.code);
            const reason =
              (code ? LINUX_PROBE_REASONS[code] : undefined) ??
              (typeof parsed.reason === 'string' ? parsed.reason : undefined);
            resolvePromise({
              supported,
              ...(reason ? { reason } : {}),
              ...(code ? { code } : {}),
            });
          } catch {
            resolvePromise({
              supported: false,
              reason: 'probe returned invalid JSON',
            });
          }
        },
      );
    });
  }
}

/**
 * Parse a single NDJSON line from the Swift helper into a {@link VoiceEventPayload}.
 * Returns `null` for unrecognized event shapes (so the service can ignore them
 * without crashing). Invalid JSON maps to an `error` event so it surfaces in
 * the UI instead of silently vanishing.
 */
export function parseHelperEvent(
  sessionId: string,
  line: string,
): VoiceEventPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      type: 'error',
      sessionId,
      message: `invalid helper output: ${line}`,
    };
  }
  if (!isJsonObject(parsed)) {
    return null;
  }
  const type = parsed.type;
  if (type === 'interim' || type === 'final') {
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    return { type, sessionId, text };
  }
  if (type === 'stopped') {
    return { type: 'stopped', sessionId };
  }
  if (type === 'error') {
    const message =
      typeof parsed.message === 'string' ? parsed.message : 'unknown error';
    return { type: 'error', sessionId, message };
  }
  return null;
}

function resolveBinary(): string {
  const candidate = getBundledDictateBinaryPath();
  if (!candidate) {
    return '';
  }
  if (!existsSync(candidate)) {
    return '';
  }
  return candidate;
}

function readSpeechRecognitionAccess(
  parsed: Record<string, unknown>,
): VoiceSpeechRecognitionAccess {
  const value = parsed.speechRecognition;
  switch (value) {
    case 'authorized':
    case 'denied':
    case 'not-determined':
    case 'restricted':
    case 'unknown':
    case 'unavailable':
      return value;
    default:
      return 'unknown';
  }
}

let instance: VoiceService | null = null;

export function getVoiceService(): VoiceService {
  if (!instance) {
    instance = new VoiceService();
  }
  return instance;
}
