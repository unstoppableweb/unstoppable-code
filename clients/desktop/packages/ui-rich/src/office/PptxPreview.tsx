'use client';

import {
  DEFAULT_OFFICE_PREVIEW_COPY,
  type OfficePreviewCopy,
  type OfficePreviewRenderFailure,
} from './office-preview-copy';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
} from '@canopy/ui-shared/components';
import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import { parseOfficeDocument } from './office-parse-client';
import { OfficePreviewBanner } from './OfficePreviewBanner';
import type {
  PptxBox,
  PptxElement,
  PptxParseResult,
  PptxSlideModel,
  PptxTableCell,
  PptxTextBody,
} from './pptx-parse';
import { Surface } from '@canopy/ui-shared/components';

const EMU_PER_POINT = 12_700;
const SAFE_IMAGE_SRC =
  /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export interface PptxPreviewProps {
  readonly bytes: ArrayBuffer;
  readonly fileName: string;
  readonly createWorker: () => Worker;
  readonly copy?: OfficePreviewCopy;
  readonly onRenderFailure: (failure: OfficePreviewRenderFailure) => void;
}

type State =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly bytes: ArrayBuffer;
      readonly presentation: PptxParseResult;
    };

export function PptxPreview({
  bytes,
  fileName,
  createWorker,
  copy = DEFAULT_OFFICE_PREVIEW_COPY,
  onRenderFailure,
}: PptxPreviewProps): JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    void (async (): Promise<void> => {
      try {
        const result = await parseOfficeDocument(
          { kind: 'pptx', bytes },
          { createWorker, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (result.kind !== 'pptx') throw new Error('Unexpected parse result.');
        setState({ status: 'ready', bytes, presentation: result });
      } catch {
        if (!controller.signal.aborted) onRenderFailure('parse-failed');
      }
    })();
    return (): void => controller.abort();
  }, [bytes, createWorker, onRenderFailure]);

  if (state.status === 'loading' || state.bytes !== bytes) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="pptx-preview">
        <OfficePreviewBanner text={copy.banner} />
        <div
          className="flex min-h-0 flex-1 items-center justify-center"
          data-testid="pptx-preview-loading"
        >
          <DelayedLoadingPlaceholder>
            <CenteredLoadingSpinner className="my-12" />
          </DelayedLoadingPlaceholder>
        </div>
      </div>
    );
  }
  const { presentation } = state;
  const { slides, slideCount } = presentation;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="pptx-preview">
      <OfficePreviewBanner text={copy.banner} />
      {slideCount > slides.length && (
        <div
          role="status"
          className="shrink-0 border-b px-3 py-1.5 text-xs fg-secondary"
          data-testid="pptx-truncation-banner"
        >
          Showing the first {slides.length.toLocaleString('en-US')} of{' '}
          {slideCount.toLocaleString('en-US')} slides.
        </div>
      )}
      <Surface
        variant="well"
        className="min-h-0 flex-1 overflow-auto"
        data-testid="pptx-slides"
        data-selectable
        aria-label={`Slides in ${fileName}`}
        tabIndex={0}
      >
        {slides.length === 0 ? (
          <p
            className="p-6 text-center text-xs fg-secondary"
            data-testid="pptx-empty"
          >
            This presentation has no slides to preview.
          </p>
        ) : (
          <div className="mx-auto flex max-w-240 flex-col gap-6 p-6">
            {slides.map((slide) => (
              <SlideSection
                key={slide.number}
                slide={slide}
                slideCount={slideCount}
                width={presentation.slideWidth}
                height={presentation.slideHeight}
              />
            ))}
          </div>
        )}
      </Surface>
    </div>
  );
}

interface SlideGeometry {
  readonly width: number;
  readonly height: number;
}

/** Office's solid fills are resolved to hex or rgba by the parser. Match
 * selection to the document's own surface, independent of app appearance. */
function slideSelectionSurface(background = '#ffffff'): 'paper' | 'dark' {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(background);
  const channels = hex ?? /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(background);
  if (!channels) return 'paper';
  const radix = hex ? 16 : 10;
  const channel = (index: number): number =>
    Number.parseInt(channels[index] ?? '0', radix);
  const brightness =
    (channel(1) * 299 + channel(2) * 587 + channel(3) * 114) / 1000;
  return brightness >= 128 ? 'paper' : 'dark';
}

