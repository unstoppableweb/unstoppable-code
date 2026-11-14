import type { JSX } from 'react';
import { InlineCode } from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const LONG_PATH =
  '/Users/someone/Library/Application Support/app/workspaces/a-project-with-a-long-name/worktrees/feature-branch';

/** InlineCode: a branch name or path inside a sentence, at the text's size. */
export function InlineCodeSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="In a sentence: takes the surrounding size and line height">
        <SpecimenGrid>
          <SpecimenCell label="Extra small text">
            <p className="text-xs fg-secondary">
              The branch <InlineCode>feature/inline-code</InlineCode> was not
              renamed.
            </p>
          </SpecimenCell>
          <SpecimenCell label="Small text">
            <p className="text-s fg-secondary">
              Existing data will remain in{' '}
              <InlineCode>~/projects/data</InlineCode>.
            </p>
          </SpecimenCell>
          <SpecimenCell label="Long path: wraps with the sentence" wide>
            <p className="max-w-80 text-xs fg-secondary">
              Data is stored in <InlineCode>{LONG_PATH}</InlineCode> because the
              primary folder is not present.
            </p>
          </SpecimenCell>
          <SpecimenCell label="On its own line">
            <p className="text-xs">
              <InlineCode>main</InlineCode>
            </p>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
