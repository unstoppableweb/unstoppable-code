import { useContext, type JSX } from 'react';
import {
  FilesTreeRefreshButton,
  IconStyleProvider,
  LayoutTierContext,
  LayoutTierProvider,
  Markdown,
  MermaidExportProvider,
  useIconStyle,
  useLayoutTier,
  useMermaidExport,
  type IconStyle,
  type MermaidImageClipboard,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

const ICON_STYLES: readonly IconStyle[] = ['classic', 'central'];

function IconStyleReadout(): JSX.Element {
  return (
    <span className="text-xs fg-secondary">
      useIconStyle() = {useIconStyle()}
    </span>
  );
}

function LayoutTierReadout(): JSX.Element {
  const seed = useContext(LayoutTierContext);
  return (
    <span className="flex flex-col gap-0.5 text-xs fg-secondary">
      <span>seed = {seed ?? 'none'}</span>
      <span>useLayoutTier() = {useLayoutTier()}</span>
    </span>
  );
}

function ExportReadout(): JSX.Element {
  const { clipboard, destination } = useMermaidExport();
  return (
    <span className="flex flex-col gap-0.5 text-xs fg-secondary">
      <span>clipboard = {clipboard.status}</span>
      <span>destination = {destination.kind}</span>
    </span>
  );
}

const AVAILABLE_CLIPBOARD: MermaidImageClipboard = {
  status: 'available',
  write: () => Promise.resolve(),
};

const DIAGRAM =
  '```mermaid\nflowchart LR\n  A[Write] --> B[Review] --> C[Ship]\n```';

/**
 * The context providers that shared components read: the icon family, the
 * server-seeded layout tier and the Mermaid export services. Each is shown
 * through a live readout and the real component that consumes it.
 */
export function ProvidersSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="IconStyleProvider">
        <SpecimenGrid min={220}>
          {ICON_STYLES.map((style) => (
            <SpecimenCell key={style} label={`value="${style}"`}>
              <IconStyleProvider value={style}>
                <div className="flex flex-col gap-2">
                  <IconStyleReadout />
                  <FilesTreeRefreshButton onClick={noop} showTooltip={false} />
                </div>
              </IconStyleProvider>
            </SpecimenCell>
          ))}
          <SpecimenCell label="No provider: the classic family">
            <div className="flex flex-col gap-2">
              <IconStyleReadout />
              <FilesTreeRefreshButton onClick={noop} showTooltip={false} />
            </div>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel
        title="LayoutTierProvider"
        hint="A first-paint seed; the browser's own width wins"
      >
        <SpecimenGrid min={220}>
          {(['phone', 'tablet', 'desktop'] as const).map((tier) => (
            <SpecimenCell key={tier} label={`tier="${tier}"`}>
              <LayoutTierProvider tier={tier}>
                <LayoutTierReadout />
              </LayoutTierProvider>
            </SpecimenCell>
          ))}
          <SpecimenCell label="Unseeded">
            <LayoutTierProvider>
              <LayoutTierReadout />
            </LayoutTierProvider>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="MermaidExportProvider">
        <SpecimenGrid min={300}>
          <SpecimenCell label="Default services: clipboard unavailable, download only">
            <div className="flex w-full flex-col gap-3">
              <MermaidExportProvider>
                <ExportReadout />
                <Markdown>{DIAGRAM}</Markdown>
              </MermaidExportProvider>
            </div>
          </SpecimenCell>
          <SpecimenCell label="Clipboard available, download named for the document">
            <div className="flex w-full flex-col gap-3">
              <MermaidExportProvider
                clipboard={AVAILABLE_CLIPBOARD}
                destination={{ kind: 'download', documentName: 'plan.md' }}
                notify={noop}
              >
                <ExportReadout />
                <Markdown>{DIAGRAM}</Markdown>
              </MermaidExportProvider>
            </div>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