function SlideSection({
  slide,
  slideCount,
  width,
  height,
}: {
  readonly slide: PptxSlideModel;
  readonly slideCount: number;
  readonly width: number;
  readonly height: number;
}): JSX.Element {
  const geometry: SlideGeometry = { width, height };
  const backgroundImage =
    slide.backgroundImage !== undefined &&
    SAFE_IMAGE_SRC.test(slide.backgroundImage)
      ? `url("${slide.backgroundImage}")`
      : undefined;
  return (
    <section
      aria-label={`Slide ${slide.number} of ${slideCount}`}
      data-testid="pptx-slide"
      data-slide-number={slide.number}
      className="flex flex-col gap-2"
      style={{
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 540px',
      }}
    >
      <div className="flex items-center gap-2 text-xs fg-secondary">
        <span>Slide {slide.number}</span>
        {slide.hidden && (
          <Surface as="span" variant="outline" size="small">
            <span className="px-1.5" data-testid="pptx-slide-hidden">
              Hidden
            </span>
          </Surface>
        )}
      </div>
      <div
        className="relative w-full overflow-hidden border"
        data-testid="pptx-slide-canvas"
        data-selection-surface={slideSelectionSurface(slide.background)}
        style={{
          aspectRatio: `${width} / ${height}`,
          containerType: 'inline-size',
          backgroundColor: slide.background ?? '#ffffff',
          backgroundImage,
          backgroundSize: '100% 100%',
          color: '#000000',
        }}
      >
        {slide.elements.map((element, index) => (
          <SlideElement key={index} element={element} geometry={geometry} />
        ))}
      </div>
      {slide.elementsTruncated && (
        <p className="text-xs fg-secondary" data-testid="pptx-slide-truncated">
          Some content on this slide is not shown.
        </p>
      )}
      {slide.notes.length > 0 && (
        <Surface variant="outline" size="small" data-testid="pptx-slide-notes">
          <div className="flex flex-col gap-1 px-3 py-2 text-xs">
            <span className="font-medium fg-secondary">Speaker notes</span>
            {slide.notes.map((line, index) => (
              <p key={index} className="m-0 whitespace-pre-wrap fg-primary">
                {line}
              </p>
            ))}
          </div>
        </Surface>
      )}
    </section>
  );
}

function ratio(value: number, total: number): number {
  return Math.round((value / total) * 1_000_000) / 10_000;
}

function percent(value: number, total: number): string {
  return `${ratio(value, total)}%`;
}

/** Slide-relative length in container-query units, so it scales with width. */
function slideLength(emu: number, geometry: SlideGeometry): string {
  return `${ratio(emu, geometry.width)}cqw`;
}

function pointLength(points: number, geometry: SlideGeometry): string {
  return slideLength(points * EMU_PER_POINT, geometry);
}

function boxStyle(box: PptxBox, geometry: SlideGeometry): CSSProperties {
  return {
    position: 'absolute',
    left: percent(box.x, geometry.width),
    top: percent(box.y, geometry.height),
    width: percent(box.width, geometry.width),
    height: percent(box.height, geometry.height),
    transform: box.rotation === 0 ? undefined : `rotate(${box.rotation}deg)`,
    boxSizing: 'border-box',
  };
}

function SlideElement({
  element,
  geometry,
}: {
  readonly element: PptxElement;
  readonly geometry: SlideGeometry;
}): JSX.Element | null {
  switch (element.kind) {
    case 'shape':
      return (
        <div
          data-testid="pptx-shape"
          style={{
            ...boxStyle(element.box, geometry),
            backgroundColor: element.fill,
            border: element.stroke
              ? `max(1px, ${slideLength(element.stroke.width, geometry)}) solid ${element.stroke.color}`
              : undefined,
            borderRadius:
              element.geometry === 'ellipse'
                ? '50%'
                : element.geometry === 'roundRect'
                  ? slideLength(
                      Math.min(element.box.width, element.box.height) / 6,
                      geometry,
                    )
                  : undefined,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {element.text && <TextBody body={element.text} geometry={geometry} />}
        </div>
      );
    case 'image':
      return element.src !== undefined && SAFE_IMAGE_SRC.test(element.src) ? (
        <img
          src={element.src}
          alt={element.alt}
          draggable={false}
          data-testid="pptx-image"
          style={{ ...boxStyle(element.box, geometry), objectFit: 'fill' }}
        />
      ) : (
        <ContentPlaceholder
          box={element.box}
          geometry={geometry}
          label={
            element.alt ? `Image not shown: ${element.alt}` : 'Image not shown'
          }
        />
      );
    case 'line':
      return (
        <svg
          aria-hidden="true"
          data-testid="pptx-line"
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          preserveAspectRatio="none"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            overflow: 'visible',
            pointerEvents: 'none',
          }}
        >
          <line
            x1={element.x1}
            y1={element.y1}
            x2={element.x2}
            y2={element.y2}
            stroke={element.stroke.color}
            strokeWidth={Math.max(element.stroke.width, geometry.width / 1000)}
          />
        </svg>
      );
    case 'table':
      return <SlideTable element={element} geometry={geometry} />;
    case 'unsupported':
      return (
        <ContentPlaceholder
          box={element.box}
          geometry={geometry}
          label={`${element.label} not shown in preview`}
        />
      );
    default:
      return null;
  }
}

