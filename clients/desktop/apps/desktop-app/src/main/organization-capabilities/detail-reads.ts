import { BRAND } from '@canopy/brand/current';
import type { SharedSkillDetail } from '@canopy/desktop-shared/types/skills';
import type { SharedPluginDetail } from '@canopy/protocol/plugins';
import {
  PIPELINE_PACKAGE_CLIENT_VERSION,
  PIPELINE_PACKAGE_VERSION_HEADER,
} from '@canopy/protocol/pipelines';
import { requestCanopyCloudJson } from '../canopy-cloud/client';

// The hosted detail reads behind an organization workspace's shared items
// (CAN-6237). Unlike the person's own share reads they check no selected
// sidebar organization: the item is the workspace's organization's, which
// the caller checks against the item's owner, and the server still
// authorizes the signed-in account on every read.

const API_PREFIX = `/api/v1/${BRAND.web.apiNamespace}`;

export function readOrganizationSkill(id: string): Promise<SharedSkillDetail> {
  return requestCanopyCloudJson<SharedSkillDetail>(
    `${API_PREFIX}/skills/${encodeURIComponent(id)}`,
    {
      headers: {
        [PIPELINE_PACKAGE_VERSION_HEADER]: String(
          PIPELINE_PACKAGE_CLIENT_VERSION,
        ),
      },
    },
  );
}

export function readOrganizationPlugin(
  id: string,
): Promise<SharedPluginDetail> {
  return requestCanopyCloudJson<SharedPluginDetail>(
    `${API_PREFIX}/plugins/${encodeURIComponent(id)}`,
  );
}
