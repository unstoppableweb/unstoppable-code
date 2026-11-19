import type {
  DictationModel,
  DictationModelFailure,
} from '@canopy/protocol/canopy-core';

/** One file of a model, as the manifest pins it. */
export interface SpeechModelFile {
  /** Path under the download location, such as `medium-streaming-en/quantized_26_11_02/encoder.ort`. */
  readonly path: string;
  readonly sizeBytes: number;
  /** Lowercase hex sha256. */
  readonly sha256: string;
}

/** A model the app version can use, with every file it downloads. */
export interface SpeechModelManifestEntry extends DictationModel {
  readonly files: readonly SpeechModelFile[];
}

/** Progress of one install, in bytes of the whole model. */
export interface SpeechModelInstallProgress {
  readonly phase: 'downloading' | 'verifying';
  readonly receivedBytes: number;
  readonly totalBytes: number;
}

/** A host failure with the status code core reports. */
export class SpeechModelInstallError extends Error {
  readonly code: DictationModelFailure['code'];

  constructor(code: DictationModelFailure['code'], message: string) {
    super(message);
    this.name = 'SpeechModelInstallError';
    this.code = code;
  }
}

/**
 * What `core.dictation.*` needs from the host that stores models. The host
 * owns the files: where they live, fetching through the user's network
 * settings, checking each file's sha256 and moving a verified copy into
 * place. Core owns which model this version uses, when to fetch it, and
 * which copies to remove.
 */
export interface CoreDictationHost {
  /** Whether this host runs a dictation helper that needs a model. */
  supported(): boolean;
  /** Whether this build has a download location for models. */
  sourceConfigured(): boolean;
  /** Whether a verified copy of exactly this manifest entry is installed. */
  isInstalled(entry: SpeechModelManifestEntry): Promise<boolean>;
  /** The ids of every model installed with a verified marker, of any version. */
  installedModelIds(): Promise<readonly string[]>;
  /** The ids of every model with files on disk: installed, stale or partial. */
  storedModelIds(): Promise<readonly string[]>;
  /**
   * Downloads, verifies and installs `entry`. Resumes files a previous
   * attempt left partly downloaded. Nothing reaches the installed location
   * until every file matched its sha256. Rejects with a
   * `SpeechModelInstallError`, or an `AbortError` when `signal` aborts; an
   * aborted install keeps its partial files for the next one to resume.
   */
  install(
    entry: SpeechModelManifestEntry,
    options: {
      readonly signal: AbortSignal;
      readonly onProgress: (progress: SpeechModelInstallProgress) => void;
    },
  ): Promise<void>;
  /** Deletes a model's files, installed or partial. */
  remove(modelId: string): Promise<void>;
}
