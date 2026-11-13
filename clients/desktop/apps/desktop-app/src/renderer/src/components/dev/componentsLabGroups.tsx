import type { JSX } from 'react';
import { ConfirmDialogSpecimen } from './componentsLabFeedback';
import { DialogSpecimen } from './componentsLabLayout';
import { FieldsPlayground, FieldsStatesGrid } from './FieldsLabPage';
import {
  BadgeSection,
  CountSection,
  DotSection,
  GlyphSection,
} from './MarkersLabPage';

/** Sheets that gather several specimens, for the components library. */
export function MarkersSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <BadgeSection />
      <CountSection />
      <DotSection />
      <GlyphSection />
    </div>
  );
}

export function DialogsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <DialogSpecimen />
      <ConfirmDialogSpecimen />
    </div>
  );
}

export function FieldsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <FieldsStatesGrid />
      <FieldsPlayground />
    </div>
  );
}
