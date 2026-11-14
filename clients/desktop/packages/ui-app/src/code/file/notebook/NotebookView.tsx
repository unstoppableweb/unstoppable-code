'use client';

import { memo, useMemo, type JSX, type MemoExoticComponent } from 'react';
import {
  Stack,
  Markdown,
  type MarkdownOptions,
  CodeBlock,
} from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  FILE_MARKDOWN_PROSE_CLASSES,
  useFileMarkdownOptions,
} from '../FileMarkdownPreview';
import type { FileContentScrollBinding } from '../FileViewer';
import {
  codeFenceMarkdown,
  latexOutputMarkdown,
  selectNotebookOutputRendering,
} from './notebook-mime';
import type {
  NotebookCell,
  NotebookOutput,
  ParsedNotebook,
} from './notebook-types';

export const MAX_NOTEBOOK_RENDERED_CELLS: number = 500;
export const MAX_NOTEBOOK_OUTPUTS_PER_CELL: number = 50;
export const MAX_NOTEBOOK_TEXT_CHARS: number = 20_000;

export interface NotebookViewProps {
  readonly notebook: ParsedNotebook;
  readonly onOpenRelativePath?: (path: string) => void;
  readonly resolveAssetSrc?: (
    src: string,
  ) => string | Promise<string | null> | null;
  readonly scrollBinding?: FileContentScrollBinding;
}

interface TruncatedText {
  readonly text: string;
  readonly truncated: boolean;
}

interface MarkdownContentProps {
  readonly source: string;
  readonly options: MarkdownOptions;
}

interface NotebookCellProps {
  readonly cell: NotebookCell;
  readonly language: string | null;
  readonly options: MarkdownOptions;
  readonly onOpenRelativePath: NotebookViewProps['onOpenRelativePath'];
  readonly resolveAssetSrc: NotebookViewProps['resolveAssetSrc'];
}

interface MarkdownCellProps extends MarkdownContentProps {
  readonly attachments: ReadonlyMap<string, string> | undefined;
  readonly onOpenRelativePath: NotebookViewProps['onOpenRelativePath'];
  readonly resolveAssetSrc: NotebookViewProps['resolveAssetSrc'];
}

interface CodeCellProps {
  readonly cell: Extract<NotebookCell, { readonly cellType: 'code' }>;
  readonly language: string | null;
  readonly options: MarkdownOptions;
}

interface NotebookOutputProps {
  readonly output: NotebookOutput;
  readonly options: MarkdownOptions;
}

function truncateNotebookText(text: string): TruncatedText {
  return text.length > MAX_NOTEBOOK_TEXT_CHARS
    ? { text: text.slice(0, MAX_NOTEBOOK_TEXT_CHARS), truncated: true }
    : { text, truncated: false };
}

function markdownContent(
  source: string,
  options: MarkdownOptions,
): JSX.Element {
  return (
    <div className={FILE_MARKDOWN_PROSE_CLASSES}>
      <Markdown options={options}>{source}</Markdown>
    </div>
  );
}

function textTruncatedNote(kind: 'Cell' | 'Output'): string {
  const count = MAX_NOTEBOOK_TEXT_CHARS.toLocaleString('en-US');
  return `${kind} truncated to the first ${count} characters.`;
}

function renderMarkdownOutput(
  markdown: string,
  options: MarkdownOptions,
): JSX.Element {
  const truncated = truncateNotebookText(markdown);
  return (
    <>
      {markdownContent(truncated.text, options)}
      {truncated.truncated ? (
        <p
          className="text-xs fg-secondary"
          data-testid="notebook-text-truncated"
        >
          {textTruncatedNote('Output')}
        </p>
      ) : null}
    </>
  );
}

