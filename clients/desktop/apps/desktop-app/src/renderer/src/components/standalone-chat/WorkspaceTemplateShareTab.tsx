import { useResourceContext } from '@canopy/ui-app/capability';
import { useEffect, useState, type JSX } from 'react';
import type {
  ChatProjectTemplateDraft,
  ChatProjectTemplateDocumentResult,
  ChatProjectTemplateShareInfo,
} from '@canopy/desktop-shared/types';
import { WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER } from '@canopy/protocol';
import {
  Stack,
  CopyLinkButton,
  ShareActionButton,
  ShareAudienceLabel,
  ErrorBanner,
  Heading,
} from '@canopy/ui-shared/components';
import {
  createShareLinkResolver,
  resolveSharedSkillUrl,
} from '@/lib/share-links';
import { copyTextToClipboard } from '@/lib/clipboard';
import { ShareProjectTemplateModal } from './ShareProjectTemplateModal';

interface WorkspaceTemplateShareTabProps {
  projectId: string;
  draft: ChatProjectTemplateDraft;
}

const templateLinks = createShareLinkResolver(
  (id) => `/portal/plugins/project-templates/${encodeURIComponent(id)}`,
  resolveSharedSkillUrl,
);

function omissionCopy(
  omitted: ChatProjectTemplateDocumentResult['omitted'],
): string | null {
  const unavailable = omitted.unresolvedRefs.length > 0;
  if (omitted.mcpServers && unavailable) {
    return 'MCP servers on this device and unavailable items aren’t included.';
  }
  if (omitted.mcpServers) return 'MCP servers on this device aren’t included.';
  if (unavailable) return 'Some unavailable items aren’t included.';
  return null;
}

function audienceFor(
  share: ChatProjectTemplateShareInfo,
): 'team' | 'organization' | 'public' {
  if (share.audience === 'TEAM') return 'team';
  if (share.audience === 'ORGANIZATION') return 'organization';
  return 'public';
}

/** Compact settings entry point; the common modal owns the actual share flow. */
export function WorkspaceTemplateShareTab({
  projectId,
  draft,
}: WorkspaceTemplateShareTabProps): JSX.Element {
  const { personalOrganizationId } = useResourceContext();
  const [built, setBuilt] = useState<ChatProjectTemplateDocumentResult | null>(
    null,
  );
  const [share, setShare] = useState<ChatProjectTemplateShareInfo | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError('');
    void (async (): Promise<void> => {
      try {
        const next = await window.api.chatProject.buildTemplate({
          projectId,
          draft,
        });
        if (canceled) return;
        setBuilt(next);
        const existing = await window.api.chatProject.getTemplateShare({
          projectId,
          document: next.document,
        });
        if (!canceled) setShare(existing);
      } catch {
        // The share service's own error text is never shown here.
        if (!canceled) setError("Couldn't load sharing details. Try again.");
      } finally {
        if (!canceled) setLoading(false);
      }
    })();
    return (): void => {
      canceled = true;
    };
  }, [draft, projectId]);

  useEffect(() => {
    let canceled = false;
    if (!share) {
      setShareUrl(null);
      return undefined;
    }
    const audience = audienceFor(share);
    void templateLinks
      .resolveLink(
        audience === 'public'
          ? { kind: 'public', sharePath: share.sharePath }
          : { kind: 'scoped', id: share.externalId },
      )
      .then((link) => {
        if (!canceled) setShareUrl(link.url);
      });
    return (): void => {
      canceled = true;
    };
  }, [share]);

  const omitted = built ? omissionCopy(built.omitted) : null;
  const audience = share ? audienceFor(share) : null;

  return (
    <Stack gap="item" data-testid="workspace-template-share-tab">
      <div className="flex items-start justify-between gap-4">
        <Stack gap="tight">
          <Heading level={3} variant="title">
            {`Share ${WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER}`}
          </Heading>
          <p className="text-xs fg-secondary">
            Shares this project’s setup. Chats and files stay private.
          </p>
        </Stack>
        <ShareActionButton
          ariaLabel={`Share ${draft.name}`}
          placement="header"
          disabled={loading || built === null}
          dataTestId="workspace-template-share-open"
          onClick={(): void => setDialogOpen(true)}
        />
      </div>

      {loading ? (
        <p className="text-xs fg-secondary">Loading sharing details…</p>
      ) : share && audience ? (
        <div className="flex flex-wrap items-center gap-3">
          <ShareAudienceLabel
            audience={audience}
            personal={
              share.owner?.type === 'organization' &&
              share.owner.id === personalOrganizationId
            }
            teamName={
              audience === 'team' && share.owner?.type === 'team'
                ? share.owner.name
                : null
            }
            dataTestId="workspace-template-share-audience"
          />
          {shareUrl ? (
            <CopyLinkButton
              url={shareUrl}
              dataTestId="workspace-template-copy-link"
              write={copyTextToClipboard}
            />
          ) : null}
          {!share.upToDate ? (
            <span className="text-xs fg-secondary">
              This shared project template is out of date.
            </span>
          ) : null}
        </div>
      ) : null}

      {omitted ? <p className="text-xs fg-secondary">{omitted}</p> : null}
      <ErrorBanner
        errorSource="workspace-template-share-tab"
        className=""
        error={error}
      />

      {dialogOpen && built ? (
        <ShareProjectTemplateModal
          projectId={projectId}
          built={built}
          existing={share}
          onShared={setShare}
          onRevoked={(): void => setShare(null)}
          onClose={(): void => setDialogOpen(false)}
        />
      ) : null}
    </Stack>
  );
}
