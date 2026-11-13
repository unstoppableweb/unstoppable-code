// Consolidation prompt input budgeting, kept free of the Markdown parser so
// the import runner can consult it without loading the rest of consolidation.
import { IMPORTS_INPUT_BUDGET_BYTES } from './limits';
import { utf8ByteLength } from './text';

export function logicalClaudeMemorySourcePath(sourcePath: string): string {
  const normalizedPath = sourcePath.replace(/\\/g, '/');
  const memorySegment = '/memory/';
  const memoryIndex = normalizedPath.lastIndexOf(memorySegment);
  if (memoryIndex !== -1) {
    const relativePath = normalizedPath.slice(
      memoryIndex + memorySegment.length,
    );
    if (relativePath.length > 0) {
      return `claude-code-memory/${relativePath}`;
    }
  }
  const basenameIndex = normalizedPath.lastIndexOf('/');
  return normalizedPath.slice(basenameIndex + 1);
}

export function logicalCodexMemorySourcePath(sourcePath: string): string {
  const normalizedPath = sourcePath.replace(/\\/g, '/');
  const basenameIndex = normalizedPath.lastIndexOf('/');
  return `codex-memory/${normalizedPath.slice(basenameIndex + 1)}`;
}

export type MemoryImportSourceTool = 'claude-code' | 'codex';

export function logicalMemorySourcePath(
  sourceTool: MemoryImportSourceTool,
  sourcePath: string,
): string {
  return sourceTool === 'codex'
    ? logicalCodexMemorySourcePath(sourcePath)
    : logicalClaudeMemorySourcePath(sourcePath);
}

export interface PromptEntryImportMetadata {
  sourceTool: MemoryImportSourceTool;
  originalPath: string;
  sourceFilename: string;
  repo?: string;
  modified: string;
}

export interface PromptEntryFile {
  filename: string;
  content: string;
  importMetadata?: PromptEntryImportMetadata;
}

export function promptInputEntry(file: PromptEntryFile): {
  filename: string;
  content: string;
  source_tool?: MemoryImportSourceTool;
  original_path?: string;
  repo?: string;
  modified?: string;
} {
  const metadata = file.importMetadata;
  if (!metadata) {
    return { filename: file.filename, content: file.content };
  }
  return {
    filename: metadata.sourceFilename,
    source_tool: metadata.sourceTool,
    original_path: metadata.originalPath,
    ...(metadata.repo ? { repo: metadata.repo } : {}),
    modified: metadata.modified,
    content: file.content,
  };
}

// The prompt embeds each file as an entry of JSON.stringify(entries, null, 2),
// so the budget must charge the serialized fragment (JSON escaping, the
// filename/metadata, and array indentation), not raw content bytes — a
// quote-heavy file serializes to roughly double its raw size. Every line of
// the entry is indented two extra spaces inside the array, plus the ",\n"
// separator.
export function promptEntryCostBytes(file: PromptEntryFile): number {
  const serialized = JSON.stringify(promptInputEntry(file), null, 2);
  const lines = serialized.split('\n').length;
  return utf8ByteLength(serialized) + 2 * lines + 2;
}

// Whether a prompt entry could fit an input budget at all, with nothing
// else selected. A 'stop' selection keeps FIFO order by stopping at the
// first entry that does not fit the room left, which is right only while
// that entry leads the next run: an entry this rejects leads nothing, so
// stopping at it would hold every later entry back forever. Selections pass
// such an entry over and report it instead.
export function promptEntryFitsBudget(
  file: PromptEntryFile,
  budgetBytes: number,
): boolean {
  return promptEntryCostBytes(file) <= budgetBytes;
}

// Import staging refuses files whose serialized prompt entry could never fit
// the imports budget — staged anyway, they would sit undrainable forever
// behind the 'stop' selection.
export function importEntryFitsBudget(options: {
  filename: string;
  originalPath: string;
  sourceFilename: string;
  repo?: string;
  modified: string;
  content: string;
  sourceTool?: MemoryImportSourceTool;
}): boolean {
  const file: PromptEntryFile = {
    filename: options.filename,
    content: options.content,
    importMetadata: {
      sourceTool: options.sourceTool ?? 'claude-code',
      originalPath: options.originalPath,
      sourceFilename: options.sourceFilename,
      ...(options.repo ? { repo: options.repo } : {}),
      modified: options.modified,
    },
  };
  return promptEntryCostBytes(file) <= IMPORTS_INPUT_BUDGET_BYTES;
}