function renderOutputContent(
  output: NotebookOutput,
  options: MarkdownOptions,
): JSX.Element | null {
  if (output.outputType === 'stream') {
    const truncated = truncateNotebookText(output.text);
    const stderr = output.name === 'stderr';
    return (
      <>
        <CodeBlock
          data-stream={output.name}
          variant={stderr ? 'warning' : 'bare'}
          tone={stderr ? 'warning' : 'soft'}
          replay="inherit"
        >
          {truncated.text}
        </CodeBlock>
        {truncated.truncated ? (
          <p
            className="text-xs fg-secondary"
            data-testid="notebook-text-truncated"
          >
            {textTruncatedNote('Output')}
          </p>
        ) : null}
      </>
    );
  }

  if (output.outputType === 'error') {
    const fallback = [output.ename, output.evalue]
      .filter((part) => part.length > 0)
      .join(': ');
    const errorText =
      output.traceback.trim().length > 0 ? output.traceback : fallback;
    const truncated = truncateNotebookText(errorText);
    return (
      <>
        <CodeBlock variant="bare" tone="destructive" replay="inherit">
          {truncated.text}
        </CodeBlock>
        {truncated.truncated ? (
          <p
            className="text-xs fg-secondary"
            data-testid="notebook-text-truncated"
          >
            {textTruncatedNote('Output')}
          </p>
        ) : null}
      </>
    );
  }

  const rendering = selectNotebookOutputRendering(output.data);
  if (rendering === null) return null;

  if (rendering.kind === 'image') {
    return (
      <img
        data-testid="notebook-output-image"
        src={rendering.src}
        alt="Cell output"
        className="max-w-full"
      />
    );
  }

  if (rendering.kind === 'text') {
    const truncated = truncateNotebookText(rendering.text);
    return (
      <>
        <CodeBlock variant="bare" tone="soft" replay="inherit">
          {truncated.text}
        </CodeBlock>
        {truncated.truncated ? (
          <p
            className="text-xs fg-secondary"
            data-testid="notebook-text-truncated"
          >
            {textTruncatedNote('Output')}
          </p>
        ) : null}
      </>
    );
  }

  if (rendering.kind === 'markdown') {
    return renderMarkdownOutput(rendering.markdown, options);
  }

  const latex = output.data['text/latex'];
  const truncated = truncateNotebookText(latex ?? rendering.markdown);
  const mathMarkdown = truncated.truncated
    ? latexOutputMarkdown(truncated.text)
    : rendering.markdown;
  return (
    <>
      {mathMarkdown.length > 0 ? markdownContent(mathMarkdown, options) : null}
      {truncated.truncated ? (
        <p
          className="text-xs fg-secondary"
          data-testid="notebook-text-truncated"
        >
          {textTruncatedNote('Output')}
        </p>
      ) : null}
    </>
  );
}

function NotebookOutputView({
  output,
  options,
}: NotebookOutputProps): JSX.Element {
  return (
    <div data-testid="notebook-output" data-output-type={output.outputType}>
      {renderOutputContent(output, options)}
    </div>
  );
}

function attachmentName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function MarkdownCell({
  source,
  options,
  attachments,
  onOpenRelativePath,
  resolveAssetSrc,
}: MarkdownCellProps): JSX.Element {
  const truncated = truncateNotebookText(source);
  const resolveAttachmentSrc = useMemo(
    () =>
      attachments === undefined
        ? undefined
        : (name: string): string | undefined =>
            attachments.get(name) ?? attachments.get(attachmentName(name)),
    [attachments],
  );
  const attachmentOptions = useFileMarkdownOptions(
    onOpenRelativePath,
    resolveAssetSrc,
    resolveAttachmentSrc,
  );
  return (
    <>
      {markdownContent(
        truncated.text,
        attachments === undefined ? options : attachmentOptions,
      )}
      {truncated.truncated ? (
        <p
          className="text-xs fg-secondary"
          data-testid="notebook-text-truncated"
        >
          {textTruncatedNote('Cell')}
        </p>
      ) : null}
    </>
  );
}

