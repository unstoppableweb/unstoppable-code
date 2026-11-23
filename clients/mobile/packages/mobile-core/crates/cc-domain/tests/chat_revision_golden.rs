//! Golden: Computer Connect chat revision reducer (Rust).
//!
//! Replays `chat:get-state` snapshots, `chat:get-transcript-page` pages and
//! `chat:state-changed` events through the chat state the core keeps for a
//! selected chat, and pins after every step how it applied and what the
//! state holds. The `desktop.*` cases are the payloads the production
//! desktop chat handlers emitted in wire order (a real `ChatStateService`
//! read through the desktop runtime's `chat:get-state`,
//! `chat:get-transcript-page` and `chat:state-changed` paths; see the
//! fixture's `source`); the `gen.*` cases are synthetic and cover the rest
//! of the contract: a duplicate or older revision is ignored; a gap, a
//! non-integer revision, `messages.omitted`, a transcript reset and an
//! unknown `afterMessageId` ask for a fresh snapshot (changes before the
//! stopping one stay applied); message upsert, remove and replace; bodies
//! of an older transcript revision are skipped; tab, runtime and decision
//! changes; invalid shapes fail as Dart's reader did (`invalid` for a
//! `deviceLinkObject`/`deviceLinkString` failure, `cast` for another
//! cast); an older page applies only at the held transcript revision, and
//! a fresh newest page at the same revision keeps the older pages already
//! loaded. Expected values are the Dart `DeviceChatState`'s. A break would
//! show a chat out of step with the desktop.
//!
//! Fixture: `tests/fixtures/chat_revision.json` (plain JSON; `$number` and
//! `$date` tags as the core's bridge form).
use cc_domain::{
    chat::{Applied, ChatRef, ChatState, Thrown, Uids, object},
    dart::{Dv, DvMap},
};
use serde_json::{Map, Number, Value, json};

fn dv(value: &Value) -> Dv {
    match value {
        Value::Null => Dv::Null,
        Value::Bool(b) => Dv::Bool(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Dv::Int(i),
            None => Dv::Float(n.as_f64().unwrap_or(f64::NAN)),
        },
        Value::String(s) => Dv::Str(s.clone()),
        Value::Array(items) => Dv::List(items.iter().map(dv).collect()),
        Value::Object(o) if o.len() == 1 && o.contains_key("$number") => {
            Dv::Float(match o["$number"].as_str() {
                Some("Infinity") => f64::INFINITY,
                Some("-Infinity") => f64::NEG_INFINITY,
                _ => f64::NAN,
            })
        }
        Value::Object(o) if o.len() == 1 && o.contains_key("$date") => {
            Dv::Date(o["$date"].as_i64().expect("date"))
        }
        Value::Object(o) => {
            let mut map = DvMap::new();
            for (k, v) in o {
                map.insert(k.clone(), dv(v));
            }
            Dv::Map(map)
        }
    }
}

fn json_of(value: &Dv) -> Value {
    match value {
        Dv::Null => Value::Null,
        Dv::Bool(b) => Value::Bool(*b),
        Dv::Int(n) => json!(n),
        Dv::Float(f) => match Number::from_f64(*f) {
            Some(n) => Value::Number(n),
            None if f.is_nan() => json!({"$number": "NaN"}),
            None if *f > 0.0 => json!({"$number": "Infinity"}),
            None => json!({"$number": "-Infinity"}),
        },
        Dv::Str(s) => json!(s),
        Dv::Bytes(_) => panic!("no bytes in the fixture"),
        Dv::Date(ms) => json!({"$date": ms}),
        Dv::List(items) => Value::Array(items.iter().map(json_of).collect()),
        Dv::Map(map) => map_json(map),
    }
}

fn map_json(map: &DvMap) -> Value {
    let mut out = Map::new();
    for (k, v) in map.iter() {
        out.insert(k.to_owned(), json_of(v));
    }
    Value::Object(out)
}

/// A message as the fixture pins it: id, role and its first words.
fn fingerprint(raw: &DvMap) -> Value {
    let text = raw.get("blocks").elements().and_then(|blocks| {
        blocks.into_iter().find_map(|b| match b {
            Dv::Map(b) if b.get("type").is_str("text") => b
                .get("text")
                .as_str()
                .map(|t| t.chars().take(40).collect::<String>()),
            _ => None,
        })
    });
    json!([json_of(raw.get("id")), json_of(raw.get("role")), text])
}

fn digest(s: &ChatState) -> Value {
    json!({
        "revision": s.revision,
        "transcriptRevision": s.transcript_revision,
        "before": s.before,
        "total": s.total_messages,
        "closed": s.closed,
        "title": s.title(),
        "running": s.running(),
        "awaiting": s.awaiting_input(),
        "decision": s.has_pending_decision(),
        "runtimeError": s.runtime_error(),
        "tab": map_json(&s.tab),
        "runtime": map_json(&s.runtime),
        "scopeTabs": s.scope.tabs.iter().map(map_json).collect::<Vec<_>>(),
        "scopeRuntime": map_json(&s.scope.runtime),
        "questions": s.scope.questions.iter().map(map_json).collect::<Vec<_>>(),
        "approvals": s.scope.approvals.iter().map(map_json).collect::<Vec<_>>(),
        "messages": s.messages.iter().map(|m| fingerprint(&m.raw)).collect::<Vec<_>>(),
    })
}

fn thrown(t: Thrown) -> &'static str {
    match t {
        Thrown::Invalid => "invalid",
        Thrown::Cast => "cast",
    }
}

