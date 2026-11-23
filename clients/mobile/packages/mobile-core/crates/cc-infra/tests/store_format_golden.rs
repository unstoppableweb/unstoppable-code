//! Golden: Computer Connect encrypted store format (Rust).
//!
//! One committed database per released schema, written with a fixed test
//! wrapping key: `fixtures/store-v1.sqlite` (plaintext scope/key rows, read
//! once and migrated) and `fixtures/store-v2.sqlite` (the current sealed
//! layout). Both still read back the installation identity, its pins, the
//! session token and 2FA proof, the validated user and app state, and v2 the
//! saved computers, (since P5b) a computer's chat drafts record, (since
//! P8) its Home drafts and choices records and (since P9) its Orchestrator
//! chat drafts record. The migrated v1 rows leave no plaintext account or
//! computer id in the closed database or its WAL. A pairing seed written by
//! the current identity writer is in no database file in the clear, as
//! base64url or raw bytes, while the store is open or after it closes. A wrong
//! key fails closed and erases nothing. Fixtures are regenerated only when
//! the format changes on purpose (`tests/__scratch__/main.rs`).
use cc_app::ports::{DraftsRecord, HomeRecord};
use cc_infra::Store;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const KEY: [u8; 32] = [0x11; 32];
const WRONG_KEY: [u8; 32] = [0x12; 32];
const SCOPE: &str = "https://app.canopy.invalid/";
const ACCOUNT: &str = "user-fixture-1";
const DEVICE_ID: &str = "SMypf4mT_668rJco1_lPcQ";
const PUBLIC_KEY: &str = "iEuIV_TqoWE8YVBNs01L6vNGUXoOMd483dTZtCAdnQs";
const PEER: &str = "MJfi3uLLSjS1OEDNtwWu1w";
const PEER_KEY: &str = "IVL40Zt5HSRFMkLhXy6rbLfP-ntqXtMAl5YOBpiB2xI";

/// A private copy of a fixture: opening a store may migrate and checkpoint.
fn copy(name: &str) -> (tempdir::Dir, PathBuf) {
    let dir = tempdir::Dir::new(name);
    let path = dir.0.join("core.sqlite");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    std::fs::copy(fixture, &path).expect("copy fixture");
    (dir, path)
}

