// `core.dictation.*` (Linux dictation, CAN-7231): the speech model a host's
// dictation helper needs, which version to use, and when to download or
// remove it. The host stores the files through `CoreDictationHost`.
export {
  createCoreDictationHandlers,
  type CoreDictationHandlerOptions,
  type CoreDictationHandlers,
} from './handlers';
export {
  DEFAULT_SPEECH_MODEL,
  MOONSHINE_MEDIUM_STREAMING_EN,
  MOONSHINE_SMALL_STREAMING_EN,
  SPEECH_MODEL_MANIFEST,
} from './manifest';
export {
  SpeechModelInstallError,
  type CoreDictationHost,
  type SpeechModelFile,
  type SpeechModelInstallProgress,
  type SpeechModelManifestEntry,
} from './ports';
