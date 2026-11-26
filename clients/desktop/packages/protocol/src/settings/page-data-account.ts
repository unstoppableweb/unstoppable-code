import {
  personalAiGatewayConfigSchema,
  personalAiGatewayUseInCloudChatsSchema,
} from '../model-gateway';
import { CoreIntegrationProviderKeyListResultSchema } from '../canopy-core/core/integration/provider-key';
import { z } from 'zod';
import type { SettingsRoute } from './routes';
import type { PublicProfileSettings } from './account';
import type {
  AccountDigestDetail,
  DigestArchiveItem,
  DigestProfileAudience,
  DigestRequestCredits,
} from './account-digests';
import type {
  AccountBillingOrg,
  BillingChrome,
  InvoiceDetail,
} from './billing';
import { settingsDtoSchema } from './operation-definition';

/**
 * First-screen data for each personal (account) settings route: exactly the
 * props the route's web server page or loader passes to its client
 * components today, as plain DTOs. `settings.pageData` returns one of these
 * for an account route; hosts then render the shared component with it.
 *
 * Gates stay server-side: a route whose flag is off (billing, digests,
 * integrations) answers the page-data request with `not_found`/`forbidden`
 * rather than an empty DTO, matching the web page's redirect.
 */
export const ACCOUNT_PAGE_DATA_KINDS = [
  'account.account',
  'account.profile',
  'account.digests',
  'account.digest',
  'account.notifications',
  'account.integrations',
  'account.plugins',
  'account.mcp',
  'account.delegation',
  'account.security',
  'account.model-providers',
  'account.ai-gateway',
  'account.billing',
  'account.invoice',
  'account.labs',
  'account.appearance',
] as const;

export type AccountPageDataKind = (typeof ACCOUNT_PAGE_DATA_KINDS)[number];

const nullableString = z.string().nullable();

/** `/account` → `AccountPanel` props (session identity). */
export const accountAccountPageDataSchema = z.looseObject({
  kind: z.literal('account.account'),
  data: z.looseObject({
    initialName: z.string(),
    initialImage: nullableString,
    role: z.string(),
    email: z.string(),
  }),
});

/**
 * `/account/profile` → `PublicProfileSection` props. `PersonalCatalogCard`
 * and `ProfileRoutingBacktestSection` load their own data client-side
 * (`account.profile.projects.read`, `account.profile.routingBacktest.*`).
 */
export const accountProfilePageDataSchema = z.looseObject({
  kind: z.literal('account.profile'),
  data: z.looseObject({
    initialSettings: settingsDtoSchema<PublicProfileSettings | null>(
      z
        .looseObject({
          username: nullableString,
          enabled: z.boolean(),
          bio: nullableString,
          links: z.array(
            z.looseObject({ platform: z.string(), url: z.string() }),
          ),
          showCost: z.boolean(),
          showHeatmap: z.boolean(),
        })
        .nullable(),
    ),
    displayName: z.string(),
    avatarUrl: nullableString,
  }),
});

