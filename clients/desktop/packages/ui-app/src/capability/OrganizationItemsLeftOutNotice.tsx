import { Fragment, useState, type JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';

/** An organization skill or plugin a chat picked that its project no longer shares. */
export interface OrganizationItemLeftOut {
  /** Stable identity of the picked ref. */
  readonly key: string;
  /** The item's name. */
  readonly name: string;
}

export interface OrganizationItemsLeftOutNoticeProps {
  /** The chat's organization picks that no longer load (CAN-6240). */
  readonly items: readonly OrganizationItemLeftOut[];
  /** Takes them out of the chat's picks; rejects when it couldn't. */
  readonly onRemove: () => Promise<void>;
}

/** `Review`, `Review and Lint`, `Review, Lint and Deploy`. */
function ItemList({
  items,
}: {
  items: readonly OrganizationItemLeftOut[];
}): JSX.Element {
  const last = items.length - 1;
  return (
    <>
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {index === 0 ? '' : index === last ? ' and ' : ', '}
          {item.name}
        </Fragment>
      ))}
    </>
  );
}

/**
 * Names the organization skills and plugins this chat picked that its
 * project no longer shares, so they stopped loading (CAN-6240), with a
 * button to take them out of the chat. Hidden for this view once dismissed.
 */
export function OrganizationItemsLeftOutNotice({
  items,
  onRemove,
}: OrganizationItemsLeftOutNoticeProps): JSX.Element | null {
  const [removing, setRemoving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const itemsKey = items.map((item) => item.key).join('\u0000');
  if (items.length === 0 || dismissedKey === itemsKey) return null;
  const remove = (): void => {
    setRemoving(true);
    setFailed(false);
    void onRemove()
      .catch((): void => setFailed(true))
      .finally((): void => setRemoving(false));
  };
  return (
    <Notice
      title="Organization items no longer load"
      actions={
        <NoticeButton
          busy={removing}
          onClick={remove}
          data-testid="organization-items-left-out-remove"
        >
          Remove from chat
        </NoticeButton>
      }
      onDismiss={(): void => setDismissedKey(itemsKey)}
      announceDetail
      {...(failed ? { detail: <>Couldn't remove them. Try again.</> } : {})}
      data-testid="organization-items-left-out-notice"
    >
      <ItemList items={items} /> {items.length === 1 ? 'isn’t' : 'aren’t'}{' '}
      shared with this project anymore, so{' '}
      {items.length === 1 ? 'it doesn’t' : 'they don’t'} load here.
    </Notice>
  );
}
