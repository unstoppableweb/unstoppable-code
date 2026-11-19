/**
 * Loaded with `node --import` into the CAN-7176 child chat writer, before its
 * TypeScript loader. The child runs outside Electron, so `electron` resolves
 * to the Jest mock. The real electron package is refused before it loads:
 * requiring it from plain Node unpacks the Electron binary into node_modules.
 */
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const MOCK = new URL('../../../__tests__/electronMock.ts', import.meta.url)
  .href;
const REAL_ELECTRON =
  /[\\/]node_modules[\\/]electron[\\/](?:index|install|cli)\.js$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: MOCK, shortCircuit: true };
    const resolved = nextResolve(specifier, context);
    if (
      resolved.url.startsWith('file:') &&
      REAL_ELECTRON.test(fileURLToPath(resolved.url))
    )
      throw new Error(
        `The child chat writer refuses the real electron package (${specifier}).`,
      );
    return resolved;
  },
});
