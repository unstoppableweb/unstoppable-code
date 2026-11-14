import { useState, type JSX } from 'react';
import { DialogModal } from '@/components/shared/DialogModal';
import { brandText } from '@/lib/brand';
import {
  useImportProjectsModalStore,
  type ImportProjectsModalTarget,
} from '@/stores/importProjectsModalStore';
import {
  ImportProjectsPanel,
  type ImportProjectsPhase,
} from './ImportProjectsPanel';

interface ImportProjectsModalProps {
  target: ImportProjectsModalTarget;
  onClose: () => void;
}

function subtitleForPhase(phase: ImportProjectsPhase): string {
  switch (phase) {
    case 'scanning':
      // The panel's status line names the tools; one home for that fact.
      return 'Reading local project records';
    case 'choose':
      return `Choose what to bring into ${brandText.appName}`;
    case 'importing':
      return 'Adding projects and chats';
    case 'results':
      return 'Imported projects are in the sidebar';
    case 'error':
      return 'Something went wrong';
  }
}

/** Modal chrome for the bulk project import flow (CAN-2439). */
export function ImportProjectsModal({
  target,
  onClose,
}: ImportProjectsModalProps): JSX.Element {
  const [phase, setPhase] = useState<ImportProjectsPhase>('scanning');
  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title="Import projects"
      subtitle={subtitleForPhase(phase)}
      maxWidth="2xl"
      closeOnBackdrop={phase !== 'importing'}
      showCloseButton={phase !== 'importing'}
      dataTestId="import-projects-modal"
    >
      {/* DialogModal pads only its header; the body inset matches it. */}
      <div className="p-6">
        <ImportProjectsPanel
          {...(target.providers ? { providers: target.providers } : {})}
          modalEntry={target.source}
          onSkip={onClose}
          onDone={onClose}
          onPhaseChange={(next): void => {
            setPhase(next);
            useImportProjectsModalStore.getState().setPhase(next);
          }}
        />
      </div>
    </DialogModal>
  );
}
