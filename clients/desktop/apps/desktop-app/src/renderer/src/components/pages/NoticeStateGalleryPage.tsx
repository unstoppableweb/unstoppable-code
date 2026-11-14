import type { JSX } from 'react';
import {
  Surface,
  Stack,
  Heading,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared/components';
import { isNoticeStatesPageEnabled } from '@/components/sidebar/notice-states-page-flag';
import { NoticeComposerPreview } from './NoticeComposerPreview';
import { ToastTestBench } from './ToastTestBench';
import {
  NOTICE_GALLERY_SECTIONS,
  type NoticeGalleryEntry,
} from './noticeStateGalleryData';

/**
 * Reference page for every inline notice the app can raise, reachable from
 * the sidebar More menu in dev and E2E builds. Each row is the shared
 * `Notice` with the props the shipping component hands it (copy, intent,
 * actions, dismissal), so the family can be swept in one place with hot
 * reload while iterating. Buttons are inert.
 */

const INTENTS = ['neutral', 'attention', 'destructive', 'positive'] as const;

function GalleryNotice({ entry }: { entry: NoticeGalleryEntry }): JSX.Element {
  const actions = entry.actions?.length ? (
    <>
      {entry.aside}
      {entry.actions.map((action) => (
        <NoticeButton
          key={action.label}
          variant={action.variant ?? 'secondary'}
          disabled={action.disabled}
        >
          {action.label}
        </NoticeButton>
      ))}
    </>
  ) : (
    entry.aside
  );
  return (
    <Notice
      errorSource="state-gallery-page-entry"
      intent={entry.intent}
      {...(entry.icon !== undefined ? { icon: entry.icon } : {})}
      {...(entry.heading !== undefined ? { title: entry.heading } : {})}
      {...(entry.detail !== undefined ? { detail: entry.detail } : {})}
      {...(actions !== undefined ? { actions } : {})}
      {...(entry.actionsPlacement !== undefined
        ? { actionsPlacement: entry.actionsPlacement }
        : {})}
      {...(entry.dismissible
        ? { onDismiss: (): void => undefined, dismissLabel: 'Dismiss' }
        : {})}
      {...(entry.live === false ? { role: 'none' as const } : {})}
      data-testid={`notice-gallery-${entry.id}`}
    >
      {entry.message}
    </Notice>
  );
}

/**
 * Flag gate at the PAGE as well as the menu entry: `notice-states` stays in
 * the App Advisor navigation allowlist, so a packaged build could still be
 * navigated here by name. With the flag off the page renders a placeholder.
 */
export function NoticeStateGalleryPage(): JSX.Element {
  if (!isNoticeStatesPageEnabled()) {
    return (
      <Surface
        variant="pane"
        extent="parent"
        className="flex items-center justify-center"
        data-testid="notice-states-page-disabled"
      >
        <p className="text-xs fg-secondary">
          This page is a development-only reference and is not enabled in this
          build.
        </p>
      </Surface>
    );
  }
  return <NoticeStateGalleryContent />;
}

function NoticeStateGalleryContent(): JSX.Element {
  return (
    // The page sits inside `<main>`, which already scrolls; one constrained
    // scroller owns the overflow, as on the other state galleries.
    <Surface
      variant="pane"
      extent="parent"
      className="flex flex-col"
      data-testid="page-notice-states"
    >
      <header className="flex flex-col gap-1 px-8 pt-8 pb-4 fg-primary">
        <Heading level={1} variant="page">
          Notices — all states
        </Heading>
        <p className="max-w-3xl text-xs fg-secondary">
          The composer notices and the other notices that follow the title-first
          shape, rendered through the shared <code>Notice</code> with the copy
          and actions the real component passes; plain single-sentence notices
          elsewhere are not listed. Names, counts, and times in the copy are
          examples. Buttons do nothing here.
        </p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-12 overflow-y-auto px-8 pb-24 fg-primary [&>*]:shrink-0">
        <ToastTestBench />

        <NoticeComposerPreview
          renderNotice={(entry): JSX.Element => <GalleryNotice entry={entry} />}
        />

        <section
          className="flex flex-col gap-3"
          data-testid="notice-gallery-section-primitive"
        >
          <Stack gap="tight">
            <Heading className="" level={2} variant="title">
              Primitive
            </Heading>
            <p className="max-w-3xl text-xs fg-secondary">
              One surface for every intent; only the glyph ink changes. A short
              title in the primary ink leads the line and the message follows it
              in the tertiary ink. Trailing actions sit on that row; three or
              more drop to their own row aligned with the copy.
            </p>
          </Stack>
          <div className="flex max-w-3xl flex-col gap-2">
            {INTENTS.map((intent) => (
              <Notice
                errorSource="state-gallery-page"
                key={intent}
                intent={intent}
                onDismiss={(): void => undefined}
                actions={
                  <>
                    <NoticeButton>Alternative</NoticeButton>
                    <NoticeButton variant="primary">Recommended</NoticeButton>
                  </>
                }
                data-testid={`notice-gallery-intent-${intent}`}
              >
                {intent.charAt(0).toUpperCase() + intent.slice(1)} notice with a
                trailing action pair.
              </Notice>
            ))}
            <Notice
              intent="attention"
              title="A short title"
              detail="A detail line under the message, for post-action feedback only."
              actionsPlacement="below"
              onDismiss={(): void => undefined}
              actions={
                <>
                  <NoticeButton>First alternative</NoticeButton>
                  <NoticeButton>Second alternative</NoticeButton>
                  <NoticeButton variant="primary">Recommended</NoticeButton>
                </>
              }
              data-testid="notice-gallery-intent-below"
            >
              The message follows the title on the same line in the tertiary ink
              and wraps as one paragraph.
            </Notice>
          </div>
        </section>

        {NOTICE_GALLERY_SECTIONS.map((section) => (
          <section
            key={section.id}
            className="flex flex-col gap-3"
            data-testid={`notice-gallery-section-${section.id}`}
          >
            <Stack gap="tight">
              <Heading className="" level={2} variant="title">
                {section.title}
              </Heading>
              <p className="max-w-3xl text-xs fg-secondary">{section.note}</p>
            </Stack>
            <div className="flex max-w-3xl flex-col gap-6">
              {section.entries.map((entry) => (
                <div
                  key={entry.id}
                  data-testid={`notice-gallery-row-${entry.id}`}
                  className="flex flex-col gap-1.5"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-medium">{entry.title}</span>
                    {entry.note && (
                      <span className="text-2xs fg-secondary">
                        {entry.note}
                      </span>
                    )}
                  </div>
                  <GalleryNotice entry={entry} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Surface>
  );
}
