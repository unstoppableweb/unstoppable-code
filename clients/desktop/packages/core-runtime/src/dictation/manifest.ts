import type { SpeechModelFile, SpeechModelManifestEntry } from './ports';

/*
 * The speech models this app version can use, pinned by size and sha256 (D5
 * of the Linux dictation plan). A new model version is a new id, so it
 * installs into its own directory beside the old one.
 *
 * File paths follow Moonshine's own layout (`<model>/<version>/<file>`) under
 * the download location, so a mirror that copies that layout serves them.
 * The release step that mirrors these files to Canopy-controlled storage
 * checks them against Moonshine's CRC-32C manifest once; the app checks
 * only these sha256 values.
 */

const file = (
  directory: string,
  name: string,
  sizeBytes: number,
  sha256: string,
): SpeechModelFile => ({ path: `${directory}/${name}`, sizeBytes, sha256 });

function entry(
  model: Omit<SpeechModelManifestEntry, 'sizeBytes'>,
): SpeechModelManifestEntry {
  return {
    ...model,
    sizeBytes: model.files.reduce((total, f) => total + f.sizeBytes, 0),
  };
}

const MEDIUM = 'medium-streaming-en/quantized_26_11_02';
const SMALL = 'small-streaming-en/quantized_26_11_02';

export const MOONSHINE_MEDIUM_STREAMING_EN = entry({
  id: 'moonshine-medium-streaming-en-quantized_26_11_02',
  displayName: 'English (medium)',
  architecture: 'medium-streaming',
  language: 'en',
  license: 'MIT',
  files: [
    file(
      MEDIUM,
      'adapter.ort',
      3651256,
      'cbc25da09b781d3c7e4519fe7e7869d47caa6659e73b7d6f3dcc00613a5947af',
    ),
    file(
      MEDIUM,
      'cross_kv.ort',
      11643720,
      '5a93856515ee2ba577ab968f1238a55b84e6d4cc55b005f7d82d618d7b2db0fc',
    ),
    file(
      MEDIUM,
      'decoder_kv.ort',
      147137432,
      '83916c35fe11999ab1034cbc840602268b4f054282d4d7e0376ff2e55dcd4810',
    ),
    file(
      MEDIUM,
      'encoder.ort',
      94705336,
      '29ceb7c83876b44a2c47200f5f864c602e4a91d80fd8a09b17246b5b64f2341d',
    ),
    file(
      MEDIUM,
      'frontend.model.ort',
      28768,
      '70d3b8de94e3b8e3b81b0fbb019e32a67d3eb40a174292e0db2e3536bdd833ba',
    ),
    file(
      MEDIUM,
      'frontend.weights.ort',
      11889512,
      '627934b415c8db6f275a14e59ff419436b27279e00bbc8ea30a274973dfc6dec',
    ),
    file(
      MEDIUM,
      'streaming_config.json',
      513,
      '28e83b7a28e91472692a035e0dae3116422ae43aeb2bef5ed822c44ce89b88af',
    ),
    file(
      MEDIUM,
      'tokenizer.bin',
      249974,
      '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d',
    ),
  ],
});

export const MOONSHINE_SMALL_STREAMING_EN = entry({
  id: 'moonshine-small-streaming-en-quantized_26_11_02',
  displayName: 'English (small)',
  architecture: 'small-streaming',
  language: 'en',
  license: 'MIT',
  files: [
    file(
      SMALL,
      'adapter.ort',
      2870320,
      '100d4806a3ba19b739fa9ae5c952e4d5267983090eea4a085e08d3e0bfd6875b',
    ),
    file(
      SMALL,
      'cross_kv.ort',
      5356496,
      'aa0ed033b7065ef744c36dce00228c708b43f2f2410e8ec782a960105c8595f7',
    ),
    file(
      SMALL,
      'decoder_kv.ort',
      82043616,
      'e4fae3869851b861177b5e1619c77ec9262365b2747ec322298d11753e88b38d',
    ),
    file(
      SMALL,
      'encoder.ort',
      44148536,
      'f61486dc7b017cee99196366dcc977a173f45f2f387b0b7977695d0f0565d234',
    ),
    file(
      SMALL,
      'frontend.model.ort',
      26992,
      '4a8d5ef7e99a5e3011dbf09ffac4176056587f2aec20f885d606b9f55fbed408',
    ),
    file(
      SMALL,
      'frontend.weights.ort',
      7769416,
      '5379f3dfebe849c6cbacf84f0aa7441956f9572efe1720d44aa267e7dff93056',
    ),
    file(
      SMALL,
      'streaming_config.json',
      512,
      '26f02b6afb22d60871a5efd85c3d38e569cc0ddb6c5eb6e93d3260152ae8a47a',
    ),
    file(
      SMALL,
      'tokenizer.bin',
      249974,
      '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d',
    ),
  ],
});

/** Every model this version knows, by id. */
export const SPEECH_MODEL_MANIFEST: Readonly<
  Record<string, SpeechModelManifestEntry>
> = {
  [MOONSHINE_MEDIUM_STREAMING_EN.id]: MOONSHINE_MEDIUM_STREAMING_EN,
  [MOONSHINE_SMALL_STREAMING_EN.id]: MOONSHINE_SMALL_STREAMING_EN,
};

/**
 * The model this version installs. `medium-streaming` is the default (D2);
 * switching to `small-streaming` is a change here, not in the helper.
 */
export const DEFAULT_SPEECH_MODEL = MOONSHINE_MEDIUM_STREAMING_EN;
