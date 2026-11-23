//! The composer's catalogs from existing desktop reads
//! (`DeviceChatComposerRepository`, `device_link/chats/composer.dart`, and
//! `deviceComposerCatalog`, `composer_catalog.dart`): the plugin picker's
//! catalog, the chat's plugin selections and the invocable inventory.
//! Paths, install state and credentials are not presentation data.
use crate::chat::{ChatRef, Thrown, link_string, object};
use crate::dart::{Dv, DvMap};

/// Why a composer read failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogError {
    /// The reply had the wrong shape (`deviceLinkObject`, a cast or a
    /// `FormatException`).
    Thrown(Thrown),
    /// `_data`: the call did not succeed ("Couldn't load choices…").
    NoData,
    /// The chat is a file tab or archived ("The chat is closed…").
    Closed,
}

impl From<Thrown> for CatalogError {
    fn from(t: Thrown) -> Self {
        CatalogError::Thrown(t)
    }
}

/// `_data`: `{success: true, data}`.
pub fn data(value: &Dv) -> Result<&Dv, CatalogError> {
    let result = object(value)?;
    if !result.get("success").is_true() || !result.contains_key("data") {
        return Err(CatalogError::NoData);
    }
    Ok(result.get("data"))
}

/// `_rows`: a list of maps; anything else is a `FormatException`.
fn rows(value: &Dv) -> Result<Vec<&DvMap>, Thrown> {
    let items = match value {
        Dv::List(items) => items,
        _ => return Err(Thrown::Cast),
    };
    items.iter().map(object).collect()
}

fn map(entries: Vec<(&str, Dv)>) -> Dv {
    let mut out = DvMap::new();
    for (k, v) in entries {
        out.insert(k.to_owned(), v);
    }
    Dv::Map(out)
}

/// `deviceComposerCatalog`: the input of `ComposerPluginCatalog.fromJson`.
pub fn plugin_catalog(
    collections: &Dv,
    skills: &Dv,
    plugins: &Dv,
    servers: &Dv,
) -> Result<Dv, Thrown> {
    let marketplaces = rows(object(plugins)?.get("marketplaces"))?;
    let server_rows = rows(object(servers)?.get("servers"))?;
    let collections = rows(collections)?
        .into_iter()
        .map(|c| Dv::Map(c.clone()))
        .collect();
    let skills = rows(skills)?
        .into_iter()
        .map(|skill| {
            map(vec![
                ("sourceId", skill.get("sourceId").clone()),
                ("skillName", skill.get("name").clone()),
                ("name", skill.get("name").clone()),
                ("description", skill.get("description").clone()),
            ])
        })
        .collect();
    let mut plugin_rows = Vec::new();
    for marketplace in marketplaces {
        for plugin in rows(marketplace.get("plugins"))? {
            let support = object(plugin.get("providerSupport"))?;
            // Missing support is unknown, not permission to enable it.
            let claude = support.get("claude").is_str("native");
            let codex = matches!(support.get("codex").as_str(), Some("native" | "compat"));
            plugin_rows.push(map(vec![
                ("marketplaceId", plugin.get("marketplaceId").clone()),
                ("pluginName", plugin.get("name").clone()),
                ("name", plugin.get("name").clone()),
                ("description", plugin.get("description").clone()),
                ("claudeSupported", Dv::Bool(claude)),
                ("codexSupported", Dv::Bool(codex)),
            ]));
        }
    }
    let mut mcp = Vec::new();
    for server in server_rows {
        for config in rows(server.get("configs"))? {
            if config.get("enabled").is_true() {
                mcp.push(map(vec![
                    ("serverId", server.get("id").clone()),
                    ("serverName", server.get("name").clone()),
                    ("configId", config.get("id").clone()),
                    ("configName", config.get("name").clone()),
                    ("description", server.get("description").clone()),
                ]));
            }
        }
    }
    Ok(map(vec![
        ("collections", Dv::List(collections)),
        ("skills", Dv::List(skills)),
        ("plugins", Dv::List(plugin_rows)),
        ("mcpServers", Dv::List(mcp)),
    ]))
}

/// `snapshot`: the chat tab's revision, model, harness and plugin
/// selections (`None` when absent) from `chat:get-state`.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub revision: i64,
    pub model: Dv,
    pub execution_harness: Dv,
    pub selections: Option<DvMap>,
}

/// `snapshot(ref)`.
pub fn snapshot(chat: &ChatRef, state: &Dv) -> Result<Snapshot, CatalogError> {
    let result = object(state)?;
    let file = object(result.get("tabsFile"))?;
    let Dv::Int(revision) = result.get("revision") else {
        return Err(Thrown::Cast.into());
    };
    let Dv::List(tabs) = file.get("tabs") else {
        return Err(Thrown::Cast.into());
    };
    let mut tab = None;
    for t in tabs {
        let t = object(t)?;
        if t.get("id").is_str(&chat.id) {
            tab = Some(t);
            break;
        }
    }
    let Some(tab) = tab else {
        return Err(CatalogError::Closed);
    };
    if tab.get("kind").is_str("file") || !tab.get("archivedAt").is_null() {
        return Err(CatalogError::Closed);
    }
    let selections = match tab.get("pluginSelections") {
        Dv::Null => None,
        value => Some(object(value)?.clone()),
    };
    Ok(Snapshot {
        revision: *revision,
        model: tab.get("model").clone(),
        execution_harness: tab.get("executionHarness").clone(),
        selections,
    })
}

/// One invocable row (`ComposerCommand` of a raw inventory entry).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub name: String,
    pub display_name: Option<String>,
    pub description: String,
    pub entry_id: String,
}

/// `inventory(harness)`: the rows for `harness` and whether a later load
/// can change them (stale or rebuilding).
pub fn inventory(harness: &str, reply: &Dv) -> Result<(Vec<Command>, bool), CatalogError> {
    let result = object(data(reply)?)?;
    let (Dv::List(entries), Dv::Bool(stale), Dv::Bool(rebuilding)) = (
        result.get("entries"),
        result.get("stale"),
        result.get("rebuilding"),
    ) else {
        return Err(Thrown::Cast.into());
    };
    let mut commands = Vec::new();
    for raw in entries {
        let entry = object(raw)?;
        if !entry.get("provider").is_str(harness) {
            continue;
        }
        let name = link_string(entry, "name")?.to_owned();
        let display_name = entry
            .get("displayName")
            .cast_str()
            .map_err(|_| Thrown::Cast)?
            .map(str::to_owned);
        let description = entry
            .get("description")
            .cast_str()
            .map_err(|_| Thrown::Cast)?
            .unwrap_or_default()
            .to_owned();
        let entry_id = link_string(entry, "id")?.to_owned();
        commands.push(Command {
            name,
            display_name,
            description,
            entry_id,
        });
    }
    Ok((commands, *stale || *rebuilding))
}
