import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const srcRoot = join(__dirname, '..');
const allowedImport =
  /^(\.{1,2}(\/|$)|@canopy\/protocol(\/|$)|@canopy\/core-transport\/(types|lost-reply)$)/;

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const path = join(dir, entry.name);
    if (dir === srcRoot && entry.isDirectory() && entry.name === 'node')
      return [];
    if (entry.isDirectory()) return productionFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function specifiers(source: string): string[] {
  return Array.from(
    source.matchAll(
      /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]/g,
    ),
  ).map((match) => match[1] ?? match[2] ?? '');
}

describe('browser-safe root', () => {
  it('imports only protocol, transport types and lost replies, and siblings', () => {
    const offenders = productionFiles(srcRoot).flatMap((file) =>
      specifiers(readFileSync(file, 'utf8'))
        .filter((specifier) => !allowedImport.test(specifier))
        .map((specifier) => `${relative(srcRoot, file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps Node isolated in src/node and exports exactly ., ./node and ./outcome', () => {
    expect(existsSync(join(srcRoot, 'node', 'index.ts'))).toBe(true);
    for (const file of productionFiles(srcRoot)) {
      const source = readFileSync(file, 'utf8');
      expect(
        specifiers(source).filter((s) => /(^|\/)node(\/|$)/.test(s)),
      ).toEqual([]);
      expect(source).not.toMatch(/\bprocess\.[a-z]|\bBuffer\b|__dirname/);
    }
    const manifest: unknown = JSON.parse(
      readFileSync(join(srcRoot, '..', 'package.json'), 'utf8'),
    );
    const exportsField =
      typeof manifest === 'object' && manifest !== null && 'exports' in manifest
        ? manifest.exports
        : undefined;
    expect(exportsField).toEqual({
      '.': './src/index.ts',
      './outcome': './src/outcome.ts',
      './node': './src/node/index.ts',
    });
  });
});
