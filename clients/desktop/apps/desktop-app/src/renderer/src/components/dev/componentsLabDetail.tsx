import type { JSX } from 'react';
import {
  Button,
  DetailHeader,
  DetailMoreMenu,
  Notice,
  NoticeButton,
  type DetailMoreMenuItem,
} from '@canopy/ui-shared/components';
import {
  CopyIcon,
  PencilIcon,
  RefreshIcon,
  ShareIcon,
  TrashIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

const ICON = { width: 14, height: 14, 'aria-hidden': true } as const;

const MENU_ITEMS: readonly DetailMoreMenuItem[] = [
  {
    id: 'edit',
    label: 'Edit',
    icon: <PencilIcon {...ICON} />,
    testId: 'lab-more-edit',
    onSelect: noop,
  },
  {
    id: 'copy',
    label: 'Copy link',
    icon: <CopyIcon {...ICON} />,
    testId: 'lab-more-copy',
    onSelect: noop,
  },
  {
    id: 'delete',
    label: 'Delete',
    icon: <TrashIcon {...ICON} />,
    testId: 'lab-more-delete',
    onSelect: noop,
    destructive: true,
  },
];

const MENU_WITH_DISABLED: readonly DetailMoreMenuItem[] = [
  {
    id: 'update',
    label: 'Update',
    icon: <RefreshIcon {...ICON} />,
    testId: 'lab-more-update',
    onSelect: noop,
    disabled: true,
    reason: 'Already up to date.',
  },
  {
    id: 'share',
    label: 'Share',
    icon: <ShareIcon {...ICON} />,
    testId: 'lab-more-share',
    onSelect: noop,
  },
];

/**
 * A detail page's header and its ⋯ More menu. Open a menu to see its rows;
 * hover and focus on the trigger are real pointer and keyboard states.
 */
export function DetailHeaderSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="DetailHeader">
        <SpecimenCell label="Title, description, meta and actions" wide>
          <div className="w-full">
            <DetailHeader
              dataTestId="lab-detail-header-full"
              title="Review changes"
              description="Reads the diff, runs the checks and leaves a review."
              meta={['Created by you', 'Edited Oct 30', 'v1.2.0']}
              actions={
                <>
                  <DetailMoreMenu
                    name="Review changes"
                    items={MENU_ITEMS}
                    triggerTestId="lab-detail-header-more-trigger"
                    menuTestId="lab-detail-header-more-menu"
                    placement="bottom-right"
                  />
                  <Button size="compact">Share</Button>
                  <Button size="compact" variant="primary">
                    Use
                  </Button>
                </>
              }
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Title only" wide>
          <div className="w-full">
            <DetailHeader
              dataTestId="lab-detail-header-title"
              title="Review changes"
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="With the item's one notice under the header" wide>
          <div className="w-full">
            <DetailHeader
              dataTestId="lab-detail-header-notice"
              title="Deploy kit"
              description="Ships the current branch to staging."
              actions={
                <Button size="compact" variant="primary">
                  Update
                </Button>
              }
              notice={
                <Notice
                  intent="attention"
                  title="Update available"
                  role="none"
                  actions={
                    <NoticeButton variant="primary">Update</NoticeButton>
                  }
                >
                  Version 1.3.0 changes the deploy steps.
                </Notice>
              }
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Empty meta items are skipped" wide>
          <div className="w-full">
            <DetailHeader
              dataTestId="lab-detail-header-meta"
              title="Review changes"
              meta={['Created by you', '', null, false, 'v1.2.0']}
            />
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long title and many actions wrap" wide>
          <div className="w-full max-w-md">
            <DetailHeader
              dataTestId="lab-detail-header-long"
              title="A custom skill whose name is long enough to need two lines in a narrow column"
              description={'It keeps going. '.repeat(12)}
              meta={[
                'Created by you',
                'Edited Oct 30',
                'Shared to Platform',
                'v1.2.0',
                'Public link',
              ]}
              actions={
                <>
                  <Button size="compact">Edit</Button>
                  <Button size="compact">Share</Button>
                  <Button size="compact" variant="primary">
                    Use
                  </Button>
                </>
              }
            />
          </div>
        </SpecimenCell>
      </SpecimenPanel>

      <SpecimenPanel title="DetailMoreMenu" hint="Click the ⋯ to open">
        <SpecimenGrid min={200}>
          <SpecimenCell label="Secondary (default): actions, destructive last">
            <DetailMoreMenu
              name="Review changes"
              items={MENU_ITEMS}
              triggerTestId="lab-more-secondary-trigger"
              menuTestId="lab-more-secondary-menu"
            />
          </SpecimenCell>
          <SpecimenCell label='variant="ghost"'>
            <DetailMoreMenu
              name="Review changes"
              items={MENU_ITEMS}
              variant="ghost"
              triggerTestId="lab-more-ghost-trigger"
              menuTestId="lab-more-ghost-menu"
            />
          </SpecimenCell>
          <SpecimenCell label='placement="bottom-right"'>
            <DetailMoreMenu
              name="Review changes"
              items={MENU_ITEMS}
              placement="bottom-right"
              triggerTestId="lab-more-right-trigger"
              menuTestId="lab-more-right-menu"
            />
          </SpecimenCell>
          <SpecimenCell label="A disabled item shows its reason beneath">
            <DetailMoreMenu
              name="Review changes"
              items={MENU_WITH_DISABLED}
              triggerTestId="lab-more-disabled-trigger"
              menuTestId="lab-more-disabled-menu"
            />
          </SpecimenCell>
          <SpecimenCell label="No items: renders nothing">
            <DetailMoreMenu
              name="Review changes"
              items={[]}
              triggerTestId="lab-more-empty-trigger"
              menuTestId="lab-more-empty-menu"
            />
            <span className="text-2xs fg-tertiary">(nothing renders)</span>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
