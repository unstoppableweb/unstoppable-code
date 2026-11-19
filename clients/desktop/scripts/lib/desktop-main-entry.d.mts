import type { Plugin } from 'vite';

export function mainEntrySource(bundleFile: string): string;

export function withOneBytePlaceholder(loaderSource: string): string;

export function isolatedMainEntrySource(normalSource: string): string;

export function linuxSafeStorageHelperPlugin(options: {
  outputFile?: string;
  entryFile: string;
  alias?: Record<string, string>;
  define?: Record<string, string>;
  onInputs?: (files: string[]) => void;
}): Plugin;
