import type { JSX } from 'react';
import {
  CreditsRecoveryNotice,
  NoticeButton,
  OUT_OF_CREDITS_TITLE,
  retainedMessageCopy,
} from '@canopy/ui-shared/components';
import { SpecimenCell, SpecimenPanel } from './componentsLabParts';

const noop = (): void => undefined;

/** The in-chat out-of-credits recovery notice in each arm a host chooses. */
export function CreditsNoticesSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="CreditsRecoveryNotice">
        <SpecimenCell
          label="Purchase arm: the message, a retained-message line and the action"
          wide
        >
          <div className="w-full">
            <CreditsRecoveryNotice
              intent="attention"
              title={OUT_OF_CREDITS_TITLE}
              role="none"
              detailLines={[retainedMessageCopy('composer')]}
              actions={
                <>
                  <NoticeButton variant="secondary">Try again</NoticeButton>
                  <NoticeButton variant="primary">Add credits</NoticeButton>
                </>
              }
            >
              Add credits to keep going.
            </CreditsRecoveryNotice>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Member arm: no purchase, ask an org admin" wide>
          <div className="w-full">
            <CreditsRecoveryNotice
              intent="attention"
              title={OUT_OF_CREDITS_TITLE}
              role="none"
              detailLines={[retainedMessageCopy('queue')]}
              contactAdmin
              onDismiss={noop}
            >
              Your spend quota is used up.
            </CreditsRecoveryNotice>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Contact-admin line only" wide>
          <div className="w-full">
            <CreditsRecoveryNotice intent="attention" role="none" contactAdmin>
              You can't add credits yourself.
            </CreditsRecoveryNotice>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Several detail lines, one per line" wide>
          <div className="w-full">
            <CreditsRecoveryNotice
              intent="destructive"
              errorSource="preview-credit-recovery-send"
              title="Message not sent"
              role="none"
              detailLines={[
                retainedMessageCopy('create'),
                'Credits refill tomorrow at 9:00 AM.',
              ]}
            >
              The turn failed before it started.
            </CreditsRecoveryNotice>
          </div>
        </SpecimenCell>
        <SpecimenCell label="No detail: the plain notice" wide>
          <div className="w-full">
            <CreditsRecoveryNotice intent="neutral" role="none">
              Credits are paused for this workspace.
            </CreditsRecoveryNotice>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Long text wraps" wide>
          <div className="w-full max-w-md">
            <CreditsRecoveryNotice
              intent="attention"
              title={OUT_OF_CREDITS_TITLE}
              role="none"
              detailLines={[
                `${retainedMessageCopy('composer')} ${'It stays here until you send it. '.repeat(4)}`,
              ]}
              contactAdmin
            >
              {'Your organization has used its monthly credit allowance. '.repeat(
                2,
              )}
            </CreditsRecoveryNotice>
          </div>
        </SpecimenCell>
      </SpecimenPanel>
    </div>
  );
}