const digestArchiveItemShape = z.looseObject({
  externalId: z.string(),
  cadence: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  headline: nullableString,
  variant: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

/**
 * `/account/digests` → the archive (`DigestList`), the on-demand request form
 * funding (`readDigestBillingForPage`), and the auto-refresh trigger, which
 * hosts derive from the rows' status. The brand name in the empty message
 * comes from the host brand port.
 */
export const accountDigestsPageDataSchema = z.looseObject({
  kind: z.literal('account.digests'),
  data: z.looseObject({
    digests: settingsDtoSchema<DigestArchiveItem[]>(
      z.array(digestArchiveItemShape),
    ),
    billing: z.discriminatedUnion('status', [
      z.looseObject({
        status: z.literal('ok'),
        billing: settingsDtoSchema<DigestRequestCredits>(
          z.looseObject({
            spendable: z.boolean(),
            balanceCredits: z.number(),
            fundingKey: z.number(),
            fundingLabel: nullableString,
          }),
        ),
      }),
      z.looseObject({ status: z.literal('unavailable') }),
    ]),
  }),
});

/**
 * `/account/digests/[digestId]` → `DigestDetailHeader` share props,
 * `DigestReport`, and `DigestDetailNavigation`. Neighbors are ids rather than
 * hrefs; hosts build destinations through their navigation port.
 */
export const accountDigestPageDataSchema = z.looseObject({
  kind: z.literal('account.digest'),
  data: z.looseObject({
    digest: settingsDtoSchema<AccountDigestDetail>(
      z.looseObject({
        externalId: z.string(),
        subjectType: z.string(),
        cadence: z.string(),
        periodStart: z.string(),
        periodEnd: z.string(),
        headline: nullableString,
        executiveSummaryMarkdown: nullableString,
        bodyMarkdown: nullableString,
        variant: z.string(),
      }),
    ),
    audiences: settingsDtoSchema<DigestProfileAudience[]>(
      z.array(
        z.looseObject({
          organizationId: z.string(),
          organizationName: z.string(),
          featured: z.boolean(),
          lapsed: z.boolean(),
        }),
      ),
    ),
    neighbors: z.looseObject({
      olderDigestId: nullableString,
      newerDigestId: nullableString,
    }),
  }),
});

/**
 * `/account/notifications`. Both cards load their own state client-side; the
 * `?digestUnsubscribed=1` acknowledgement is a query flag the host reads from
 * its own location, not page data.
 */
export const accountNotificationsPageDataSchema = z.looseObject({
  kind: z.literal('account.notifications'),
  data: z.looseObject({}),
});

/**
 * `/account/labs`. The section loads the experiments it lists client-side
 * through `account.labs.read`, so a switch reflects the latest saved choice.
 */
export const accountLabsPageDataSchema = z.looseObject({
  kind: z.literal('account.labs'),
  data: z.looseObject({}),
});

/** Installed status is loaded through the host's installed-item snapshot port. */
export const accountPluginsPageDataSchema = z.looseObject({
  kind: z.literal('account.plugins'),
  data: z.looseObject({}),
});

export const accountMcpPageDataSchema = z.looseObject({
  kind: z.literal('account.mcp'),
  data: z.looseObject({}),
});

/**
 * `/account/appearance`. The page loads the saved chat detail level
 * client-side through `account.appearance.read`.
 */
export const accountAppearancePageDataSchema = z.looseObject({
  kind: z.literal('account.appearance'),
  data: z.looseObject({}),
});

/**
 * `/account/delegation`. The page loads the saved cloud delegation limits
 * client-side through `account.settings.delegation.read`.
 */
export const accountDelegationPageDataSchema = z.looseObject({
  kind: z.literal('account.delegation'),
  data: z.looseObject({}),
});

/**
 * `/account/integrations` → GitHub for cloud work and Slack. Both section
 * flags are optional for version skew: a missing `githubCloud` means on (the
 * page only had GitHub before CAN-7606), a missing `slack` means off.
 */
export const accountIntegrationsPageDataSchema = z.looseObject({
  kind: z.literal('account.integrations'),
  data: z.looseObject({
    userId: z.string().min(1),
    githubCloud: z.boolean().optional(),
    slack: z.boolean().optional(),
  }),
});

/** `/account/security` → `SecurityPanel` props. */
export const accountSecurityPageDataSchema = z.looseObject({
  kind: z.literal('account.security'),
  data: z.looseObject({
    brandDisplayName: z.string(),
    emailPasswordAuthEnabled: z.boolean(),
  }),
});

/** `/account/billing` → `BillingSection` props. */
export const accountBillingPageDataSchema = z.looseObject({
  kind: z.literal('account.billing'),
  data: z.looseObject({
    orgs: settingsDtoSchema<AccountBillingOrg[]>(
      z.array(
        z.looseObject({
          id: z.string(),
          name: z.string(),
          canManageBilling: z.boolean(),
        }),
      ),
    ),
    orgCovered: z.boolean(),
    chrome: settingsDtoSchema<BillingChrome | null>(
      z
        .looseObject({
          planDisplayName: nullableString,
          trial: z
            .looseObject({ active: z.boolean(), endsAt: z.string() })
            .nullable(),
          hasPaymentMethod: z.boolean(),
        })
        .nullable(),
    ),
    /** @deprecated Retained for shipped clients, which require it; the server always sends `true`. */
    freeAccess: z.boolean(),
  }),
});

/** `/account/billing/invoices/[invoiceId]` → `InvoiceDetailPage` props. */
export const accountInvoicePageDataSchema = z.looseObject({
  kind: z.literal('account.invoice'),
  data: z.looseObject({
    invoice: settingsDtoSchema<InvoiceDetail>(
      z.looseObject({
        id: z.string(),
        number: z.string(),
        issuedAt: z.string(),
        periodStart: z.string(),
        periodEnd: z.string(),
        currency: z.string(),
        status: z.string(),
        isCurrent: z.boolean(),
        billTo: z.looseObject({
          kind: z.enum(['user', 'organization']),
          name: z.string(),
          email: nullableString,
        }),
        lineItems: z.array(z.looseObject({ id: z.string() })),
        subtotalUsd: z.number(),
        taxUsd: z.number(),
        totalUsd: z.number(),
        amountPaidUsd: z.number(),
        amountRefundedUsd: z.number(),
        credits: z.looseObject({
          usageGroups: z.array(z.looseObject({})),
          totalUsedCredits: z.number(),
          addedGroups: z.array(z.looseObject({})),
          totalAddedCredits: z.number(),
        }),
      }),
    ),
  }),
});

/**
 * `/account/model-providers`: the person's own Anthropic and OpenAI keys for
 * cloud chats, as status only. The key itself is write-only and never read.
 */
export const accountModelProvidersPageDataSchema = z.looseObject({
  kind: z.literal('account.model-providers'),
  data: CoreIntegrationProviderKeyListResultSchema,
});
export type AccountModelProvidersPageData = z.infer<
  typeof accountModelProvidersPageDataSchema
>;

export const accountAiGatewayPageDataSchema = z.looseObject({
  kind: z.literal('account.ai-gateway'),
  data: z.looseObject({
    organizationId: z.uuid(),
    gateway: personalAiGatewayConfigSchema.nullable(),
    useInCloudChats: personalAiGatewayUseInCloudChatsSchema,
  }),
});
export type AccountAiGatewayPageData = z.infer<
  typeof accountAiGatewayPageDataSchema
>;

export const accountPageDataSchema = z.discriminatedUnion('kind', [
  accountAccountPageDataSchema,
  accountProfilePageDataSchema,
  accountDigestsPageDataSchema,
  accountDigestPageDataSchema,
  accountNotificationsPageDataSchema,
  accountIntegrationsPageDataSchema,
  accountPluginsPageDataSchema,
  accountMcpPageDataSchema,
  accountDelegationPageDataSchema,
  accountSecurityPageDataSchema,
  accountModelProvidersPageDataSchema,
  accountAiGatewayPageDataSchema,
  accountBillingPageDataSchema,
  accountInvoicePageDataSchema,
  accountLabsPageDataSchema,
  accountAppearancePageDataSchema,
]);

export type AccountAccountPageData = z.infer<
  typeof accountAccountPageDataSchema
>;
export type AccountProfilePageData = z.infer<
  typeof accountProfilePageDataSchema
>;
export type AccountDigestsPageData = z.infer<
  typeof accountDigestsPageDataSchema
>;
export type AccountDigestPageData = z.infer<typeof accountDigestPageDataSchema>;
export type AccountNotificationsPageData = z.infer<
  typeof accountNotificationsPageDataSchema
>;
export type AccountIntegrationsPageData = z.infer<
  typeof accountIntegrationsPageDataSchema
>;
export type AccountPluginsPageData = z.infer<
  typeof accountPluginsPageDataSchema
>;
export type AccountMcpPageData = z.infer<typeof accountMcpPageDataSchema>;
export type AccountDelegationPageData = z.infer<
  typeof accountDelegationPageDataSchema
>;
export type AccountSecurityPageData = z.infer<
  typeof accountSecurityPageDataSchema
>;
export type AccountBillingPageData = z.infer<
  typeof accountBillingPageDataSchema
>;
export type AccountInvoicePageData = z.infer<
  typeof accountInvoicePageDataSchema
>;
export type AccountLabsPageData = z.infer<typeof accountLabsPageDataSchema>;
export type AccountAppearancePageData = z.infer<
  typeof accountAppearancePageDataSchema
>;
export type AccountPageData = z.infer<typeof accountPageDataSchema>;

/**
 * The page-data kind an account route resolves to, or `null` for a route
 * outside the personal scope. Detail routes (a digest, an invoice) have their
 * own kinds because their loaders return different DTOs.
 */
export function accountPageDataKindForRoute(
  route: SettingsRoute,
): AccountPageDataKind | null {
  if (route.scope !== 'account') return null;
  switch (route.page) {
    case 'account':
      return 'account.account';
    case 'profile':
      return 'account.profile';
    case 'digests':
      return route.digestId === undefined
        ? 'account.digests'
        : 'account.digest';
    case 'notifications':
      return 'account.notifications';
    case 'integrations':
      return 'account.integrations';
    case 'plugins':
      return 'account.plugins';
    case 'mcp':
      return 'account.mcp';
    case 'delegation':
      return 'account.delegation';
    case 'security':
      return 'account.security';
    case 'model-providers':
      return 'account.model-providers';
    case 'ai-gateway':
      return 'account.ai-gateway';
    case 'billing':
      return route.invoiceId === undefined
        ? 'account.billing'
        : 'account.invoice';
    case 'labs':
      return 'account.labs';
    case 'appearance':
      return 'account.appearance';
  }
}

/** Narrow an untrusted `settings.pageData` result to an account DTO. */
export function parseAccountPageData(value: unknown): AccountPageData | null {
  const parsed = accountPageDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
