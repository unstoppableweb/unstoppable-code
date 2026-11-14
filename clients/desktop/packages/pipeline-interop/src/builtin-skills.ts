/**
 * The `builtin:app` skills every brand ships, as `brand-templates/skills`
 * names them (CAN-6439). A cloud runner stages them with its bundle
 * (`resources/skills`), so a plugin collection default that names one
 * resolves there; the web core, which can't read the bundle, checks a
 * default against these names. The host parity golden keeps them equal to
 * the templates.
 */
export const BUILTIN_APP_SKILL_TEMPLATES: readonly string[] = [
  '{{BRAND_INTERNAL_NAME}}-config',
  '{{BRAND_INTERNAL_NAME}}-pipeline-cli',
  '{{BRAND_INTERNAL_NAME}}-pipeline-writing',
];

/** The `builtin:app` skill names a brand's bundle carries. */
export function builtinAppSkillNames(
  brandInternalName: string,
): ReadonlySet<string> {
  return new Set(
    BUILTIN_APP_SKILL_TEMPLATES.map((template) =>
      template.split('{{BRAND_INTERNAL_NAME}}').join(brandInternalName),
    ),
  );
}
