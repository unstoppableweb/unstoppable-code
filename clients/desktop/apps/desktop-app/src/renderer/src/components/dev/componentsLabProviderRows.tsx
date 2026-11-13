import type { JSX } from 'react';
import { brandText } from '@/lib/brand';
import {
  ProviderRowLabel,
  ProviderStatusDot,
  RemoteControlMobileAppPromo,
  ResizeRailIndicator,
  ServerMarkdown,
  type MobileAppStoreLink,
  type ProviderStatusDotTone,
} from '@canopy/ui-shared/components';
import { ClaudeLogo, CodexLogo } from '@canopy/ui-shared/icons';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const DOT_STATES: readonly {
  tone: ProviderStatusDotTone;
  label: string;
  caption: string;
}[] = [
  { tone: 'connected', label: 'Connected', caption: 'connected' },
  { tone: 'failed', label: 'Sign-in failed', caption: 'failed' },
  { tone: 'limited', label: 'At usage limit', caption: 'limited' },
  { tone: 'pending', label: 'Signing in', caption: 'pending' },
  { tone: 'idle', label: 'Stopped', caption: 'idle' },
  { tone: 'signed-out', label: 'Not connected', caption: 'signed-out' },
];

/** ProviderRowLabel and ProviderStatusDot: every tone, no status, long name. */
export function ProviderRowLabelSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="ProviderRowLabel: mark, name and status dot">
        <SpecimenGrid min={220}>
          {DOT_STATES.map(({ tone, label, caption }) => (
            <SpecimenCell key={tone} label={caption}>
              <ProviderRowLabel
                icon={<ClaudeLogo width={16} height={16} aria-hidden="true" />}
                name="Claude"
                status={<ProviderStatusDot tone={tone} label={label} />}
              />
            </SpecimenCell>
          ))}
          <SpecimenCell label="No connection to report: no dot">
            <ProviderRowLabel
              icon={<CodexLogo width={16} height={16} aria-hidden="true" />}
              name="Codex"
            />
          </SpecimenCell>
          <SpecimenCell label="No mark">
            <ProviderRowLabel
              name="OpenCode"
              status={<ProviderStatusDot tone="connected" />}
            />
          </SpecimenCell>
          <SpecimenCell label="Long name shrinks inside its column" wide>
            <div className="w-48">
              <ProviderRowLabel
                icon={<ClaudeLogo width={16} height={16} aria-hidden="true" />}
                name={
                  <span className="min-w-0 truncate">
                    A provider with a very long display name
                  </span>
                }
                status={<ProviderStatusDot tone="limited" label="At limit" />}
              />
            </div>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}

const BADGE_SRC = (label: string): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="48" viewBox="0 0 144 48"><rect width="144" height="48" rx="8" fill="#111"/><text x="72" y="29" fill="#fff" font-family="sans-serif" font-size="13" text-anchor="middle">${label}</text></svg>`,
  )}`;

const APPLE: MobileAppStoreLink = {
  store: 'apple-app-store',
  url: 'https://apps.apple.com/app/example',
  badgeSrc: BADGE_SRC('App Store'),
};
const GOOGLE: MobileAppStoreLink = {
  store: 'google-play',
  url: 'https://play.google.com/store/apps/details?id=example',
  badgeSrc: BADGE_SRC('Google Play'),
};

const noop = (): void => undefined;

/** RemoteControlMobileAppPromo: both stores, one store, callback, hidden. */
export function RemoteControlPromoSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="Download offer inside a Remote Control panel">
      <SpecimenCell label="Both stores, badges as links (web)" wide>
        <div className="w-full max-w-xl">
          <RemoteControlMobileAppPromo
            brandDisplayName={brandText.appName}
            links={[APPLE, GOOGLE]}
            activation={{ kind: 'anchor' }}
            visible
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="Both stores, badges as buttons (desktop)" wide>
        <div className="w-full max-w-xl">
          <RemoteControlMobileAppPromo
            brandDisplayName={brandText.appName}
            links={[APPLE, GOOGLE]}
            activation={{ kind: 'callback', onActivate: noop }}
            visible
          />
        </div>
      </SpecimenCell>
      <SpecimenCell label="One store only" wide>
        <div className="w-full max-w-xl">
          <RemoteControlMobileAppPromo
            brandDisplayName={brandText.appName}
            links={[APPLE]}
            activation={{ kind: 'anchor' }}
            visible
          />
        </div>
      </SpecimenCell>
      <SpecimenCell
        label="Hidden, or with no store links, renders nothing"
        wide
      >
        <RemoteControlMobileAppPromo
          brandDisplayName={brandText.appName}
          links={[APPLE, GOOGLE]}
          activation={{ kind: 'anchor' }}
          visible={false}
        />
        <RemoteControlMobileAppPromo
          brandDisplayName={brandText.appName}
          links={[]}
          activation={{ kind: 'anchor' }}
          visible
        />
        <span className="text-2xs fg-tertiary">(nothing before this)</span>
      </SpecimenCell>
    </SpecimenPanel>
  );
}

function RailFrame({
  line,
  active,
}: {
  readonly line: 'vertical' | 'horizontal';
  readonly active: boolean;
}): JSX.Element {
  // The 8px handle the indicator sits in; `group` drives its hover look.
  return (
    <div
      className={`group flex items-stretch justify-center bg-tertiary ${
        line === 'vertical' ? 'h-24 w-2' : 'h-2 w-48 flex-col'
      }`}
    >
      <ResizeRailIndicator line={line} active={active} />
    </div>
  );
}

/** ResizeRailIndicator: rest, hover (live) and dragging, both directions. */
export function ResizeRailSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="The line inside a resize handle (hover a handle to see the accent)">
      <SpecimenGrid min={200}>
        <SpecimenCell label="Vertical, at rest">
          <RailFrame line="vertical" active={false} />
        </SpecimenCell>
        <SpecimenCell label="Vertical, resizing (accent, thick)">
          <RailFrame line="vertical" active />
        </SpecimenCell>
        <SpecimenCell label="Horizontal, at rest">
          <RailFrame line="horizontal" active={false} />
        </SpecimenCell>
        <SpecimenCell label="Horizontal, resizing (accent, thick)">
          <RailFrame line="horizontal" active />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

const MARKDOWN_SAMPLE = `# Release plan

A paragraph with **bold**, _emphasis_, \`inline code\` and a [link](https://example.com).

- First item
- Second item with a much longer line that wraps when the column is narrow enough to need it
  - A nested item

1. Numbered
2. Steps

> A quoted note.

\`\`\`ts
const message = 'a code block that is wider than its column should scroll sideways rather than wrap';
\`\`\`

| Name | Status |
| --- | --- |
| Build | Passing |
| Deploy | Waiting |
`;

/** ServerMarkdown: a full document, a narrow column and an empty one. */
export function ServerMarkdownSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="Markdown rendered without a client boundary">
      <SpecimenGrid min={320}>
        <SpecimenCell label="Full document">
          <div className="prose prose-sm w-full max-w-none">
            <ServerMarkdown>{MARKDOWN_SAMPLE}</ServerMarkdown>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Narrow column">
          <div className="prose prose-sm w-48 max-w-none break-words">
            <ServerMarkdown>{MARKDOWN_SAMPLE}</ServerMarkdown>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Empty renders nothing">
          <div className="min-h-4 w-full">
            <ServerMarkdown>{''}</ServerMarkdown>
          </div>
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}
