import {
  memo,
  useCallback,
  useMemo,
  useRef,
  type JSX,
  type ReactElement,
} from 'react';
import {
  CAPABILITY_TILE_CELL_CLASS,
  useCapabilityTileLayout,
  CapabilityTile,
  capabilityTileModel,
  RichHoverTooltip,
  ShareActionButton,
  type CapabilityTileAction,
  type CapabilityTileReceipt,
  type TooltipTriggerProps,
} from '@canopy/ui-shared/components';
import { getDocument } from '@canopy/ui-shared/panels';
import { useChatShareData } from '@/hooks/useChatShareData';
import { shareTargetForInstalledSkill } from '@/lib/invocableShareTarget';
import { useGitHubStore } from '@/stores/githubStore';
import {
  requestShare,
  useShareHostAvailable,
} from '@/stores/shareRequestStore';
import { AgentArtifactTooltip } from './AgentArtifactTooltip';
import { openAgentArtifactNavigation } from './agent-artifact-navigation';
import {
  readAgentArtifactAvailability,
  useAgentArtifactLiveState,
} from './useAgentArtifactLiveState';

interface AgentArtifactCardProps {
  receipt: CapabilityTileReceipt;
}

export const AgentArtifactCard = memo(function AgentArtifactCard({
  receipt,
}: AgentArtifactCardProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const liveState = useAgentArtifactLiveState(receipt);
  const model = useMemo(
    () => capabilityTileModel(receipt, liveState),
    [liveState, receipt],
  );
  // Recheck on activation: the item may have been deleted after this render.
  const activate = useCallback((): void => {
    if (readAgentArtifactAvailability(receipt) === 'removed') {
      useGitHubStore
        .getState()
        .addToast(`${receipt.name} is no longer available.`, 'error');
      return;
    }
    void openAgentArtifactNavigation(receipt.navigationTarget);
  }, [receipt]);
  const action = useMemo(
    (): CapabilityTileAction => ({ kind: 'action', onActivate: activate }),
    [activate],
  );
  // Only an installed standalone skill can be shared from its card. A shared
  // skill's receipt is already the result of sharing and gets no button.
  const installedSkill =
    receipt.kind === 'skill' &&
    receipt.source === 'installed' &&
    receipt.sourceId &&
    receipt.installedName
      ? { sourceId: receipt.sourceId, name: receipt.installedName }
      : null;
  const hostAvailable = useShareHostAvailable();
  const shareData = useChatShareData(installedSkill !== null && hostAvailable);
  const installedSourceId = installedSkill?.sourceId;
  const installedName = installedSkill?.name;
  // A saved pipeline's receipt carries the locator of the item it describes,
  // so Share reopens that item's dialog, resolved as it is when clicked.
  const pipelineShareTarget =
    receipt.kind === 'pipeline' ? (receipt.shareTarget ?? null) : null;
  const shareTarget = useMemo(
    () =>
      !hostAvailable
        ? null
        : pipelineShareTarget
          ? pipelineShareTarget
          : installedSourceId && installedName
            ? shareTargetForInstalledSkill(
                installedSourceId,
                installedName,
                shareData.installedSkills,
              )
            : null,
    [
      hostAvailable,
      installedName,
      installedSourceId,
      pipelineShareTarget,
      shareData.installedSkills,
    ],
  );
  // Inside a turn's Agent activity the tile is a row (AA1); a card elsewhere.
  const row = useCapabilityTileLayout() === 'row';
  const wrapTrigger = useCallback(
    (trigger: ReactElement<TooltipTriggerProps>): JSX.Element => (
      <RichHoverTooltip
        content={<AgentArtifactTooltip receipt={receipt} model={model} />}
        // A row's trigger fills the row; a card's fills its grid cell
        // (CAPABILITY_TILE_CELL_CLASS, spelled out: this prop takes only a
        // static class string).
        triggerWrapperClassName={
          row
            ? 'flex min-w-0 flex-1'
            : 'h-full w-full supports-[grid-template-rows:subgrid]:row-span-2 supports-[grid-template-rows:subgrid]:grid supports-[grid-template-rows:subgrid]:grid-rows-subgrid'
        }
      >
        {trigger}
      </RichHoverTooltip>
    ),
    [model, receipt, row],
  );
  return (
    // A card fills the grid cell and passes its rows through, so cards in a
    // row share a height and a footer line; a row is one line of the list.
    <div
      ref={wrapperRef}
      className={row ? 'min-w-0' : CAPABILITY_TILE_CELL_CLASS}
    >
      <CapabilityTile
        model={model}
        action={action}
        testId={`agent-artifact-${receipt.kind}`}
        wrapTrigger={wrapTrigger}
        // The rich card already names the status; a second tooltip on the
        // glyph would open two surfaces on one hover.
        statusTooltip={false}
        accessory={
          shareTarget && !model.removed ? (
            <ShareActionButton
              placement="row"
              ariaLabel={`Share ${receipt.name}`}
              dataTestId="agent-artifact-share"
              onClick={() => {
                requestShare(shareTarget, {
                  source: 'artifact_card',
                  ownerDocument: getDocument(wrapperRef.current),
                });
              }}
            />
          ) : undefined
        }
      />
    </div>
  );
});
