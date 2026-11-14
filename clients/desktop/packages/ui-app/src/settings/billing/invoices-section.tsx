'use client';

// ---------------------------------------------------------------------------
// The "Invoices" block that sits above Transactions on BOTH billing surfaces.
//
// The personal (`account/billing-section.tsx`) and org
// (`team/team-billing-section.tsx`) surfaces differ only in how a page is
// fetched and how a detail href is built, so the load / cursor / "Load more" /
// error state machine is written ONCE here and both inject the two differences.
//
// Renders NOTHING when the first page comes back empty — invoices are derived
// from charges, so an account with no billing history has no section rather
// than an empty-state box.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import {
  BusyLabel,
  Button,
  ErrorBanner,
  InvoicesTable,
  type InvoicesTableInvoice,
} from '@canopy/ui-shared/components';
import type {
  InvoiceListItem,
  InvoicePage,
} from '@canopy/protocol/settings/billing';
import { SettingsLink, useSettingsHost, type SettingsLogger } from '../host';
import { logSettingsError } from '../errors';

/** "Load more" failed; the button stays to try again. */
export const INVOICES_LOAD_MORE_ERROR =
  "Couldn't load more invoices. Try again.";

/**
 * Page size both surfaces request. Matches the service `DEFAULT_LIMIT` — the
 * newest three billing periods, the first of which is the in-progress one.
 */
export const INVOICES_PAGE_LIMIT = 3;

export interface InvoicesSectionProps {
  /** Fetch one page. `cursor` is null for the first page. */
  loadPage: (cursor: string | null) => Promise<InvoicePage>;
  /** Detail-page href for a row. */
  hrefFor: (invoice: InvoicesTableInvoice) => string;
  /** Test id for the section wrapper (account vs. org). */
  testId?: string;
}

export function InvoicesSection({
  loadPage,
  hrefFor,
  testId = 'billing-invoices',
}: InvoicesSectionProps): JSX.Element | null {
  const [invoices, setInvoices] = useState<InvoiceListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const host = useSettingsHost();
  const log = useMemo(
    (): SettingsLogger => host.logger('billing:invoices'),
    [host],
  );

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const page = await loadPage(null);
        if (cancelled) return;
        setInvoices(page.invoices);
        setNextCursor(page.nextCursor);
      } catch (error) {
        if (cancelled) return;
        // A first-page failure leaves the section unrendered rather than
        // showing a broken shell above a working Transactions list — but it is
        // logged, because silently rendering nothing makes a fully broken
        // invoices API indistinguishable from "this account has no invoices",
        // in the UI and in incident triage alike.
        log.error('Failed to load first invoices page', { error });
        setInvoices([]);
        setNextCursor(null);
      } finally {
        if (!cancelled) {
          setLoaded(true);
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [loadPage, log]);

  const handleLoadMore = useCallback(async (): Promise<void> => {
    if (loadingMore || nextCursor === null) {
      return;
    }
    setLoadingMore(true);
    setError(null);
    try {
      const page = await loadPage(nextCursor);
      setInvoices((prev) => [...prev, ...page.invoices]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      // Keep the already-loaded rows and re-enable the button so the user can
      // retry, matching the Transactions "Load more" behavior. The failure's
      // own text goes to the log only.
      logSettingsError(log, 'load more invoices', err);
      setError(INVOICES_LOAD_MORE_ERROR);
    } finally {
      setLoadingMore(false);
    }
  }, [loadPage, loadingMore, nextCursor, log]);

  if (!loaded || invoices.length === 0) {
    return null;
  }

  return (
    <div data-testid={testId}>
      <p className="text-s font-medium fg-primary">Invoices</p>
      <div className="mt-2">
        <InvoicesTable
          invoices={invoices}
          hrefFor={hrefFor}
          renderLink={(props) => <SettingsLink {...props} />}
        />
      </div>
      <ErrorBanner
        errorSource="invoices-section"
        className="mt-2"
        error={error}
      />
      {nextCursor !== null && (
        <Button
          size="compact"
          onClick={() => void handleLoadMore()}
          disabled={loadingMore}
          aria-busy={loadingMore}
          data-testid={`${testId}-load-more`}
          className="mt-3"
        >
          <BusyLabel busy={loadingMore}>Load more</BusyLabel>
        </Button>
      )}
    </div>
  );
}
