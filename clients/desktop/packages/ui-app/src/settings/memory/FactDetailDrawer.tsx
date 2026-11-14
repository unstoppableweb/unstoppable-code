'use client';

import type { JSX, ReactNode } from 'react';
import { Stack, Button, Heading } from '@canopy/ui-shared/components';
import { X } from '@canopy/ui-shared/icons/AppIcons';
import type { ExplorerFactDetail } from '@canopy/protocol/settings/organization-memory';
import { withPrivacyClass } from '../account/privacy-class';
import { SettingsLink, useSettingsPrivacy } from '../host';
import { Surface } from '@canopy/ui-shared/components';
import { Badge } from '@canopy/ui-shared/components/Badge';

interface FactDetailDrawerProps {
  orgId: string;
  detail: ExplorerFactDetail;
  onClose?: () => void;
  embedded?: boolean;
}

export function FactDetailDrawer({
  orgId,
  detail,
  onClose,
  embedded = false,
}: FactDetailDrawerProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  return (
    <CardIfEmbedded embedded={embedded}>
      <aside
        className={embedded ? 'p-5' : 'h-full overflow-y-auto p-5'}
        aria-label="Memory fact detail"
      >
        <Stack gap="block">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge tone={detail.liveness === 'live' ? 'success' : 'warning'}>
                {detail.liveness === 'live' ? 'LIVE' : 'SUPERSEDED'}
              </Badge>
              <Badge>{detail.evidenceType}</Badge>
            </div>
            {onClose !== undefined && (
              <Button
                type="button"
                variant="ghost"
                size="compact"
                iconOnly
                data-settings-control="dismiss"
                onClick={onClose}
                aria-label="Close fact detail"
              >
                <X size={18} />
              </Button>
            )}
          </div>

          <Stack gap="section">
            <Stack gap="inline">
              <Heading level={2} variant="section">
                Fact
              </Heading>
              <p
                className={withPrivacyClass(
                  'whitespace-pre-wrap text-s leading-6 fg-primary',
                  blockClassName,
                )}
              >
                {detail.factText}
              </p>
            </Stack>
            {detail.evidenceQuote !== null && (
              <Stack as="section" gap="inline">
                <Heading level={3} variant="title">
                  Evidence
                </Heading>
                <blockquote
                  className={withPrivacyClass(
                    'rounded-lg border-l-2 border-line-accent bg-accent/5 px-4 py-3 text-s italic fg-secondary',
                    blockClassName,
                  )}
                >
                  “{detail.evidenceQuote}”
                </blockquote>
              </Stack>
            )}

            <Stack as="section" gap="inline">
              <Heading level={3} variant="title">
                Provenance
              </Heading>
              {detail.sources.length === 0 ? (
                <p className="text-s fg-secondary">No source rows recorded.</p>
              ) : (
                <Stack as="ul" gap="inline">
                  {detail.sources.map((source) => (
                    <Surface
                      as="li"
                      variant="inset"
                      padding="compact"
                      key={source.id}
                    >
                      <div className="text-xs fg-secondary">
                        <Stack gap="inline">
                          <Stack gap="tight">
                            <div
                              className={withPrivacyClass(
                                'font-medium fg-primary',
                                blockClassName,
                              )}
                            >
                              {source.actor?.name ??
                                source.actor?.email ??
                                'Unknown actor'}
                            </div>
                            <div>
                              {new Date(source.referenceTime).toLocaleString()}
                            </div>
                          </Stack>
                          <SettingsLink
                            className="self-start font-medium fg-accent hover:underline"
                            href={`/organization/${orgId}/memory/fact/${detail.id}?source=${source.id}`}
                          >
                            View source
                          </SettingsLink>
                        </Stack>
                      </div>
                    </Surface>
                  ))}
                </Stack>
              )}
            </Stack>

            {detail.supersessionChain.length > 1 && (
              <Stack as="section" gap="inline">
                <Heading level={3} variant="title">
                  Supersession chain
                </Heading>
                <ol className="border-l pl-4 flex flex-col gap-2">
                  {detail.supersessionChain.map((fact) => (
                    <li key={fact.id} className="relative text-xs fg-secondary">
                      <span className="absolute -left-4.75 top-1 h-2 w-2 rounded-full bg-fg-tertiary" />
                      <SettingsLink
                        href={`/organization/${orgId}/memory/fact/${fact.id}`}
                        className={withPrivacyClass(
                          'line-clamp-2 hover:fg-accent',
                          blockClassName,
                        )}
                      >
                        {fact.factText}
                      </SettingsLink>
                    </li>
                  ))}
                </ol>
              </Stack>
            )}
          </Stack>
        </Stack>
      </aside>
    </CardIfEmbedded>
  );
}

/** The drawer's own card when it sits in the page; the Sheet frames it otherwise. */
function CardIfEmbedded({
  embedded,
  children,
}: {
  readonly embedded: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return embedded ? (
    <Surface variant="card">{children}</Surface>
  ) : (
    <>{children}</>
  );
}
