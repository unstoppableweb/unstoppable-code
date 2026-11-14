'use client';

import {
  useCallback,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type JSX,
} from 'react';
import {
  Button,
  ErrorBanner,
  FormField,
  TextInput,
  Heading,
} from '@canopy/ui-shared/components';
import {
  SettingsOperationError,
  type DigestRequestCredits,
} from '@canopy/protocol/settings';
import { useSettingsErrorCopy, type KnownSettingsError } from '../errors';
import { SettingsLink, useSettingsClient, useSettingsRouter } from '../host';
import { requestDigest, type DigestOwner } from './digest-api';
import type { SettingsFailure } from '../errors';

/**
 * Server-read funding for the subject, from `readDigestBillingForPage`. The
 * contract lives in `@canopy/protocol/settings` so page data and this form
 * share one definition. `fundingKey` is the change key over every source the
 * payer may draw on (wallet plus eligible org pools), distinct from
 * `balanceCredits`, which is the wallet alone and is permanently 0 for an
 * org-pool-funded requester.
 */
export type { DigestRequestCredits };

export interface DigestRequestFormProps {
  /**
   * Whose digest this form requests: `account.digests.request` for the
   * viewer, `organization.digests.request` for an organization. Same
   * parameterization as `DigestPreferencesCard`: one component, two subjects.
   */
  owner: DigestOwner;
  /** Distinguishes the account and org instances for automation selectors. */
  testIdPrefix: string;
  /**
   * Server-read credit funding for the subject. Re-supplied on the host
   * router's `refresh()`, which is how the balance stays current without a
   * polling loop.
   */
  credits: DigestRequestCredits;
}

/**
 * Deliberately the requester's PERSONAL wallet for both the account and the org
 * instance of this form, and deliberately NOT subject-aware the way
 * `digest-email.ts` is.
 *
 * The two surfaces have different audiences. The insufficient-credits email for
 * an ORGANIZATION digest goes to that org's OWNER/ADMINs about a SCHEDULED run
 * the org ledger pays for, so it must link the org's billing tab. This form is
 * an ON_DEMAND request, where `resolveDigestPayer` makes the requester the
 * payer and only spills onto an org pool once their wallet empties — so the
 * wallet the requester can actually top up is the one that unblocks them.
 *
 * Do not "fix" this to match the email.
 */
const BILLING_HREF = '/account/billing';

/** `YYYY-MM-DD` in UTC, matching the calendar dates the route parses. */
function toUtcDateInput(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function subscribeToClock(): () => void {
  // A digest form does not need to tick while it is open. The external-store
  // shape gives SSR a stable null snapshot while letting hydration read the
  // browser clock without a state-setting effect.
  return () => undefined;
}

function getMaxRequestableDate(): string | null {
  return toUtcDateInput(new Date());
}

const REQUEST_DIGEST_ACTION = 'request that digest';

/**
 * Local copy for the request route's known refusals. The route's own text
 * goes to logs only. A 400 is a range the route rejected (more than 90 days,
 * or ending after today); the date inputs already prevent an end before the
 * start.
 */
const DIGEST_REQUEST_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  {
    status: 400,
    copy: 'Choose a range of 90 days or less that ends today or earlier.',
  },
  {
    status: 429,
    copy: 'Too many recent digests failed or had no activity to report. Try again later.',
  },
  {
    status: 503,
    copy: 'Digest generation is temporarily unavailable. Try again later.',
  },
];

/**
 * Request a Work Digest over an arbitrary date range.
 *
 * Dates are posted as the raw `YYYY-MM-DD` strings the `<input type="date">`
 * emits, never as a constructed `Date`. Synthesizing an instant client-side
 * (`new Date(local).toISOString()`) shifts the range back a day for every
 * viewer west of UTC, which would silently generate the wrong report.
 *
 * There is no request ration: reports are metered against the requester's AI
 * credits at what they actually cost the gateway to generate, so the only limit
 * is an empty wallet. That also means there is no optimistic counter to keep
 * honest — the cost is not known until generation finishes, so the balance line
 * simply re-reads from the server on refresh.
 *
 * A successful submit refreshes once immediately; `DigestAutoRefresh` owns the
 * bounded archive polling while a queued or generating row remains visible.
 */
