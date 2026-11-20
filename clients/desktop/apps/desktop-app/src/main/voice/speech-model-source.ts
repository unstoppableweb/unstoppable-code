import { join } from 'node:path';
import { app, net } from 'electron';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  DEFAULT_SPEECH_MODEL,
  SpeechModelInstallError,
} from '@canopy/core-runtime/dictation';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import {
  getCanopyReleaseFlavor,
  type CanopyReleaseFlavor,
} from '../lib/app-identity';
import { getDictationModelsDir } from '../lib/paths';
import { localOnlyBlockedHost } from '../local-only/egress-policy';
import {
  createDesktopDictationHost,
  type DesktopDictationHostOptions,
} from './speech-model-host';

/**
 * Where release builds download the speech model from.
 *
 * Moonshine's own server is an interim exception to D5 of
 * docs/planning/2026-11-13-linux-dictation (CAN-7286, 2026-11-18). Every
 * file is still checked against the size and sha256 pinned in the manifest,
 * and redirects from this location are refused (see
 * `speechModelRedirectMode`). CAN-7275 replaces this URL with the
 * Canopy-controlled mirror.
 */
export const RELEASE_SPEECH_MODEL_BASE_URL: string | null =
  'https://download.moonshine.ai/model';

/** The development-only override, named `<BRAND>_DEV_SPEECH_MODEL_BASE_URL`. */
export const DEV_SPEECH_MODEL_BASE_URL_SUFFIX = 'DEV_SPEECH_MODEL_BASE_URL';

const SCHEMES = new Set(['https:', 'http:', 'file:']);

/**
 * The speech model's download location. Unpackaged builds and internal
 * builds honor the development override, which may be an `https:`, `http:`
 * or `file:` URL laid out like Moonshine's own (`<model>/<version>/<file>`).
 * Stable and RC builds ignore it.
 */
export function resolveSpeechModelBaseUrl(
  input: {
    readonly env?: Record<string, string | undefined>;
    readonly isPackaged?: boolean;
    readonly flavor?: CanopyReleaseFlavor;
  } = {},
): string | null {
  const env = input.env ?? process.env;
  const isPackaged = input.isPackaged ?? app.isPackaged;
  const flavor = input.flavor ?? getCanopyReleaseFlavor();
  const override = getBrandEnv(env, DEV_SPEECH_MODEL_BASE_URL_SUFFIX)?.trim();
  if (override && (!isPackaged || flavor === 'internal')) {
    try {
      if (SCHEMES.has(new URL(override).protocol)) return override;
    } catch {
      // Not a URL: ignore it.
    }
  }
  return RELEASE_SPEECH_MODEL_BASE_URL;
}

/**
 * How the speech model download treats redirects. The release location
 * refuses them, so the download never leaves that HTTPS host. Development
 * overrides keep following them.
 */
export function speechModelRedirectMode(
  baseUrl: string | null,
): 'error' | 'follow' {
  return baseUrl === RELEASE_SPEECH_MODEL_BASE_URL ? 'error' : 'follow';
}

/** This process's speech model store, fetching through Electron's network stack. */
export function desktopSpeechModelHostOptions(): DesktopDictationHostOptions {
  const baseUrl = resolveSpeechModelBaseUrl();
  const redirect = speechModelRedirectMode(baseUrl);
  return {
    supported: hostPlatformOperatingSystem() === 'linux',
    modelsDir: getDictationModelsDir(),
    baseUrl,
    // Electron's `net` uses the session's proxy settings: the system proxy,
    // PAC and `--proxy-server`, which Node's own fetch ignores. A local-only
    // build that doesn't allow the host says how to allow it, and sends
    // nothing.
    fetch: async (url, init) => {
      const blocked = await localOnlyBlockedHost(url);
      if (blocked !== null) {
        throw new SpeechModelInstallError(
          'network',
          `This local-only build blocks ${blocked}. Add it to allowedHosts in local-only.json, then try again.`,
        );
      }
      return net.fetch(url, { ...init, redirect });
    },
  };
}

/** The installed model the dictation helper loads, and how to load it. */
export interface InstalledSpeechModel {
  readonly directory: string;
  readonly architecture: string;
}

/**
 * The directory and architecture of this version's speech model, or null
 * when no verified copy is installed. The helper is only ever given a
 * directory whose marker matches the manifest, never a partial download.
 */
export async function resolveInstalledSpeechModel(): Promise<InstalledSpeechModel | null> {
  const options = desktopSpeechModelHostOptions();
  if (!options.supported) return null;
  const host = createDesktopDictationHost(options);
  if (!(await host.isInstalled(DEFAULT_SPEECH_MODEL))) return null;
  return {
    directory: join(options.modelsDir, DEFAULT_SPEECH_MODEL.id),
    architecture: DEFAULT_SPEECH_MODEL.architecture,
  };
}
