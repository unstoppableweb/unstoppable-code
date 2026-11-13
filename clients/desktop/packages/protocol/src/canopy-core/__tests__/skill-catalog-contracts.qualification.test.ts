import { CANOPY_INSTRUCTION_DEFINITIONS, CANOPY_QUERY_DEFINITIONS } from '..';
import {
  CORE_CATALOG_SKILL_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_SKILL_QUERY_DEFINITIONS,
  CatalogSkillCustomSaveParamsSchema,
  CatalogSkillDiscoverResultSchema,
  CatalogSkillInstallParamsSchema,
  CatalogSkillInstallResultSchema,
  CatalogSkillReadResultSchema,
  CatalogSkillRefSchema,
  CatalogSkillRemoveParamsSchema,
  CatalogSkillRowSchema,
  CatalogSkillUpdateParamsSchema,
  CatalogSkillUpdatesCheckParamsSchema,
} from '../core';

const meta = { idempotencyKey: 'k' };
const ref = { sourceId: 'github:o:r', skillName: 'x' };

const customSave = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name: 'n',
  originalName: null,
  description: 'd',
  body: 'b',
  extraMetadata: null,
  preservedMetadata: null,
  files: null,
  _meta: meta,
  ...overrides,
});

describe('skill catalog contracts (CAN-4124)', () => {
  it('refs are bounded, not path-validated', () => {
    expect(
      CatalogSkillRefSchema.safeParse({ sourceId: '..', skillName: 'x' })
        .success,
    ).toBe(true);
    expect(
      CatalogSkillRefSchema.safeParse({ sourceId: '', skillName: 'x' }).success,
    ).toBe(false);
    expect(
      CatalogSkillRefSchema.safeParse({
        sourceId: 'custom:app',
        skillName: 'x'.repeat(513),
      }).success,
    ).toBe(false);
    expect(
      CatalogSkillRefSchema.safeParse({ ...ref, extra: true }).success,
    ).toBe(false);
  });

  it("custom saves keep the editor's distinctions", () => {
    const keep = CatalogSkillCustomSaveParamsSchema.parse(customSave());
    const clear = CatalogSkillCustomSaveParamsSchema.parse(
      customSave({ files: [] }),
    );
    expect(keep.files).toBeNull();
    expect(clear.files).toEqual([]);
    expect(
      CatalogSkillCustomSaveParamsSchema.safeParse(
        customSave({ files: [{ path: 'notes.md', content: null }] }),
      ).success,
    ).toBe(true);
    expect(
      CatalogSkillCustomSaveParamsSchema.safeParse(
        customSave({
          preservedMetadata: {
            tags: ['a', ['b']],
            weight: 2,
            pinned: true,
            nested: { list: [1, false, null] },
          },
        }),
      ).success,
    ).toBe(true);
    const withoutOriginalName = customSave();
    delete withoutOriginalName.originalName;
    expect(
      CatalogSkillCustomSaveParamsSchema.safeParse(withoutOriginalName).success,
    ).toBe(false);
  });

  it('keyed instructions need an idempotency key', () => {
    const cases = [
      {
        schema: CatalogSkillInstallParamsSchema,
        value: { source: 'o/r', skillNames: ['x'] },
      },
      { schema: CatalogSkillUpdateParamsSchema, value: { skill: ref } },
      { schema: CatalogSkillRemoveParamsSchema, value: { skill: ref } },
      { schema: CatalogSkillCustomSaveParamsSchema, value: customSave() },
      { schema: CatalogSkillUpdatesCheckParamsSchema, value: {} },
    ];
    for (const { schema, value } of cases) {
      expect(schema.safeParse({ ...value, _meta: meta }).success).toBe(true);
      expect(schema.safeParse({ ...value, _meta: {} }).success).toBe(false);
    }
  });

  it('sizes the skill wire limits for real skills (CAN-5873)', () => {
    // openai/plugins offers 536 skills; discovery returns at most 5,000.
    const names = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => `skill-${index}`);
    const install = (count: number): boolean =>
      CatalogSkillInstallParamsSchema.safeParse({
        source: 'openai/plugins',
        skillNames: names(count),
        _meta: meta,
      }).success;
    expect(install(536)).toBe(true);
    expect(install(5000)).toBe(true);
    expect(install(5001)).toBe(false);
    expect(
      CatalogSkillDiscoverResultSchema.safeParse({
        source: 'openai/plugins',
        skills: names(5000).map((name) => ({
          name,
          description: '',
          sourcePath: name,
        })),
        riskInfo: {},
        hasMarketplace: false,
        truncated: false,
      }).success,
    ).toBe(true);

    // Recorded outcomes from before CAN-5873 still decode.
    const recorded = {
      sourceId: 'github:o:r',
      entryIds: ['skill:github:o:r/x'],
    };
    expect(CatalogSkillInstallResultSchema.parse(recorded)).toEqual(recorded);
    expect(
      CatalogSkillInstallResultSchema.safeParse({
        ...recorded,
        installedCount: 536,
      }).success,
    ).toBe(true);

    // Frontmatter values past the old 32,768-character bound, up to 262,144 UTF-8 bytes.
    const read = (value: unknown): boolean =>
      CatalogSkillReadResultSchema.safeParse({
        entryId: 'skill:custom:app/x',
        frontmatter: { metadata: value },
        body: '',
        truncated: false,
      }).success;
    const save = (value: unknown): boolean =>
      CatalogSkillCustomSaveParamsSchema.safeParse(
        customSave({ preservedMetadata: { metadata: value } }),
      ).success;
    for (const accepted of [
      'x'.repeat(40_000),
      'x'.repeat(262_142),
      'é'.repeat(32_768),
      Array.from({ length: 2_000 }, (_, index) => index),
    ]) {
      expect(read(accepted)).toBe(true);
      expect(save(accepted)).toBe(true);
    }
    expect(read('x'.repeat(262_143))).toBe(false);
    expect(save('é'.repeat(131_072))).toBe(false);
  });

  it('a skill row links its cloud copy by ids and hashes only (CAN-6176)', () => {
    const row = {
      entryId: 'skill:custom/helper',
      sourceId: 'custom',
      skillName: 'helper',
      description: 'd',
      source: 'Custom',
      origin: 'custom',
      installedAt: '',
      updatedAt: '',
      updateAvailable: false,
      version: null,
    };
    const hash = 'a'.repeat(64);
    const cloudShare = {
      role: 'author',
      remoteId: '11111111-2222-4333-8444-555555555555',
      linkedContentHash: hash,
      localContentHash: null,
    };
    const parse = (value: unknown): boolean =>
      CatalogSkillRowSchema.safeParse({ ...row, cloudShare: value }).success;
    expect(CatalogSkillRowSchema.safeParse(row).success).toBe(true);
    expect(parse(cloudShare)).toBe(true);
    expect(parse({ ...cloudShare, role: 'recipient' })).toBe(true);
    expect(parse({ ...cloudShare, accessToken: 'secret' })).toBe(false);
    expect(parse({ ...cloudShare, publicLink: 'https://x' })).toBe(false);
    expect(parse({ ...cloudShare, linkedContentHash: 'sha256:' + hash })).toBe(
      false,
    );
    expect(parse({ ...cloudShare, remoteId: '' })).toBe(false);
  });

  it('skill operations stay out of the composed registries', () => {
    const names = [
      ...Object.keys(CORE_CATALOG_SKILL_QUERY_DEFINITIONS),
      ...Object.keys(CORE_CATALOG_SKILL_INSTRUCTION_DEFINITIONS),
    ];
    expect(names).toHaveLength(10);
    for (const name of names) {
      expect(Object.keys(CANOPY_QUERY_DEFINITIONS)).not.toContain(name);
      expect(Object.keys(CANOPY_INSTRUCTION_DEFINITIONS)).not.toContain(name);
    }
  });
});
