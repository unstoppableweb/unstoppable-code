import type { JSX } from 'react';
import {
  AI_CREDITS_PURCHASE_LABEL,
  CreditsRecoveryNotice,
  NoticeButton,
  OUT_OF_CREDITS_TITLE,
  queuedMessageCopy,
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
          label="Purchase arm: the retained message and the action"
          wide
        >
          <div className="w-full">
            <CreditsRecoveryNotice
              intent="attention"
              title={OUT_OF_CREDITS_TITLE}
              role="none"
              actions={
                <>
                  <NoticeButton variant="secondary">Try again</NoticeButton>
                  <NoticeButton variant="primary">
                    {AI_CREDITS_PURCHASE_LABEL}
                  </NoticeButton>
                </>
              }
            >
              {retainedMessageCopy('composer')}
            </CreditsRecoveryNotice>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Member arm: no purchase, ask an org admin" wide>
          <div className="w-full">
            <CreditsRecoveryNotice
              intent="attention"
              title={OUT_OF_CREDITS_TITLE}
              role="none"
              contactAdmin
              onDismiss={noop}
            >
              {queuedMessageCopy({ orgFunds: true, chooseProvider: false })}
            </CreditsRecoveryNotice>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Contact-admin line only" wide>
          <div className="w-full">
            <CreditsRecoveryNotice intent="attention" role="none" contactAdmin>
              You can't buy credits yourself.
            </CreditsRecoveryNotice>
          </div>
        </SpecimenCell>
        <SpecimenCell label="Several detail sentences, one paragraph" wide>
          <div className="w-full">
            <CreditsRecoveryNotice
              intent="destructive"
              errorSource="preview-credit-recovery-send"
              title="Message not sent"
              role="none"
              detailLines={[
                retainedMessageCopy('create'),
                'Your balance is 0 AI Credits.',
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
