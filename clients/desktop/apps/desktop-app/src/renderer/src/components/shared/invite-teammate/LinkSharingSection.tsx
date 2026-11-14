import { Stack } from '@canopy/ui-shared/components';
import { type JSX, type ReactNode, useCallback, useRef, useState } from 'react';
import type { SharedContainerLinkAudience } from '@canopy/protocol/shared-containers';
import {
  ActionMenuRowStyle,
  Divider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  ErrorBanner,
  FloatingMenu,
  Heading,
  PickerTrigger,
  PickerTriggerChevron,
  Tooltip,
} from '@canopy/ui-shared/components';
import {
  BuildingIcon,
  Globe,
  Lock,
  RefreshIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { MoreHorizontalIcon } from '@canopy/ui-shared/icons';
import { Button } from '@canopy/ui-shared';
import {
  LinkSharingConfirmDialog,
  type LinkSharingConfirmVariant,
} from '@canopy/ui-app/sharing';
import {
  LINK_ANYONE_LABEL,
  LINK_MORE_OPTIONS_LABEL,
  LINK_OFF_DESCRIPTION,
  LINK_OFF_LABEL,
  LINK_SHARING_LABEL,
  RESET_LINK_LABEL,
  linkAnyoneDescription,
  linkExternalSharingOffHint,
  linkOrganizationDescription,
  linkOrganizationLabel,
} from './shareCopy';
import type { UseShareLinkResult } from './useShareLink';
import { openAccountOrganizationPage } from '@/lib/navigation/settings-destinations';

type LinkChoice = SharedContainerLinkAudience | 'off';

interface LinkOption {
  readonly value: LinkChoice;
  readonly label: string;
  readonly description: string;
  readonly icon: ReactNode;
  readonly disabled: boolean;
}

const TEST_ID = 'shared-container-invite-link';

function choiceTestId(choice: LinkChoice): string {
  return choice === 'off' ? 'off' : choice.toLowerCase();
}

export interface LinkSharingSectionProps {
  link: UseShareLinkResult;
  /** The owning organization; `null` for a personal container. */
  organizationName: string | null;
  /** Which link audiences this container may use. */
  availability: { anyone: boolean; organization: boolean };
  /**
   * True when the owning organization's policy is what keeps "Anyone with the
   * link" off, so the option explains itself instead of silently greying.
   */
  anyoneBlockedByPolicy: boolean;
  /**
   * The owning organization when the viewer can manage its policies (an
   * OWNER or ADMIN). With the policy blocking "Anyone with the link", the
   * hint then links to the organization's Policies. `onOpened` runs once
   * they opened inside Settings, so the host can close its modal.
   */
  policyLink?: { organizationId: string; onOpened?: () => void };
  /** Locks the controls while the parent commits another mutation. */
  disabled?: boolean;
  /** Rules the section off from the one above it. */
  separated?: boolean;
  /**
   * Publish status for the heading, used when there is no People with access
   * section to carry it (a link-only share).
   */
  status?: ReactNode;
  /** A publish problem the heading status cannot state, shown in the body. */
  issue?: ReactNode;
  ownerDocument?: Document;
}

/**
 * "Share with a link": Off, Anyone in <org> with the link, or Anyone with the
 * link. Sits below People with access. Anything that takes access away from
 * people who joined with the link asks first.
 */
export function LinkSharingSection({
  link,
  organizationName,
  availability,
  anyoneBlockedByPolicy,
  policyLink,
  disabled = false,
  separated = true,
  status,
  issue,
  ownerDocument,
}: LinkSharingSectionProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirm, setConfirm] = useState<{
    variant: LinkSharingConfirmVariant;
    run: () => Promise<boolean>;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);

  const current: LinkChoice = link.link?.audience ?? 'off';
  const locked = disabled || link.saving || link.loading;

  const options: LinkOption[] = [
    {
      value: 'off',
      label: LINK_OFF_LABEL,
      description: LINK_OFF_DESCRIPTION,
      icon: <Lock size="xl" />,
      disabled: false,
    },
    ...(organizationName
      ? [
          {
            value: 'ORGANIZATION' as const,
            label: linkOrganizationLabel(organizationName),
            description: linkOrganizationDescription(organizationName),
            icon: <BuildingIcon size="xl" />,
            disabled: !availability.organization,
          },
        ]
      : []),
    {
      value: 'ANYONE',
      label: LINK_ANYONE_LABEL,
      description: linkAnyoneDescription(organizationName),
      icon: <Globe size="xl" />,
      disabled: !availability.anyone,
    },
  ];
  const selected =
    options.find((option) => option.value === current) ?? options[0];

  const choose = useCallback(
    (next: LinkChoice): void => {
      setMenuOpen(false);
      if (next === current) return;
      const audience = next === 'off' ? null : next;
      const run = (): Promise<boolean> => link.setAudience(audience);
      if (next === 'off') {
        setConfirm({ variant: 'off', run });
      } else if (current === 'ANYONE' && next === 'ORGANIZATION') {
        setConfirm({ variant: 'narrow', run });
      } else {
        void run();
      }
    },
    [current, link],
  );

  const requestReset = useCallback((): void => {
    setMoreOpen(false);
    setConfirm({ variant: 'reset', run: link.reset });
  }, [link.reset]);

  const confirmPending = useCallback((): void => {
    if (!confirm) return;
    void (async (): Promise<void> => {
      await confirm.run();
      setConfirm(null);
    })();
  }, [confirm]);

  const hint =
    anyoneBlockedByPolicy && organizationName
      ? linkExternalSharingOffHint(organizationName)
      : null;

  return (
    <section className="flex flex-col gap-6" data-testid={TEST_ID}>
      {separated && <Divider className="" aria-hidden />}
      <Stack gap="inline">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <Heading level={3} variant="title">
            {LINK_SHARING_LABEL}
          </Heading>
          <div className="flex min-w-0 items-center gap-2">
            {status}
            {link.link && (
              <>
                <Tooltip label={LINK_MORE_OPTIONS_LABEL} suppressed={moreOpen}>
                  <Button
                    variant="ghost"
                    size="compact"
                    iconOnly
                    ref={moreRef}
                    aria-label={LINK_MORE_OPTIONS_LABEL}
                    aria-haspopup="menu"
                    aria-expanded={moreOpen}
                    disabled={locked}
                    onClick={() => setMoreOpen((open) => !open)}
                    data-testid={`${TEST_ID}-more`}
                  >
                    <MoreHorizontalIcon size="sm" />
                  </Button>
                </Tooltip>
                <FloatingMenu
                  open={moreOpen}
                  onOpenChange={setMoreOpen}
                  anchorRef={moreRef}
                  placement="bottom-right"
                  aria-label={LINK_MORE_OPTIONS_LABEL}
                  data-testid={`${TEST_ID}-more-menu`}
                >
                  <ActionMenuRowStyle>
                    <DropdownMenuItem
                      tone="destructive"
                      onClick={requestReset}
                      data-testid={`${TEST_ID}-reset`}
                    >
                      <DropdownMenuItemIcon>
                        <RefreshIcon />
                      </DropdownMenuItemIcon>
                      {RESET_LINK_LABEL}
                    </DropdownMenuItem>
                  </ActionMenuRowStyle>
                </FloatingMenu>
              </>
            )}
          </div>
        </div>
        {issue}
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-8 shrink-0 items-end">
            <span
              aria-hidden="true"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-subtle fg-secondary [&>svg]:!h-4 [&>svg]:!w-4"
              data-testid={`${TEST_ID}-icon`}
              data-audience={choiceTestId(current)}
            >
              {selected.icon}
            </span>
          </span>
          <div className="flex flex-col min-w-0 flex-1 gap-0.5">
            <PickerTrigger
              ref={triggerRef}
              variant="capsule"
              className="-ml-2.5 max-w-full"
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              aria-label={LINK_SHARING_LABEL}
              disabled={locked}
              onClick={() => setMenuOpen((open) => !open)}
              data-testid={`${TEST_ID}-audience`}
              data-value={choiceTestId(current)}
            >
              <span className="truncate fg-primary">{selected.label}</span>
              <PickerTriggerChevron open={menuOpen} />
            </PickerTrigger>
            <p
              className="text-xs fg-secondary"
              data-testid={`${TEST_ID}-description`}
            >
              {selected.description}
            </p>
          </div>
        </div>
        <FloatingMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          anchorRef={triggerRef}
          placement="bottom-left"
          interaction="listbox"
          role="listbox"
          aria-label={LINK_SHARING_LABEL}
          data-testid={`${TEST_ID}-options`}
        >
          {options.map((option) => (
            <DropdownMenuItem
              key={option.value}
              role="option"
              multiline
              selected={option.value === current}
              aria-selected={option.value === current}
              disabled={option.disabled}
              onClick={() => choose(option.value)}
              data-testid={`${TEST_ID}-option-${choiceTestId(option.value)}`}
            >
              <DropdownMenuItemIcon>{option.icon}</DropdownMenuItemIcon>
              <span className="min-w-0">
                <span className="block truncate">{option.label}</span>
                <span className="block truncate text-xs fg-secondary">
                  {option.description}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </FloatingMenu>
        {hint && (
          <p className="text-xs fg-secondary" data-testid={`${TEST_ID}-hint`}>
            {hint}
          </p>
        )}
        {hint && policyLink && (
          <Button
            className="self-start"
            variant="outline"
            size="compact"
            data-testid={`${TEST_ID}-manage-policy`}
            onClick={(): void => {
              const opened = openAccountOrganizationPage({
                scope: 'organization',
                organizationId: policyLink.organizationId,
                page: 'settings',
                subtab: 'policies',
              });
              if (opened === 'settings') policyLink.onOpened?.();
            }}
          >
            Manage sharing policy
          </Button>
        )}
        <ErrorBanner
          errorSource="link-sharing-section"
          className=""
          error={link.error}
          testId={`${TEST_ID}-error`}
        />
        {confirm && (
          <LinkSharingConfirmDialog
            variant={confirm.variant}
            organizationName={organizationName ?? ''}
            busy={link.saving}
            onCancel={() => setConfirm(null)}
            onConfirm={confirmPending}
            testIdPrefix="shared-container-invite"
            {...(ownerDocument ? { ownerDocument } : {})}
          />
        )}
      </Stack>
    </section>
  );
}