function ContentPlaceholder({
  box,
  geometry,
  label,
}: {
  readonly box: PptxBox;
  readonly geometry: SlideGeometry;
  readonly label: string;
}): JSX.Element {
  return (
    <div
      data-testid="pptx-unsupported"
      className="border border-dashed border-line-base"
      style={{
        ...boxStyle(box, geometry),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.04)',
        color: 'rgba(0, 0, 0, 0.6)',
        fontSize: pointLength(12, geometry),
        textAlign: 'center',
        overflow: 'hidden',
      }}
    >
      {label}
    </div>
  );
}

const JUSTIFY: Readonly<Record<PptxTextBody['anchor'], string>> = {
  top: 'flex-start',
  middle: 'center',
  bottom: 'flex-end',
};

function TextBody({
  body,
  geometry,
}: {
  readonly body: PptxTextBody;
  readonly geometry: SlideGeometry;
}): JSX.Element {
  const [left, top, right, bottom] = body.insets;
  return (
    <div
      data-testid="pptx-text"
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: JUSTIFY[body.anchor],
        flex: '1 1 auto',
        minHeight: 0,
        padding: `${slideLength(top, geometry)} ${slideLength(right, geometry)} ${slideLength(bottom, geometry)} ${slideLength(left, geometry)}`,
        whiteSpace: body.wrap ? 'pre-wrap' : 'pre',
        overflowWrap: 'break-word',
      }}
    >
      {body.paragraphs.map((paragraph, index) => (
        <p
          key={index}
          style={{
            margin: 0,
            marginTop: pointLength(paragraph.spaceBeforePt, geometry),
            marginBottom: pointLength(paragraph.spaceAfterPt, geometry),
            paddingLeft: slideLength(paragraph.indent, geometry),
            textAlign: paragraph.align,
            lineHeight: (paragraph.lineSpacing ?? 1) * 1.2,
            fontSize: pointLength(
              paragraph.runs[0]?.sizePt ?? paragraph.emptySizePt,
              geometry,
            ),
          }}
        >
          {paragraph.bullet !== undefined && (
            <span aria-hidden="true">{`${paragraph.bullet} `}</span>
          )}
          {paragraph.runs.length === 0
            ? ' '
            : paragraph.runs.map((run, runIndex) => (
                <span
                  key={runIndex}
                  style={{
                    fontSize: pointLength(run.sizePt, geometry),
                    fontWeight: run.bold ? 700 : undefined,
                    fontStyle: run.italic ? 'italic' : undefined,
                    textDecoration:
                      [
                        run.underline ? 'underline' : '',
                        run.strike ? 'line-through' : '',
                      ]
                        .filter((value) => value !== '')
                        .join(' ') || undefined,
                    color: run.color,
                    fontFamily:
                      run.fontFamily === undefined
                        ? undefined
                        : `"${run.fontFamily}", sans-serif`,
                  }}
                >
                  {run.text}
                </span>
              ))}
        </p>
      ))}
    </div>
  );
}

function SlideTable({
  element,
  geometry,
}: {
  readonly element: Extract<PptxElement, { kind: 'table' }>;
  readonly geometry: SlideGeometry;
}): JSX.Element {
  const totalWidth = element.columnWidths.reduce(
    (sum, width) => sum + width,
    0,
  );
  const columns =
    totalWidth > 0
      ? element.columnWidths
          .map((width) => percent(width, totalWidth))
          .join(' ')
      : `repeat(${Math.max(1, element.columnWidths.length)}, 1fr)`;
  return (
    <div
      data-testid="pptx-table"
      role="table"
      style={{
        ...boxStyle(element.box, geometry),
        height: 'auto',
        minHeight: percent(element.box.height, geometry.height),
        display: 'grid',
        gridTemplateColumns: columns,
        gridAutoRows: 'auto',
      }}
    >
      {element.rows.flatMap((row, rowIndex) =>
        row.cells.map((cell, columnIndex) =>
          cell === null ? null : (
            <TableCell
              key={`${rowIndex}:${columnIndex}`}
              cell={cell}
              row={rowIndex}
              column={columnIndex}
              minHeight={slideLength(row.height, geometry)}
              geometry={geometry}
            />
          ),
        ),
      )}
    </div>
  );
}

function TableCell({
  cell,
  row,
  column,
  minHeight,
  geometry,
}: {
  readonly cell: PptxTableCell;
  readonly row: number;
  readonly column: number;
  readonly minHeight: string;
  readonly geometry: SlideGeometry;
}): JSX.Element {
  return (
    <div
      role="cell"
      data-testid="pptx-table-cell"
      className="border border-line-base"
      style={{
        gridRow: `${row + 1} / span ${cell.rowSpan}`,
        gridColumn: `${column + 1} / span ${cell.colSpan}`,
        minHeight,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: cell.fill,
      }}
    >
      {cell.text && <TextBody body={cell.text} geometry={geometry} />}
    </div>
  );
}
