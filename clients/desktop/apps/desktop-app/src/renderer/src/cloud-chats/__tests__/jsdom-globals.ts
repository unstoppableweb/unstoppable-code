// jsdom lacks the TextEncoder and structuredClone the protocol package and the
// shared editor use at import time, and the TextDecoder an attachment's text
// preview reads with; the test imports this module first.
// eslint-disable-next-line no-restricted-imports
import { TextDecoder, TextEncoder } from 'node:util';

globalThis.TextEncoder ??= TextEncoder;
if (typeof globalThis.TextDecoder !== 'function')
  Object.defineProperty(globalThis, 'TextDecoder', { value: TextDecoder });
globalThis.structuredClone ??= <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;
