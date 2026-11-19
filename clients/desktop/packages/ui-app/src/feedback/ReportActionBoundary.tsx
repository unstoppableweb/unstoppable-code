'use client';

import { Component, type ReactNode } from 'react';
import { recordReportUnavailable } from '@canopy/ui-shared/lib';

/**
 * Keeps a failure in the reporting UI from reaching the recovery UI it sits
 * beside: it renders nothing rather than rethrowing into the parent boundary.
 * With the defect's `referenceId`, a repeated render failure records once per
 * defect.
 *
 * Its own module, so a panel importing it doesn't pull in the report form's
 * loader.
 */
export class ReportActionBoundary extends Component<
  {
    readonly children: ReactNode;
    readonly fallback?: ReactNode;
    readonly referenceId?: string;
  },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    recordReportUnavailable(this.props.referenceId);
  }

  override render(): ReactNode {
    return this.state.failed
      ? (this.props.fallback ?? null)
      : this.props.children;
  }
}
