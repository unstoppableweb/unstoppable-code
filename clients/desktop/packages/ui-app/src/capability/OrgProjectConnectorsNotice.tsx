import { Fragment, useEffect, useState, type JSX } from 'react';
import { useCapabilities, useOnboardingTipsStore } from '@canopy/app-state';
import { McpServerIcon } from '@canopy/ui-shared/icons/AppIcons';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/** The tip id that keeps this notice's one-time dismissal. */
const TIP_ID = 'org-project-connectors';

/** A global connector that no longer loads in this project. */
export interface OrgProjectConnector {
  /** Stable identity: the connector's server and configuration. */
  readonly key: string;
  /** The connector's name (`Slack`). */
  readonly connector: string;
  /** The account, when the person holds several of the connector. */
  readonly account?: string;
}

export interface OrgProjectConnectorsNoticeProps {
  /** The person's global connectors this organization project leaves out. */
  readonly connectors: readonly OrgProjectConnector[];
  /** Adds one to this project's own defaults; rejects when it couldn't. */
  readonly onAdd: (key: string) => Promise<void>;
}

/** One connector's name; an account name is blocked from session replay. */
function ConnectorName({
  connector,
}: {
  connector: OrgProjectConnector;
}): JSX.Element {
  return connector.account === undefined ? (
    <>{connector.connector}</>
  ) : (
    <>
      {connector.connector} (
      <span className={REPLAY_BLOCK_CLASS}>{connector.account}</span>)
    </>
  );
}

/** `Slack`, `Slack and Linear`, `Slack, Linear and GitHub`. */
function ConnectorList({
  connectors,
}: {
  connectors: readonly OrgProjectConnector[];
}): JSX.Element {
  const last = connectors.length - 1;
  return (
    <>
      {connectors.map((connector, index) => (
        <Fragment key={connector.key}>
          {index === 0 ? '' : index === last ? ' and ' : ', '}
          <ConnectorName connector={connector} />
        </Fragment>
      ))}
    </>
  );
}

export interface OrgProjectConnectorsNoticeViewProps extends OrgProjectConnectorsNoticeProps {
  /** Hides the notice for good. */
  readonly onDismiss: () => void;
}

/**
 * The notice's surface (CAN-6230): names the global connectors that no
 * longer load in this organization project, with a button to add each back
 * to the project. {@link OrgProjectConnectorsNotice} decides when it shows.
 */
export function OrgProjectConnectorsNoticeView({
  connectors,
  onAdd,
  onDismiss,
}: OrgProjectConnectorsNoticeViewProps): JSX.Element | null {
  const [adding, setAdding] = useState<string | null>(null);
  const [failed, setFailed] = useState<OrgProjectConnector | null>(null);
  if (connectors.length === 0) return null;
  const add = (connector: OrgProjectConnector): void => {
    setAdding(connector.key);
    setFailed(null);
    void onAdd(connector.key)
      .catch((): void => setFailed(connector))
      .finally((): void => setAdding(null));
  };
  return (
    <Notice
      icon={<McpServerIcon size={16} aria-hidden="true" />}
      title="Your connectors stay out of organization projects"
      actionsPlacement={connectors.length > 2 ? 'below' : 'trailing'}
      actions={connectors.map((connector) => (
        <NoticeButton
          key={connector.key}
          busy={adding === connector.key}
          disabled={adding !== null && adding !== connector.key}
          onClick={(): void => add(connector)}
          data-testid="org-project-connectors-add"
        >
          Add {connector.connector}
        </NoticeButton>
      ))}
      onDismiss={onDismiss}
      announceDetail
      {...(failed === null
        ? {}
        : {
            detail: (
              <>
                Couldn't add <ConnectorName connector={failed} />. Try again.
              </>
            ),
          })}
      data-testid="org-project-connectors-notice"
    >
      <ConnectorList connectors={connectors} /> no longer{' '}
      {connectors.length === 1 ? 'loads' : 'load'} here. In an organization
      project, your connectors load only where you add them.
    </Notice>
  );
}

/**
 * The one-time notice that a person's "load everywhere" connectors stay out
 * of organization projects (CAN-6230). Shown until the person dismisses it,
 * on any project, through the shared onboarding-tip dismissals, so the
 * desktop and a Portal tab agree. Renders nothing on a host that keeps no
 * dismissals, or when nothing stopped loading.
 */
export function OrgProjectConnectorsNotice({
  connectors,
  onAdd,
}: OrgProjectConnectorsNoticeProps): JSX.Element | null {
  const keepsTips = useCapabilities().onboardingTips === true;
  const status = useOnboardingTipsStore((state) => state.status);
  const dismissed = useOnboardingTipsStore(
    (state) => state.dismissed[TIP_ID] !== undefined,
  );
  const load = useOnboardingTipsStore((state) => state.load);
  const dismiss = useOnboardingTipsStore((state) => state.dismiss);
  useEffect(() => {
    if (keepsTips) load();
  }, [keepsTips, load]);
  if (!keepsTips || status !== 'ready' || dismissed) return null;
  return (
    <OrgProjectConnectorsNoticeView
      connectors={connectors}
      onAdd={onAdd}
      onDismiss={(): void => dismiss(TIP_ID)}
    />
  );
}