export function DigestRequestForm({
  owner,
  testIdPrefix,
  credits,
}: DigestRequestFormProps): JSX.Element | null {
  const client = useSettingsClient();
  const router = useSettingsRouter();
  const errorCopy = useSettingsErrorCopy('digests');
  const [available, setAvailable] = useState(true);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<SettingsFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The server snapshot is deliberately null so SSR and the first hydration
  // pass agree even if they straddle UTC midnight.
  const maxDate = useSyncExternalStore(
    subscribeToClock,
    getMaxRequestableDate,
    () => null,
  );
  // A 402 from submit means the route's pre-flight found nothing spendable,
  // which the page's server read predates.
  //
  // Keyed on `fundingKey` — wallet plus the request's owner-scoped org pool —
  // rather than on the wallet balance alone. A rejected request bills nothing, so an unchanged
  // funding key on the next render means nothing was topped up anywhere and the
  // form should stay honestly disabled; any top-up in the chain moves the key
  // and retires the rejection without needing a remount or a revision token.
  //
  // Keying this on `balanceCredits` stranded org-pool-funded requesters: their
  // personal wallet is 0 by definition, so `0 === 0` held forever and one 402
  // disabled the form permanently — still claiming "You're out of AI credits"
  // after the pool was refunded — until a full page reload.
  const [rejectedAtFundingKey, setRejectedAtFundingKey] = useState<
    number | null
  >(null);

  const { spendable, fundingKey } = credits;
  const outOfCredits = !spendable || rejectedAtFundingKey === fundingKey;

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (submitting || outOfCredits) return;
      setSubmitting(true);
      setError(null);
      setNotice(null);
      let status: string;
      try {
        // Verbatim calendar dates; see the component doc comment.
        const result = await requestDigest(client, owner, {
          startDate,
          endDate,
        });
        status = result.status;
      } catch (error) {
        if (!(error instanceof SettingsOperationError)) {
          setError(
            errorCopy.actionFailure(error, { action: REQUEST_DIGEST_ACTION }),
          );
          return;
        }
        // The surface does not exist for this viewer (flag off, or org edit
        // rights revoked in another tab). Hide rather than strand a form whose
        // every submit would fail — same contract the preferences card honors.
        if (error.status === 404 || error.status === 403) {
          setAvailable(false);
          return;
        }
        if (error.status === 402) {
          // Being out of credits is a state, not an error: the credits line
          // below becomes the explanation and carries the top-up link, so a
          // banner on top of it would just say the same thing twice.
          setRejectedAtFundingKey(fundingKey);
          router.refresh();
          return;
        }
        if (error.code === 'invalid_response') {
          // The server accepted the request but its body could not be read.
          // The request went through, so report it as queued, as an
          // unreadable success body always was.
          status = 'enqueued';
        } else {
          setError(
            errorCopy.actionFailure(error, {
              action: REQUEST_DIGEST_ACTION,
              known: DIGEST_REQUEST_KNOWN_ERRORS,
            }),
          );
          return;
        }
      } finally {
        setSubmitting(false);
      }
      if (status === 'already_exists') {
        setNotice('You already have a digest for that range.');
      } else {
        setNotice(
          'Digest requested. We’ll update this page automatically and email you when it’s ready.',
        );
      }
      router.refresh();
    },
    [
      client,
      endDate,
      errorCopy,
      owner,
      fundingKey,
      outOfCredits,
      router,
      startDate,
      submitting,
    ],
  );

  if (!available) return null;

  const canSubmit =
    !submitting &&
    !outOfCredits &&
    startDate !== '' &&
    endDate !== '' &&
    !!maxDate;

  return (
    // Deliberately NOT the `bg-card` + `shadow-sm` treatment the archive rows
    // use. This is a control, not a record: it sits recessed into the page on
    // `bg-depth` behind an explicit outline, so the raised, borderless digest
    // cards below read as a separate class of thing at a glance.
    <section
      className="rounded-xl border bg-depth p-5"
      data-testid={`${testIdPrefix}-digest-request`}
    >
      <Heading level={3} variant="title">
        Request a digest
      </Heading>
      <p
        className="mt-1 text-xs fg-secondary"
        data-testid={`${testIdPrefix}-digest-request-intro`}
      >
        Generate a one-off report covering any range of up to 90 days. A report
        ending today covers everything so far today (dates are UTC). Reports are
        billed to your AI credits based on usage.
      </p>

      <ErrorBanner
        errorSource="digest-request-form"
        error={error?.copy}
        details={error?.details}
      />

      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={handleSubmit}
      >
        <FormField label="Start date">
          {(control) => (
            <TextInput
              {...control}
              density="settings"
              type="date"
              required
              value={startDate}
              max={maxDate ?? undefined}
              disabled={submitting || outOfCredits}
              data-testid={`${testIdPrefix}-digest-request-start`}
              onChange={(event) => setStartDate(event.target.value)}
            />
          )}
        </FormField>
        <FormField label="End date">
          {(control) => (
            <TextInput
              {...control}
              density="settings"
              type="date"
              required
              value={endDate}
              // The browser enforces the same rule the route re-checks:
              // no end past today, and never before the start.
              min={startDate || undefined}
              max={maxDate ?? undefined}
              disabled={submitting || outOfCredits}
              data-testid={`${testIdPrefix}-digest-request-end`}
              onChange={(event) => setEndDate(event.target.value)}
            />
          )}
        </FormField>
        <Button
          type="submit"
          size="compact"
          disabled={!canSubmit}
          data-testid={`${testIdPrefix}-digest-request-submit`}
        >
          {submitting ? 'Requesting…' : 'Request digest'}
        </Button>
      </form>

      {notice && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p
            className="text-xs fg-secondary"
            role="status"
            data-testid={`${testIdPrefix}-digest-request-notice`}
          >
            {notice}
          </p>
          {/* Deliberately a manual refresh rather than a poll: generation is
              queue-dependent and can run for minutes, and a timer in an effect
              is exactly the pattern this repo warns against. */}
          <Button
            size="compact"
            data-testid={`${testIdPrefix}-digest-request-refresh`}
            onClick={() => router.refresh()}
          >
            Refresh
          </Button>
        </div>
      )}

      {/* Only the blocked state gets a line down here. The billing model itself
          is stated once, in the intro above, so a funded requester is not told
          the same thing twice. */}
      {outOfCredits && (
        <p
          className="mt-3 text-xs fg-secondary"
          data-testid={`${testIdPrefix}-digest-request-credits`}
        >
          You&rsquo;re out of AI credits, so reports cannot be generated right
          now.{' '}
          <SettingsLink
            href={BILLING_HREF}
            className="font-medium fg-accent hover:underline"
          >
            Add AI credits
          </SettingsLink>
          .
        </p>
      )}
    </section>
  );
}
