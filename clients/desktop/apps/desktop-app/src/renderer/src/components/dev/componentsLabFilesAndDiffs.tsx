import type { JSX } from 'react';
import {
  DiffLineCounts,
  DirectoryPickerOptionRow,
  FileRootGroupRow,
  GroupedDiffStats,
  PickerList,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

/**
 * Line counts, the root-group tree row and the working-directory option.
 * Pointer hover is real; point at a row to see it.
 */
export function FilesAndDiffsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="DiffLineCounts">
        <SpecimenGrid min={180}>
          <SpecimenCell label="Insertions and deletions">
            <DiffLineCounts insertions={128} deletions={37} />
          </SpecimenCell>
          <SpecimenCell label="Insertions only">
            <DiffLineCounts insertions={12} deletions={0} />
          </SpecimenCell>
          <SpecimenCell label="Deletions only">
            <DiffLineCounts insertions={0} deletions={9} />
          </SpecimenCell>
          <SpecimenCell label="Neither: renders nothing (mode-only change)">
            <DiffLineCounts insertions={0} deletions={0} />
            <span className="text-2xs fg-tertiary">(nothing renders)</span>
          </SpecimenCell>
          <SpecimenCell label='size="compact" (diff trees)'>
            <DiffLineCounts insertions={128} deletions={37} size="compact" />
          </SpecimenCell>
          <SpecimenCell label='tone="strong"'>
            <DiffLineCounts insertions={128} deletions={37} tone="strong" />
          </SpecimenCell>
          <SpecimenCell label="Large counts">
            <DiffLineCounts insertions={123456} deletions={98765} />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="GroupedDiffStats">
        <SpecimenGrid min={180}>
          <SpecimenCell label="Thousands separators, tabular">
            <GroupedDiffStats insertions={2674} deletions={963} />
          </SpecimenCell>
          <SpecimenCell label='numerals="proportional"'>
            <GroupedDiffStats
              insertions={2674}
              deletions={963}
              numerals="proportional"
            />
          </SpecimenCell>
          <SpecimenCell label="Insertions only">
            <GroupedDiffStats insertions={40} deletions={0} />
          </SpecimenCell>
          <SpecimenCell label="Deletions only">
            <GroupedDiffStats insertions={0} deletions={40} />
          </SpecimenCell>
          <SpecimenCell label="No changes: empty">
            <GroupedDiffStats insertions={0} deletions={0} />
            <span className="text-2xs fg-tertiary">(nothing renders)</span>
          </SpecimenCell>
          <SpecimenCell label="Seven digits">
            <GroupedDiffStats insertions={1234567} deletions={7654321} />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="FileRootGroupRow">
        <SpecimenGrid min={240}>
          <SpecimenCell label="Tree, collapsed">
            <div
              className="w-full"
              role="tree"
              aria-label="Collapsed root group"
            >
              <FileRootGroupRow
                label="App files"
                expanded={false}
                onToggle={noop}
                nodeId="lab-group-collapsed"
                dataTestId="lab-file-root-collapsed"
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Tree, expanded">
            <div
              className="w-full"
              role="tree"
              aria-label="Expanded root group"
            >
              <FileRootGroupRow
                label="App files"
                expanded
                onToggle={noop}
                nodeId="lab-group-expanded"
                dataTestId="lab-file-root-expanded"
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Tree, selected">
            <div
              className="w-full"
              role="tree"
              aria-label="Selected root group"
            >
              <FileRootGroupRow
                label="App files"
                expanded
                selected
                onToggle={noop}
                nodeId="lab-group-selected"
                dataTestId="lab-file-root-selected"
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Tree, nested one level">
            <div className="w-full" role="tree" aria-label="Nested root group">
              <FileRootGroupRow
                label="App files"
                expanded
                depth={1}
                onToggle={noop}
                nodeId="lab-group-nested"
                dataTestId="lab-file-root-nested"
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Tree, long label truncates">
            <div className="w-56" role="tree" aria-label="Long root group">
              <FileRootGroupRow
                label="A group named something very long indeed"
                expanded={false}
                onToggle={noop}
                nodeId="lab-group-long"
                dataTestId="lab-file-root-long"
              />
            </div>
          </SpecimenCell>
          <SpecimenCell label="Root switcher, collapsed">
            <FileRootGroupRow
              label="App files"
              expanded={false}
              onToggle={noop}
              nodeId="lab-switcher-collapsed"
              presentation="switcher"
              dataTestId="lab-file-root-switcher-collapsed"
            />
          </SpecimenCell>
          <SpecimenCell label="Root switcher, expanded">
            <FileRootGroupRow
              label="App files"
              expanded
              onToggle={noop}
              nodeId="lab-switcher-expanded"
              presentation="switcher"
              dataTestId="lab-file-root-switcher-expanded"
            />
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>

      <SpecimenPanel title="DirectoryPickerOptionRow">
        <SpecimenGrid min={260}>
          <SpecimenCell label="Unselected and selected">
            <PickerList aria-label="Working directories" className="w-full">
              <DirectoryPickerOptionRow
                name="apps/desktop-app"
                selected={false}
                onSelect={noop}
                data-testid="lab-directory-option-unselected"
              />
              <DirectoryPickerOptionRow
                name="apps/web"
                selected
                onSelect={noop}
                data-testid="lab-directory-option-selected"
              />
            </PickerList>
          </SpecimenCell>
          <SpecimenCell label="Long path truncates">
            <PickerList aria-label="Long working directory" className="w-56">
              <DirectoryPickerOptionRow
                name="packages/ui-shared/src/components/settings/some/deeply/nested/folder"
                selected={false}
                onSelect={noop}
                data-testid="lab-directory-option-long"
              />
            </PickerList>
          </SpecimenCell>
        </SpecimenGrid>
      </SpecimenPanel>
    </div>
  );
}
