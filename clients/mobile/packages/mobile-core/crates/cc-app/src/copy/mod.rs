//! User-visible copy the core puts in view fields, one module per feature
//! (architecture §5.1a). Nothing outside `copy/` builds user-visible text.
//! Ported strings keep the Dart wording exactly; the copy checks scan this
//! directory.
pub(crate) mod activity;
pub(crate) mod chats;
pub(crate) mod composer;
pub(crate) mod computers;
pub(crate) mod home;
pub(crate) mod orchestrator;
pub(crate) mod overview;
pub(crate) mod pipelines;
pub(crate) mod projects;
pub(crate) mod usage;
pub(crate) mod work;
pub(crate) mod worktrees;

/// Fills `{name}` placeholders in one pass, so an argument's own braces
/// stay as they are. An unknown placeholder is kept.
pub(crate) fn render(template: &str, args: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let value = after.find('}').and_then(|close| {
            let name = &after[..close];
            args.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value, close))
        });
        match value {
            Some((value, close)) => {
                out.push_str(value);
                rest = &after[close + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}
