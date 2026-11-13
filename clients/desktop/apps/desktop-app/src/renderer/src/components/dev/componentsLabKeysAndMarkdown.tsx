import type { JSX } from 'react';
import {
  Button,
  KbdChip,
  Markdown,
  MarkdownImage,
  MarkdownImageUnavailable,
  MarkdownTableBlock,
  TRANSCRIPT_MARKDOWN_OPTIONS,
  TranscriptMarkdownAnchor,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

// Inline sources keep the lab off the network: one that renders, and one that
// is not a decodable image, so the browser fires `error` and the fallback shows.
const LOADED_IMAGE_SRC =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48"><rect width="96" height="48" rx="6" fill="#8884"/></svg>',
  );
const BROKEN_IMAGE_SRC = 'data:image/png;base64,AAAA';

/**
 * A button's own shortcut chip and the transcript markdown pieces: links that
 * navigate or stay inert, images and their unavailable fallback, and the
 * scrolling table frame.
 */
export function KeysAndMarkdownSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="KbdChip (a Button's shortcut)">
        <SpecimenGrid min={180}>
          <SpecimenCell label="Primary">
            <Button variant="primary" shortcut="⌘P" onClick={noop}>
              Open
            </Button>
          </SpecimenCell>
          <SpecimenCell label="Secondary">
            <Button shortcut="⌘P" onClick={noop}>
              Open
            </Button>
          </SpecimenCell>
          <SpecimenCell label="Destructive">
            <Button variant="destructive" shortcut="⌘⌫" onClick={noop}>
              Delete
            </Button>
          </SpecimenCell>
          <SpecimenCell label="Compact">
            <Button size="compact" shortcut="⌘K" onClick={noop}>
              Search
            </Button>
          </SpecimenCell>
          <SpecimenCell label="Disabled">
            <Button shortcut="⌘P" disabled onClick={noop}>
              Open
            </Button>
          </SpecimenCell>
          <SpecimenCell label="The chip alone, on the page ink">
            <KbdChip shortcut="⌘P" />
          </SpecimenCell>
          <SpecimenCell label="Long text shortcut">
            <Button shortcut="Ctrl Shift Alt Enter" onClick={noop}>
              Run everything
            </Button>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="TranscriptMarkdownAnchor">
        <SpecimenGrid min={240}>
          <SpecimenCell label="A navigable URL stays a link">
            <TranscriptMarkdownAnchor href="https://example.com/docs">
              Read the docs
            </TranscriptMarkdownAnchor>
          </SpecimenCell>
          <SpecimenCell label="In-page fragment">
            <TranscriptMarkdownAnchor href="#details">
              Jump to details
            </TranscriptMarkdownAnchor>
          </SpecimenCell>
          <SpecimenCell label="A filesystem path is inert dotted text (title shows it)">
            <TranscriptMarkdownAnchor href="/Users/me/notes/very/long/path/to/report.md">
              report.md
            </TranscriptMarkdownAnchor>
          </SpecimenCell>
          <SpecimenCell label="An unsafe scheme is inert">
            <TranscriptMarkdownAnchor href="javascript:void(0)">
              Click me
            </TranscriptMarkdownAnchor>
          </SpecimenCell>
          <SpecimenCell label="No target">
            <TranscriptMarkdownAnchor>Just text</TranscriptMarkdownAnchor>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="MarkdownImage">
        <SpecimenGrid min={240}>
          <SpecimenCell label="Loads">
            <MarkdownImage src={LOADED_IMAGE_SRC} alt="Build chart" />
          </SpecimenCell>
          <SpecimenCell label="Fails to load: the alt text stands in">
            <MarkdownImage src={BROKEN_IMAGE_SRC} alt="Build chart" />
          </SpecimenCell>
          <SpecimenCell label="Fails to load, no alt text">
            <MarkdownImage src={BROKEN_IMAGE_SRC} />
          </SpecimenCell>
          <SpecimenCell label="MarkdownImageUnavailable with alt text">
            <MarkdownImageUnavailable alt="Deploy diagram" />
          </SpecimenCell>
          <SpecimenCell label="MarkdownImageUnavailable, blank alt text">
            <MarkdownImageUnavailable alt="   " />
          </SpecimenCell>
          <SpecimenCell label="Through the transcript renderer" wide>
            <div className="w-full">
              <Markdown options={TRANSCRIPT_MARKDOWN_OPTIONS}>
                {`Before ![Build chart](${LOADED_IMAGE_SRC}) and after ![Missing chart](${BROKEN_IMAGE_SRC}).`}
              </Markdown>
            </div>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="MarkdownTableBlock">
        <SpecimenCell label="Fits: a small table" wide>
          <div className="w-full">
            <MarkdownTableBlock>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Qty</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Buttons</td>
                  <td>12</td>
                </tr>
                <tr>
                  <td>Rows</td>
                  <td>7</td>
                </tr>
              </tbody>
            </MarkdownTableBlock>
          </div>
        </SpecimenCell>
        <SpecimenCell
          label="Wide: scrolls inside a focusable group instead of widening the page"
          wide
        >
          <div className="w-80 max-w-full">
            <MarkdownTableBlock>
              <thead>
                <tr>
                  {Array.from({ length: 8 }, (_, index) => (
                    <th key={index}>Column {index + 1}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {Array.from({ length: 8 }, (_, index) => (
                    <td key={index}>A fairly long cell value {index + 1}</td>
                  ))}
                </tr>
              </tbody>
            </MarkdownTableBlock>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Through the transcript renderer" wide>
          <div className="w-full">
            <Markdown options={TRANSCRIPT_MARKDOWN_OPTIONS}>
              {
                '| Check | Result |\n| - | - |\n| Types | 0 errors |\n| Lint | passed |\n\nSee [the report](/Users/me/report.md) or [docs](https://example.com).'
              }
            </Markdown>
          </div>
        </SpecimenCell>
      </SpecimenPanel>
    </div>
  );
}
