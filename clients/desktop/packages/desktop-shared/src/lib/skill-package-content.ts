import type {
  PipelinePackageManifestV1,
  PipelinePackageResource,
} from '@canopy/protocol/pipelines';

/**
 * Whether a skill's capability package carries anything the recipient would
 * not get from a definition-only share.
 *
 * The skill analysis always binds the skill itself as a required subject
 * resource — once per provider, so a single-file skill yields a Claude and a
 * Codex resource that each hold nothing but the SKILL.md the share already
 * sends verbatim. Treating that as "has content" committed a package for every
 * skill share, hid the plain one-button share, and made a teammate's re-share
 * of a skill shared before packages existed look like a package change — which
 * the server refuses for anyone but the owner.
 *
 * The skill itself is recognized by content, exactly as the install does: its
 * SKILL.md hashes to the manifest's `pipelineContentHash`. Anything beyond
 * those bare copies counts — a supporting file, an invoked dependency, another
 * skill, or an environment requirement.
 */
export function skillPackageHasContent(
  manifest: PipelinePackageManifestV1 | null | undefined,
): boolean {
  if (!manifest) return false;
  if (manifest.environmentRequirements.length > 0) return true;
  return manifest.resources.some(
    (resource) => !isBareSubjectSkill(resource, manifest.pipelineContentHash),
  );
}

function isBareSubjectSkill(
  resource: PipelinePackageResource,
  contentHash: string,
): boolean {
  return (
    resource.kind === 'standalone_skill' &&
    resource.dependencyResourceIds.length === 0 &&
    resource.trees.length > 0 &&
    resource.trees.every(
      (tree) =>
        tree.entries.length > 0 &&
        tree.entries.every(
          (entry) => entry.path === 'SKILL.md' && entry.sha256 === contentHash,
        ),
    )
  );
}