mod tempdir {
    pub(crate) struct Dir(pub(crate) std::path::PathBuf);
    impl Dir {
        pub(crate) fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "cc-store-golden-{name}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("temp dir");
            Self(path)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn open(path: &Path, key: [u8; 32]) -> Store {
    Store::open(path.to_str().expect("path"), key, SCOPE.into()).expect("opens")
}

/// Every stored row: v1 `records` and the sealed `sealed` and `meta`
/// tables, whichever exist.
fn rows(path: &Path) -> Vec<String> {
    let db = rusqlite::Connection::open(path).expect("sqlite");
    let mut rows = Vec::new();
    for table in ["records", "sealed", "meta"] {
        let Ok(mut stmt) = db.prepare(&format!("SELECT * FROM {table}")) else {
            continue;
        };
        let columns = stmt.column_count();
        let mut query = stmt.query([]).expect("query");
        while let Some(row) = query.next().expect("row") {
            let cells: Vec<String> = (0..columns)
                .map(|i| format!("{:?}", row.get_ref(i).expect("cell")))
                .collect();
            rows.push(format!("{table}: {}", cells.join(" | ")));
        }
    }
    rows.sort();
    rows
}

/// Every file of the database, for the plaintext check.
fn files(dir: &Path) -> Vec<Vec<u8>> {
    std::fs::read_dir(dir)
        .expect("dir")
        .map(|e| std::fs::read(e.expect("entry").path()).expect("read"))
        .collect()
}

fn assert_reads_back(store: &Store, saved: bool) {
    let identity = store.identity().expect("identity");
    assert_eq!(identity.device_id, DEVICE_ID);
    assert_eq!(identity.public_key, PUBLIC_KEY);
    assert_eq!(*identity.seed(), [0x21; 32]);
    assert_eq!(
        store.pins().expect("pins").into_iter().collect::<Vec<_>>(),
        vec![(PEER.to_owned(), PEER_KEY.to_owned())]
    );
    assert_eq!(
        store.session().expect("session"),
        Some(json!({"token": "secret-session", "twoFactorProof": "secret-proof"}))
    );
    assert_eq!(
        store.user().expect("user"),
        Some(json!({"id": ACCOUNT, "email": "fixture@local.invalid"}))
    );
    assert_eq!(
        store
            .app_state_get(ACCOUNT, "preferences")
            .expect("app state"),
        Some(json!({ "selected": PEER }))
    );
    if saved {
        let record: Value = store
            .saved_computers(ACCOUNT)
            .expect("saved computers")
            .expect("a record");
        assert_eq!(record["selectedId"], PEER);
        assert_eq!(
            record["computers"],
            json!([{"id": PEER, "name": "Fixture Mac", "reconnect": true}])
        );
        // P5b: one sealed drafts record per account and computer, in the
        // shape `cc-app::chats::drafts` reads.
        assert_eq!(
            store.chat_drafts(ACCOUNT, PEER).expect("drafts"),
            Some(json!({"v": 1, "drafts": {
                "proj-1/wt-2/chat-3": {"text": "Szkic 🌲 漢字 — secret-draft", "updatedAtMs": 1_795_000_000_000_i64},
                "proj-1/wt-1/chat-1": {"text": "line one\nline two", "updatedAtMs": 1_795_000_100_000_i64},
            }}))
        );
        assert_eq!(
            store
                .chat_drafts("user-fixture-2", PEER)
                .expect("other account"),
            None
        );
        // P8: Home's drafts and choices, one sealed record each per account
        // and computer, in the shapes `cc-app::home` reads.
        assert_eq!(
            store
                .home(ACCOUNT, PEER, HomeRecord::Drafts)
                .expect("home drafts"),
            Some(json!({"v": 1, "drafts": {
                "personal": {"text": "Napisz testy 🌲 — secret-home-draft", "updatedAtMs": 1_795_000_200_000_i64},
                "organization:org-1": {"text": "Plan Q4", "updatedAtMs": 1_795_000_300_000_i64},
            }}))
        );
        assert_eq!(
            store
                .home(ACCOUNT, PEER, HomeRecord::Choices)
                .expect("home choices"),
            Some(json!({"v": 1, "choices": {
                "personal": {"projectId": "proj-1", "worktreeId": "wt-2", "baseBranch": "origin/main",
                             "modelId": "claude-opus-4-5", "executionHarness": null, "thinkingLevel": "high"},
            }}))
        );
        assert_eq!(
            store
                .home("user-fixture-2", PEER, HomeRecord::Drafts)
                .expect("other account"),
            None
        );
        // P9: the Orchestrator chat's drafts, apart from the chats' record.
        assert_eq!(
            store
                .drafts(ACCOUNT, PEER, DraftsRecord::Orchestrator)
                .expect("orchestrator drafts"),
            Some(json!({"v": 1, "drafts": {
                "app-advisor/wt-orch/chat-orch-1": {"text": "Zaplanuj wydanie 🌲 — secret-orchestrator-draft", "updatedAtMs": 1_795_000_400_000_i64},
            }}))
        );
        assert_eq!(
            store
                .drafts("user-fixture-2", PEER, DraftsRecord::Orchestrator)
                .expect("other account"),
            None
        );
    }
}

/// Unpadded base64url, the encoding of the stored identity record's seed.
fn base64url(bytes: &[u8]) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The seed as the identity record serializes it, and its raw bytes.
fn seed_forms(seed: &[u8; 32]) -> Vec<Vec<u8>> {
    let encoded = base64url(seed);
    vec![
        encoded.clone().into_bytes(),
        format!("\"seed\":\"{encoded}\"").into_bytes(),
        seed.to_vec(),
    ]
}

/// Fails when any file of the database (main file, WAL, shared memory)
/// holds one of `secrets` in the clear.
fn assert_sealed(dir: &Path, secrets: &[Vec<u8>]) {
    let files: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir)
        .expect("dir")
        .map(|e| {
            let path = e.expect("entry").path();
            let name = path.file_name().expect("name").to_string_lossy().into();
            (name, std::fs::read(path).expect("read"))
        })
        .collect();
    assert!(files.iter().any(|(n, _)| n == "core.sqlite"));
    for (name, bytes) in &files {
        for secret in secrets {
            assert!(
                !bytes.windows(secret.len()).any(|w| w == secret.as_slice()),
                "{name} holds {:?} in the clear",
                String::from_utf8_lossy(secret)
            );
        }
    }
}

#[test]
fn current_store_reads_back() {
    let (dir, path) = copy("store-v2.sqlite");
    assert_reads_back(&open(&path, KEY), true);
    // Secrets are sealed: no token, proof or seed in the clear.
    let mut secrets: Vec<Vec<u8>> = [
        "secret-session",
        "secret-proof",
        "user-fixture-1",
        "secret-draft",
        "secret-home-draft",
        "secret-orchestrator-draft",
    ]
    .iter()
    .map(|s| s.as_bytes().to_vec())
    .collect();
    secrets.extend(seed_forms(&[0x21; 32]));
    assert_sealed(&dir.0, &secrets);
}

#[test]
fn identity_writer_seals_the_pairing_seed() {
    // A seed written by the current identity writer into a new store, then
    // rewritten with a pin; the fixtures only hold seeds written earlier.
    let seed = [0x5a; 32];
    let encoded = base64url(&seed);
    let dir = tempdir::Dir::new("identity-writer");
    let path = dir.0.join("core.sqlite");
    let store = open(&path, KEY);
    assert_eq!(store.existing_identity().expect("empty").map(|_| ()), None);
    let imported = store
        .identity_import(&encoded, &Value::Null, false)
        .expect("import");
    assert_eq!(imported["replaced"], false);
    store.remember_pin(PEER, PEER_KEY).expect("pin");
    assert_eq!(*store.identity().expect("identity").seed(), seed);
    // While the store is open, the record is in the WAL.
    assert_sealed(&dir.0, &seed_forms(&seed));
    drop(store);
    assert_sealed(&dir.0, &seed_forms(&seed));
    // Closed and reopened, the sealed seed reads back.
    let store = open(&path, KEY);
    assert_eq!(*store.identity().expect("identity").seed(), seed);
    assert_eq!(store.pin(PEER).expect("pin").as_deref(), Some(PEER_KEY));
}

/// Whether any file of the database holds `needle` in the clear.
fn in_clear(dir: &Path, needle: &str) -> bool {
    files(dir)
        .iter()
        .any(|bytes| bytes.windows(needle.len()).any(|w| w == needle.as_bytes()))
}

#[test]
fn v1_store_migrates_and_reads_back() {
    let (dir, path) = copy("store-v1.sqlite");
    // v1 keys name the account and the paired computer in the clear.
    for id in [ACCOUNT, PEER] {
        assert!(in_clear(&dir.0, id), "{id} in the v1 fixture");
    }
    assert_reads_back(&open(&path, KEY), false);
    // Once the store closes, the migrated rows leave neither id in the
    // database's free pages or its WAL.
    for id in [ACCOUNT, PEER] {
        assert!(!in_clear(&dir.0, id), "{id} recoverable after migration");
    }
    // The migration is durable: a second open reads the same.
    let store = open(&path, KEY);
    assert_reads_back(&store, false);
    // The v1 rows are gone: a cleared session stays cleared on reopen.
    store.clear_session().expect("clear session");
    drop(store);
    let store = open(&path, KEY);
    assert_eq!(store.session().expect("session"), None);
    assert_eq!(store.identity().expect("identity").device_id, DEVICE_ID);
}

#[test]
fn a_wrong_key_fails_closed_and_erases_nothing() {
    for (name, saved) in [("store-v2.sqlite", true), ("store-v1.sqlite", false)] {
        let (_dir, path) = copy(name);
        let before = rows(&path);
        assert!(!before.is_empty());
        {
            let store = open(&path, WRONG_KEY);
            for code in [
                store.identity().err().map(|e| e.code),
                store.pins().err().map(|e| e.code),
                store.session().err().map(|e| e.code),
                store
                    .app_state_get(ACCOUNT, "preferences")
                    .err()
                    .map(|e| e.code),
                store.put_session("other", None).err().map(|e| e.code),
                store.chat_drafts(ACCOUNT, PEER).err().map(|e| e.code),
                store
                    .home(ACCOUNT, PEER, HomeRecord::Choices)
                    .err()
                    .map(|e| e.code),
                store
                    .drafts(ACCOUNT, PEER, DraftsRecord::Orchestrator)
                    .err()
                    .map(|e| e.code),
            ] {
                assert_eq!(code.as_deref(), Some("storage_corrupt"), "{name}");
            }
        }
        assert_eq!(rows(&path), before, "{name}: every record kept");
        // The right key still reads everything.
        assert_reads_back(&open(&path, KEY), saved);
    }
}
