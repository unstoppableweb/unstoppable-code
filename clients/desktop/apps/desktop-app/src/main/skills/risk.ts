/**
 * Adapted from https://github.com/vercel-labs/skills
 * Original source: MIT License
 * https://github.com/vercel-labs/skills/blob/main/src/telemetry.ts
 */

import type {
  SkillRiskInfo,
  SkillRiskLevel,
} from '@canopy/desktop-shared/types/skills';
import { httpsGet } from '../lib/http';
import { getEffectiveUsageDataPolicy } from '../lib/usage-data-policy';
import { allowsAutomaticCall } from '../local-only/policy';

const AUDIT_URL =
  process.env.SKILL_AUDIT_URL || 'https://add-skill.vercel.sh/audit';
const AUDIT_TIMEOUT_MS = 3000;

interface PartnerAudit {
  risk?: string;
  alerts?: number;
  score?: number;
  analyzedAt?: string;
}

type AuditResponse = Record<string, Record<string, PartnerAudit>>;

const RISK_PRECEDENCE: SkillRiskLevel[] = [
  'unknown',
  'safe',
  'low',
  'medium',
  'high',
  'critical',
];

function toRiskLevel(value: string | undefined): SkillRiskLevel {
  if (!value) return 'unknown';
  const normalized = value.toLowerCase();
  if (RISK_PRECEDENCE.includes(normalized as SkillRiskLevel)) {
    return normalized as SkillRiskLevel;
  }
  return 'unknown';
}

function highestRisk(a: SkillRiskLevel, b: SkillRiskLevel): SkillRiskLevel {
  const aIdx = RISK_PRECEDENCE.indexOf(a);
  const bIdx = RISK_PRECEDENCE.indexOf(b);
  return aIdx >= bIdx ? a : b;
}

/**
 * Fetch risk assessment data from the skills audit API.
 * Returns an empty object on any error (non-blocking), and without a request
 * when the member turned the Skill safety check off or in a local-only build.
 */
export async function fetchRiskAssessment(
  source: string,
  skillNames: string[],
): Promise<Record<string, SkillRiskInfo>> {
  if (skillNames.length === 0) return {};
  if (!getEffectiveUsageDataPolicy().skillSafetyCheck) return {};
  // A local-only build reports the same "not checked" state.
  if (!allowsAutomaticCall('skills.audit')) return {};

  try {
    const params = new URLSearchParams({
      source,
      skills: skillNames.join(','),
    });
    const url = `${AUDIT_URL}?${params.toString()}`;
    const body = await httpsGet(url, {
      headers: { Accept: 'application/json' },
      timeoutMs: AUDIT_TIMEOUT_MS,
    });
    const data = JSON.parse(body) as AuditResponse;

    const result: Record<string, SkillRiskInfo> = {};

    for (const skillName of skillNames) {
      const audits = data[skillName];
      if (!audits) {
        result[skillName] = { level: 'unknown', socketAlerts: null };
        continue;
      }

      let overall: SkillRiskLevel = 'unknown';
      let socketAlerts: number | null = null;

      // Process each analyzer
      for (const [analyzerName, audit] of Object.entries(audits)) {
        if (analyzerName === 'socket' && audit.alerts !== undefined) {
          socketAlerts = audit.alerts;
          overall = highestRisk(overall, audit.alerts === 0 ? 'safe' : 'high');
        } else {
          overall = highestRisk(overall, toRiskLevel(audit.risk));
        }
      }

      result[skillName] = { level: overall, socketAlerts };
    }

    return result;
  } catch {
    return {};
  }
}
