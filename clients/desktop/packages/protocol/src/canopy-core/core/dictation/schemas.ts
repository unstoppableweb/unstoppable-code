import { z } from 'zod';

/**
 * `core.dictation.*`: the speech model a host's dictation helper needs. The
 * host downloads it on first use, verifies every file and installs it per
 * user. No host path crosses this wire.
 */

/** A model id names one model version, such as `moonshine-medium-streaming-en-quantized_26_11_02`. */
export const DictationModelIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);

export const DICTATION_MODEL_ARCHITECTURES = [
  'small-streaming',
  'medium-streaming',
] as const;
export const DictationModelArchitectureSchema = z.enum(
  DICTATION_MODEL_ARCHITECTURES,
);
export type DictationModelArchitecture = z.output<
  typeof DictationModelArchitectureSchema
>;

export const DictationModelSchema = z.strictObject({
  id: DictationModelIdSchema,
  /** The model's name as settings show it, such as `English (medium)`. */
  displayName: z.string().min(1).max(128),
  architecture: DictationModelArchitectureSchema,
  /** BCP 47 language tag. */
  language: z.string().min(2).max(35),
  /** The download size: the sum of every file's size. */
  sizeBytes: z.number().int().min(0),
  /** SPDX identifier of the model's license, such as `MIT`. */
  license: z.string().min(1).max(64),
});
export type DictationModel = z.output<typeof DictationModelSchema>;

/**
 * `unsupported`: this host has no dictation model to manage (macOS uses the
 * system's speech assets). `notInstalled`: nothing usable is on disk.
 * `downloading` and `verifying` report progress. `installed`: a verified copy
 * of this model is on disk. `failed`: the last install failed; `failure` says
 * why.
 */
export const DICTATION_MODEL_STATES = [
  'unsupported',
  'notInstalled',
  'downloading',
  'verifying',
  'installed',
  'failed',
] as const;
export const DictationModelStateSchema = z.enum(DICTATION_MODEL_STATES);
export type DictationModelState = z.output<typeof DictationModelStateSchema>;

/**
 * `sourceUnavailable`: this build has no download location. `network`: a
 * request failed or ended early. `checksum`: a file didn't match its pinned
 * sha256. `storage`: writing or moving files failed. A download someone
 * cancels or removes is not a failure.
 */
export const DICTATION_MODEL_FAILURE_CODES = [
  'sourceUnavailable',
  'network',
  'checksum',
  'storage',
] as const;
export const DictationModelFailureSchema = z.strictObject({
  code: z.enum(DICTATION_MODEL_FAILURE_CODES),
  message: z.string().min(1).max(1024),
});
export type DictationModelFailure = z.output<
  typeof DictationModelFailureSchema
>;

export const DictationModelProgressSchema = z.strictObject({
  receivedBytes: z.number().int().min(0),
  totalBytes: z.number().int().min(0),
});

export const DictationModelStatusSchema = z.strictObject({
  state: DictationModelStateSchema,
  /** The model this build uses; null when `unsupported`. */
  model: DictationModelSchema.nullable(),
  /** While `downloading` or `verifying`; null otherwise. */
  progress: DictationModelProgressSchema.nullable(),
  /** The last failure while `failed`; null otherwise. */
  failure: DictationModelFailureSchema.nullable(),
  /** Whether this build has a download location for the model. */
  sourceConfigured: z.boolean(),
  /**
   * Whether model files other than this model's verified install are on
   * disk: an older model this version replaces, or a partial download of
   * this model or another. Removing the model deletes them.
   */
  extraFilesStored: z.boolean(),
  /** Counts every change to the status. */
  revision: z.number().int().min(0),
});
export type DictationModelStatus = z.output<typeof DictationModelStatusSchema>;

export const DictationModelStatusGetParamsSchema = z.strictObject({});

/**
 * `user`: someone asked for the model; it downloads unless it's installed or
 * already downloading. `launch`: the host started with dictation on; it
 * downloads only to replace an older installed model, so first use still
 * waits for someone to ask.
 */
export const DictationModelInstallParamsSchema = z.strictObject({
  trigger: z.enum(['user', 'launch']),
});
export type DictationModelInstallParams = z.output<
  typeof DictationModelInstallParamsSchema
>;

export const DictationModelInstallCancelParamsSchema = z.strictObject({});

export const DictationModelRemoveParamsSchema = z.strictObject({});
