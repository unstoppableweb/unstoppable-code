'use client';

import type { JSX } from 'react';
import type { SettingsPageProps } from '../pages/page-props';
import {
  SlackLinkSettings,
  SlackSectionAbsent,
} from '../slack/SlackLinkSettings';
import { GitHubCloudSettings } from './GitHubCloudSettings';

/**
 * `/account/integrations`: connections to third parties that work on the
 * user's behalf. GitHub for cloud work is one Settings card driven by the
 * single page-level connection controller, which also handles a GitHub
 * callback that landed on this page (`github_cloud=...`). Slack (CAN-7606)
 * links a Slack account to this account and one computer.
 *
 * Each section shows only where it is offered. The page data's flags are
 * optional for version skew: a missing `githubCloud` means on (the page had
 * only GitHub before), a missing `slack` means off. The page's own gate stays
 * with each host's loader: web redirects to `/account`, `settings.pageData`
 * answers `not_found` when neither is offered. Web still renders the page
 * for a visit from a Slack link (`?slack=`), so it can say Slack isn't
 * available instead of landing on Account with no word why.
 */
export function AccountIntegrationsPage({
  page,
}: SettingsPageProps<'account.integrations'>): JSX.Element {
  const { userId, githubCloud, slack } = page.data;
  // Where Slack isn't offered, its absence comes first: arriving from a
  // Slack link, it says why above everything else (and is empty otherwise).
  return (
    <div className="flex flex-col gap-10">
      {slack === true ? null : <SlackSectionAbsent />}
      {githubCloud === false ? null : <GitHubCloudSettings userId={userId} />}
      {slack === true ? <SlackLinkSettings userId={userId} /> : null}
    </div>
  );
}