/// One step as the chats repository drives the state: a hydrate replaces
/// it (keeping older pages at the same transcript revision), an event
/// applies to it, an older page is checked (`ChatState::accepts_older`, as
/// `cc-app`'s `prepend` checks it) and prepended.
fn step(
    state: &mut Option<ChatState>,
    chat: &ChatRef,
    op: &Value,
    uids: &mut Uids,
) -> &'static str {
    match op["op"].as_str().expect("op") {
        "hydrate" => {
            let (snapshot, page) = (dv(&op["snapshot"]), dv(&op["page"]));
            let next = (|| -> Result<ChatState, Thrown> {
                let mut next = ChatState::new(chat.clone());
                next.hydrate(object(&snapshot)?, object(&page)?, uids)?;
                if let Some(previous) = state.as_ref() {
                    next.retain_older(previous)?;
                }
                Ok(next)
            })();
            match next {
                Ok(next) => {
                    *state = Some(next);
                    "done"
                }
                Err(t) => thrown(t),
            }
        }
        "apply" => {
            let Some(current) = state.as_mut() else {
                return "none";
            };
            let event = dv(&op["event"]);
            match object(&event).and_then(|e| current.apply(e, uids)) {
                Ok(Applied::Done) => "done",
                Ok(Applied::Resync) => "resync",
                Err(t) => thrown(t),
            }
        }
        "older" => {
            let Some(current) = state.as_mut() else {
                return "none";
            };
            let revision = op["revision"].as_i64().expect("revision");
            let page = dv(&op["page"]);
            let page = match object(&page) {
                Ok(page) => page,
                Err(t) => return thrown(t),
            };
            if !current.accepts_older(page, revision) {
                return "history";
            }
            match current.prepend_page(page, uids) {
                Ok(()) => "done",
                Err(t) => thrown(t),
            }
        }
        other => panic!("unknown op {other}"),
    }
}

#[test]
fn chat_revisions_apply_as_the_desktop_contract_requires() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/chat_revision.json")).expect("fixture parses");
    let cases = fixture["cases"].as_array().expect("cases");
    assert!(cases.len() >= 9, "every contract case is present");
    let mut mismatches = Vec::new();
    let mut outcomes = std::collections::BTreeSet::new();
    for case in cases {
        let c = &case["chat"];
        let chat = ChatRef {
            project_id: c["projectId"].as_str().expect("projectId").into(),
            worktree_id: c["worktreeId"].as_str().expect("worktreeId").into(),
            id: c["id"].as_str().expect("id").into(),
            title: c["title"].as_str().expect("title").into(),
        };
        let (mut state, mut uids) = (None, Uids::default());
        for (i, op) in case["steps"].as_array().expect("steps").iter().enumerate() {
            let outcome = step(&mut state, &chat, op, &mut uids);
            outcomes.insert(format!("{}:{outcome}", op["op"].as_str().unwrap_or("")));
            let got = json!({"outcome": outcome, "state": state.as_ref().map(digest)});
            if got != op["expect"] {
                mismatches.push(format!(
                    "{} step {i} ({}): expected {} got {}",
                    case["name"], op["op"], op["expect"]["outcome"], got["outcome"]
                ));
            }
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
    for required in [
        "apply:done",
        "apply:resync",
        "apply:invalid",
        "apply:cast",
        "hydrate:done",
        "hydrate:invalid",
        "hydrate:cast",
        "older:done",
        "older:history",
    ] {
        assert!(outcomes.contains(required), "fixture covers {required}");
    }
}

/// The recorded `older` step that answers `history` fails both halves of
/// the check at once: it asks at another revision than the held one, and
/// its page is from the held one. Each half alone refuses a page too: a
/// page of another transcript revision asked at the held one, and a page
/// asked and answered at a revision the state no longer holds. Either way
/// the state is unchanged.
#[test]
fn an_older_page_of_another_transcript_revision_is_history() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/chat_revision.json")).expect("fixture parses");
    let case = fixture["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["name"] == "gen.older_pages_and_retention")
        .expect("older pages case");
    let c = &case["chat"];
    let chat = ChatRef {
        project_id: c["projectId"].as_str().expect("projectId").into(),
        worktree_id: c["worktreeId"].as_str().expect("worktreeId").into(),
        id: c["id"].as_str().expect("id").into(),
        title: c["title"].as_str().expect("title").into(),
    };
    let steps = case["steps"].as_array().expect("steps");
    let (mut state, mut uids) = (None, Uids::default());
    let mut outcome = "";
    for op in &steps[..4] {
        outcome = step(&mut state, &chat, op, &mut uids);
    }
    let held = steps[3]["expect"].clone();
    assert_eq!(
        json!({"outcome": outcome, "state": state.as_ref().map(digest)}),
        held
    );

    let recorded = &steps[4];
    assert_eq!(recorded["op"], "older");
    let revision = held["state"]["transcriptRevision"].clone();
    assert_eq!(recorded["revision"], revision, "asked at the held revision");
    let earlier = json!(revision.as_i64().expect("revision") - 1);
    let mut other_page = recorded.clone();
    other_page["page"]["transcriptRevision"] = earlier.clone();
    let mut no_longer_held = other_page.clone();
    no_longer_held["revision"] = earlier;
    for (op, why) in [
        (&other_page, "a page of another revision"),
        (&no_longer_held, "a page of a revision no longer held"),
    ] {
        let outcome = step(&mut state, &chat, op, &mut uids);
        assert_eq!(
            json!({"outcome": outcome, "state": state.as_ref().map(digest)}),
            held,
            "{why} is history and changes nothing"
        );
    }
    // The page as recorded still applies.
    let outcome = step(&mut state, &chat, recorded, &mut uids);
    assert_eq!(
        json!({"outcome": outcome, "state": state.as_ref().map(digest)}),
        recorded["expect"]
    );
}
