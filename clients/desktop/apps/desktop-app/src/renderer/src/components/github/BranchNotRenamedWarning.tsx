import { Stack, InlineCode } from '@canopy/ui-shared/components';
import type { JSX } from 'react';
import { Button } from '@canopy/ui-shared';
import { DialogModal } from '@/components/shared/DialogModal';
import type { UnrenamedRepo } from '@/lib/branchRenameWarning';
import { WarningIcon as AppCatalogWarningIcon } from '@canopy/ui-shared/icons/AppIcons';

interface BranchNotRenamedWarningProps {
  isMultiRepo: boolean;
  branchNames: string[];
  unrenamedRepos: UnrenamedRepo[];
  onContinue: () => void;
  onRename: () => void;
  onClose: () => void;
}

export function BranchNotRenamedWarning({
  isMultiRepo,
  branchNames,
  unrenamedRepos,
  onContinue,
  onRename,
  onClose,
}: BranchNotRenamedWarningProps): JSX.Element {
  const title = isMultiRepo ? 'Branches not renamed' : 'Branch not renamed';
  const uniqueBranchNames = Array.from(
    new Set(branchNames.map((name) => name.trim()).filter(Boolean)),
  );

  return (
    <DialogModal
      onClose={onClose}
      title={title}
      maxWidth="sm"
      dataTestId="branch-not-renamed-warning"
    >
      <Stack gap="block">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning-subtle">
            <AppCatalogWarningIcon
              size="xl"
              className="fg-warning"
              aria-hidden="true"
            />
          </div>
          <Stack gap="inline" className="min-w-0 flex-1">
            <p className="text-s fg-primary">
              {isMultiRepo
                ? 'Some branches have not been renamed from the default worktree name. You may want to rename them before pushing or creating a pull request.'
                : 'The branch has not been renamed from the default worktree name. You may want to rename it before pushing or creating a pull request.'}
            </p>
            {uniqueBranchNames.length === 1 && (
              <p className="text-xs fg-secondary">
                <InlineCode>{uniqueBranchNames[0]}</InlineCode>
              </p>
            )}
            {uniqueBranchNames.length > 1 && (
              <ul className="flex flex-col gap-1">
                {uniqueBranchNames.map((branchName) => (
                  <li key={branchName} className="text-xs">
                    <InlineCode>{branchName}</InlineCode>
                  </li>
                ))}
              </ul>
            )}
            {isMultiRepo && unrenamedRepos.length > 0 && (
              <ul className="flex flex-col gap-0.5">
                {unrenamedRepos.map((repo) => (
                  <li key={repo.repoId} className="text-xs fg-secondary">
                    {repo.repoName}
                  </li>
                ))}
              </ul>
            )}
          </Stack>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="compact" onClick={onRename}>
            {isMultiRepo ? 'Rename branches' : 'Rename branch'}
          </Button>
          <Button variant="destructive" size="compact" onClick={onContinue}>
            Continue anyway
          </Button>
        </div>
      </Stack>
    </DialogModal>
  );
}
