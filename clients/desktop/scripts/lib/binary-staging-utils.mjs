import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import extractZipArchive from 'extract-zip';
import {
  getHostTarget as getStrictHostTarget,
  PRODUCTION_BINARY_TARGETS,
} from './binary-staging-targets.mjs';

export const SUPPORTED_TARGETS = new Set(PRODUCTION_BINARY_TARGETS);
export function getHostTarget(binaryLabel, options = {}) {
  try {
    const target = getStrictHostTarget(binaryLabel, options);
    return options.supportedTargets && !options.supportedTargets.has(target)
      ? null
      : target;
  } catch (error) {
    if (
      error instanceof Error &&
      /^Unsupported .* binary (architecture|platform): /.test(error.message)
    ) {
      return null;
    }
    throw error;
  }
}

export function parseTargetArgs(argv) {
  let host = false;
  let targets = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host') {
      host = true;
      continue;
    }
    if (arg === '--targets') {
      targets = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--targets=')) {
      targets = arg.slice('--targets='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { host, targets };
}

export function resolveTargets(args, binaryLabel, options = {}) {
  const supported = options.supportedTargets ?? SUPPORTED_TARGETS;
  if (typeof args.targets === 'string') {
    return [
      ...new Set(
        args.targets
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ].filter((target) => {
      if (!supported.has(target)) {
        throw new Error(`Unsupported ${binaryLabel} target: ${target}`);
      }
      return true;
    });
  }

  if (args.host) {
    const hostTarget = getStrictHostTarget(binaryLabel, {
      platform: options.platform,
      arch: options.arch,
      env: options.env,
    });
    if (!supported.has(hostTarget)) {
      throw new Error(`Unsupported ${binaryLabel} target: ${hostTarget}`);
    }
    return [hostTarget];
  }

  const hostTarget = getHostTarget(binaryLabel, {
    platform: options.platform,
    arch: options.arch,
    env: options.env,
  });
  return hostTarget && supported.has(hostTarget) ? [hostTarget] : [];
}

export { getHostTarget as getDarwinHostTarget };

export function resolveDarwinTargets(args, binaryLabel) {
  return resolveTargets(args, binaryLabel, {
    supportedTargets: new Set(['darwin-arm64', 'darwin-x64']),
  });
}

export function extractTarGz(archivePath, destinationDir) {
  execFileSync('tar', ['-xzf', archivePath, '-C', destinationDir], {
    stdio: 'pipe',
  });
}

export async function extractZip(archivePath, destinationDir) {
  await extractZipArchive(archivePath, { dir: destinationDir });
}

export function executableName(baseName, target) {
  return target.startsWith('win32-') ? `${baseName}.exe` : baseName;
}

export const CODEX_BINARY_BASENAMES = ['codex', 'codex-code-mode-host'];

export function codexExecutableNamesForTarget(target) {
  return CODEX_BINARY_BASENAMES.map((baseName) =>
    executableName(baseName, target),
  );
}

/** Helpers Codex's elevated Windows sandbox launches from the directory that
 * holds codex.exe. Desktop-only: the CLI never runs delegated workers. */
export const CODEX_WINDOWS_SANDBOX_BASENAMES = [
  'codex-windows-sandbox-setup',
  'codex-command-runner',
];

/** Codex executables staged for the desktop app on a target. */
export function codexDesktopBasenamesForTarget(target) {
  // Codex's Linux filesystem sandbox requires bwrap beside its executable.
  if (target.startsWith('linux-')) {
    return [...CODEX_BINARY_BASENAMES, 'bwrap'];
  }
  return target.startsWith('win32-')
    ? [...CODEX_BINARY_BASENAMES, ...CODEX_WINDOWS_SANDBOX_BASENAMES]
    : [...CODEX_BINARY_BASENAMES];
}

export function codexDesktopExecutableNamesForTarget(target) {
  return codexDesktopBasenamesForTarget(target).map((baseName) =>
    executableName(baseName, target),
  );
}

export function targetPlatform(target) {
  return target.split('-')[0];
}

export function targetArch(target) {
  return target.slice(target.indexOf('-') + 1);
}

export function getRepoRootFromScriptsLib() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function getBinaryCacheRoot(root) {
  return join(root, '.cache', 'bin');
}

export function readPinnedPackageVersion(
  root,
  packagePath,
  label = packagePath,
) {
  const packageJsonPath = join(root, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const value = packagePath
    .split('.')
    .reduce((current, segment) => current?.[segment], packageJson);

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`package.json is missing ${label}`);
  }

  return value.trim();
}

export function githubHeaders(userAgent, accept = 'application/octet-stream') {
  const headers = {
    Accept: accept,
    'User-Agent': userAgent,
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export function isAlreadyStaged(finalPath, markerPath, version, checksum) {
  if (!existsSync(finalPath) || !existsSync(markerPath)) {
    return false;
  }

  const marker = readFileSync(markerPath, 'utf8').trim();
  return marker === `${version}\n${checksum}`;
}

export function writeVersionMarker(markerPath, version, checksum) {
  writeFileSync(markerPath, `${version}\n${checksum}\n`);
}

export function cleanupTempPaths(paths) {
  for (const path of paths) {
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

export function finalizeStagedBinary({
  extractedBinary,
  finalPath,
  markerPath,
  version,
  checksum,
  label,
  target,
}) {
  chmodSync(extractedBinary, 0o755);
  renameSync(extractedBinary, finalPath);
  writeVersionMarker(markerPath, version, checksum);

  console.log(`Staged ${label} ${target} at ${finalPath}`);
  return finalPath;
}

const DEFAULT_DOWNLOAD_ATTEMPTS = 4;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 180_000;
const DEFAULT_DOWNLOAD_RETRY_DELAY_MS = 2_000;
const DEFAULT_DOWNLOAD_MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_DOWNLOAD_MAX_REDIRECTS = 10;
const SENSITIVE_REDIRECT_HEADERS = new Set(['authorization', 'cookie']);

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function isRetryableStatus(status) {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function isRetryableDownloadError(error) {
  if (error?.retryable === true) {
    return true;
  }

  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return true;
  }

  if (
    typeof error?.code === 'string' &&
    /^(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE)$/.test(
      error.code,
    )
  ) {
    return true;
  }

  return (
    error instanceof TypeError &&
    /fetch|network|socket|terminated|aborted/i.test(error.message)
  );
}

function normalizeDownloadHeaders(headers) {
  if (!headers) {
    return {};
  }

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...headers };
}

function getRedirectHeaders(headers, fromUrl, toUrl) {
  if (new URL(fromUrl).origin === new URL(toUrl).origin) {
    return headers;
  }

  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !SENSITIVE_REDIRECT_HEADERS.has(name.toLowerCase()),
    ),
  );
}

function isRedirectStatus(status) {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function createTimeoutError(timeoutMs) {
  const error = new Error(`Download timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  return error;
}

function createDownloadAbortController(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Download timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  let removeExternalAbortListener = () => {};
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      const onAbort = () => {
        controller.abort(externalSignal.reason);
      };
      externalSignal.addEventListener('abort', onAbort, { once: true });
      removeExternalAbortListener = () => {
        externalSignal.removeEventListener('abort', onAbort);
      };
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      removeExternalAbortListener();
    },
  };
}

function downloadRequestToFile(
  url,
  filePath,
  { headers, signal, timeoutMs, maxRedirects },
  redirectCount = 0,
) {
  const requestUrl = new URL(url);
  const client =
    requestUrl.protocol === 'https:'
      ? https
      : requestUrl.protocol === 'http:'
        ? http
        : null;

  if (!client) {
    throw new Error(
      `Unsupported download URL protocol: ${requestUrl.protocol}`,
    );
  }

  return new Promise((resolveDownload, rejectDownload) => {
    let settled = false;
    const resolveOnce = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveDownload(value);
    };
    const rejectOnce = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      rejectDownload(error);
    };

    const request = client.get(requestUrl, { headers, signal }, (response) => {
      const status = response.statusCode ?? 0;

      if (isRedirectStatus(status)) {
        const location = response.headers.location;
        response.resume();

        if (!location) {
          rejectOnce(
            new Error(`Redirect from ${url} did not include Location`),
          );
          return;
        }

        if (redirectCount >= maxRedirects) {
          rejectOnce(new Error(`Too many redirects while downloading ${url}`));
          return;
        }

        let redirectUrl;
        let redirectHeaders;
        try {
          redirectUrl = new URL(location, requestUrl).toString();
          redirectHeaders = getRedirectHeaders(headers, url, redirectUrl);
        } catch (error) {
          rejectOnce(error);
          return;
        }

        resolveOnce(
          downloadRequestToFile(
            redirectUrl,
            filePath,
            {
              headers: redirectHeaders,
              signal,
              timeoutMs,
              maxRedirects,
            },
            redirectCount + 1,
          ),
        );
        return;
      }

      if (status < 200 || status >= 300) {
        response.resume();
        const error = new Error(`Failed to download ${url} (${status})`);
        error.retryable = isRetryableStatus(status);
        rejectOnce(error);
        return;
      }

      pipeline(response, createWriteStream(filePath)).then(
        () => resolveOnce(),
        (error) => rejectOnce(error),
      );
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(createTimeoutError(timeoutMs));
    });
    request.on('error', rejectOnce);
  });
}

export async function downloadToFile(
  url,
  filePath,
  requestOptions = {},
  downloadOptions = {},
) {
  const attempts = downloadOptions.attempts ?? DEFAULT_DOWNLOAD_ATTEMPTS;
  const timeoutMs = downloadOptions.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const retryDelayMs =
    downloadOptions.retryDelayMs ?? DEFAULT_DOWNLOAD_RETRY_DELAY_MS;
  const maxRetryDelayMs =
    downloadOptions.maxRetryDelayMs ?? DEFAULT_DOWNLOAD_MAX_RETRY_DELAY_MS;
  const maxRedirects =
    downloadOptions.maxRedirects ?? DEFAULT_DOWNLOAD_MAX_REDIRECTS;
  const headers = normalizeDownloadHeaders(requestOptions.headers);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { signal, cleanup } = createDownloadAbortController(
      timeoutMs,
      requestOptions.signal,
    );

    try {
      await downloadRequestToFile(url, filePath, {
        headers,
        signal,
        timeoutMs,
        maxRedirects,
      });
      return;
    } catch (error) {
      cleanupTempPaths([filePath]);
      if (attempt >= attempts || !isRetryableDownloadError(error)) {
        throw error;
      }

      const delay = Math.min(
        retryDelayMs * 2 ** (attempt - 1),
        maxRetryDelayMs,
      );
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Download attempt ${attempt} failed for ${url}: ${message}. Retrying in ${delay}ms...`,
      );
      await sleep(delay);
    } finally {
      cleanup();
    }
  }
}

export function readJsonArray(filePath) {
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed)
      ? parsed.filter((entry) => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}