function CodeCell({ cell, language, options }: CodeCellProps): JSX.Element {
  const source = truncateNotebookText(cell.source);
  const outputs = cell.outputs.slice(0, MAX_NOTEBOOK_OUTPUTS_PER_CELL);
  const outputCount = cell.outputs.length;
  const outputsTruncated = outputCount > outputs.length;

  return (
    <>
      {language !== null || cell.executionCount !== null ? (
        <div className="flex items-center gap-3 text-xs fg-secondary">
          {language !== null ? (
            <span data-testid="notebook-code-language">{language}</span>
          ) : null}
          {cell.executionCount !== null ? (
            <span data-testid="notebook-execution-count">
              [{cell.executionCount}]
            </span>
          ) : null}
        </div>
      ) : null}
      {markdownContent(codeFenceMarkdown(source.text, language), options)}
      {source.truncated ? (
        <p
          className="text-xs fg-secondary"
          data-testid="notebook-text-truncated"
        >
          {textTruncatedNote('Cell')}
        </p>
      ) : null}
      {outputs.length > 0 ? (
        <Stack gap="inline">
          {outputs.map((output, index) => (
            <NotebookOutputView
              key={`output-${index}`}
              output={output}
              options={options}
            />
          ))}
          {outputsTruncated ? (
            <p
              className="text-xs fg-secondary"
              data-testid="notebook-limit-note"
            >
              Showing the first{' '}
              {MAX_NOTEBOOK_OUTPUTS_PER_CELL.toLocaleString('en-US')} of{' '}
              {outputCount.toLocaleString('en-US')} outputs.
            </p>
          ) : null}
        </Stack>
      ) : null}
    </>
  );
}

function NotebookCellView({
  cell,
  language,
  options,
  onOpenRelativePath,
  resolveAssetSrc,
}: NotebookCellProps): JSX.Element {
  return (
    <Stack
      gap="inline"
      className="min-w-0"
      data-testid="notebook-cell"
      data-cell-type={cell.cellType}
    >
      {cell.cellType === 'markdown' ? (
        <MarkdownCell
          source={cell.source}
          options={options}
          attachments={cell.attachments}
          onOpenRelativePath={onOpenRelativePath}
          resolveAssetSrc={resolveAssetSrc}
        />
      ) : cell.cellType === 'code' ? (
        <CodeCell cell={cell} language={language} options={options} />
      ) : (
        <RawCell source={cell.source} />
      )}
    </Stack>
  );
}

function RawCell({ source }: { readonly source: string }): JSX.Element {
  const truncated = truncateNotebookText(source);
  return (
    <>
      <CodeBlock variant="bare" tone="soft" replay="inherit">
        {truncated.text}
      </CodeBlock>
      {truncated.truncated ? (
        <p
          className="text-xs fg-secondary"
          data-testid="notebook-text-truncated"
        >
          {textTruncatedNote('Cell')}
        </p>
      ) : null}
    </>
  );
}

function NotebookViewImpl({
  notebook,
  onOpenRelativePath,
  resolveAssetSrc,
  scrollBinding,
}: NotebookViewProps): JSX.Element {
  const options = useFileMarkdownOptions(onOpenRelativePath, resolveAssetSrc);
  const cells = notebook.cells.slice(0, MAX_NOTEBOOK_RENDERED_CELLS);

  return (
    <div
      ref={scrollBinding?.ref}
      onScroll={scrollBinding?.onScroll}
      onLoadCapture={scrollBinding?.onContentLoaded}
      className={`${REPLAY_BLOCK_CLASS} min-h-0 flex-1 overflow-auto`}
      data-testid="file-notebook-preview"
    >
      <div className="min-w-0 flex flex-col gap-8 px-6 py-6">
        {cells.map((cell, index) => (
          <NotebookCellView
            key={`cell-${index}`}
            cell={cell}
            language={notebook.language}
            options={options}
            onOpenRelativePath={onOpenRelativePath}
            resolveAssetSrc={resolveAssetSrc}
          />
        ))}
        {notebook.cells.length > cells.length ? (
          <p className="text-xs fg-secondary" data-testid="notebook-limit-note">
            Showing the first{' '}
            {MAX_NOTEBOOK_RENDERED_CELLS.toLocaleString('en-US')} of{' '}
            {notebook.cells.length.toLocaleString('en-US')} cells. Switch to
            Source to see the rest.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export const NotebookView: MemoExoticComponent<
  (props: NotebookViewProps) => JSX.Element
> = memo(NotebookViewImpl);
