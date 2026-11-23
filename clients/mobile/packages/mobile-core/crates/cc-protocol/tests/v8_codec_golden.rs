//! Golden: Computer Connect wire contract (Rust), messages.
//!
//! Desktop messages recorded from the desktop's own encoder (Node
//! `v8.serialize`, deflate, fragments) read as the pinned bridge values; the
//! messages the core writes match the bytes the desktop decoder accepted when
//! the fixture was recorded; fragmentation and size bounds hold; desktop
//! refusals keep their code and a bounded message. Lost requests and
//! timeouts are what a session reports, so they run in `cc-infra`'s
//! `session_close_golden`: which request a closing session fails how, a
//! withheld answer timing out and a refusal reaching its caller.
//! Fixture:
//! `tests/fixtures/v8_vectors.json`, regenerated only on an intended
//! contract change.
use base64::{Engine, engine::general_purpose::STANDARD};
use cc_protocol::{
    FailureKind,
    rpc::{self, MIN_PROTOCOL},
    v8::{Assembler, encode},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Write;

/// The largest fragment body (`MAX_FRAGMENT_BYTES` on the desktop).
const FRAGMENT: usize = 65_470;

/// The fixture nests deeper than serde's default recursion limit.
fn vectors() -> Value {
    let mut de = serde_json::Deserializer::from_str(include_str!("fixtures/v8_vectors.json"));
    de.disable_recursion_limit();
    serde::Deserialize::deserialize(&mut de).expect("fixture parses")
}

/// Decoding 128-deep values recurses; debug builds need a larger stack.
fn with_stack(f: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(256 << 20)
        .spawn(f)
        .expect("thread")
        .join()
        .expect("no panic");
}

fn frames(case: &Value) -> Vec<Vec<u8>> {
    case["frames"]
        .as_array()
        .expect("frames")
        .iter()
        .map(|f| {
            STANDARD
                .decode(f.as_str().expect("base64"))
                .expect("base64")
        })
        .collect()
}

fn read(frames: &[Vec<u8>]) -> Value {
    let mut assembler = Assembler::default();
    for (i, frame) in frames.iter().enumerate() {
        match assembler.push(frame) {
            Ok(Some(value)) => {
                assert_eq!(i + 1, frames.len(), "value before the final fragment");
                return json!({ "ok": value });
            }
            Ok(None) => {}
            Err(error) => return json!({ "error": error.code }),
        }
    }
    panic!("no final fragment");
}

#[test]
fn desktop_messages_read_as_bridge_values() {
    with_stack(|| {
        let vectors = vectors();
        let cases = vectors["decode"].as_array().expect("decode cases");
        assert!(cases.len() >= 30);
        for case in cases {
            let name = case["name"].as_str().expect("name");
            let result = read(&frames(case));
            // As text: V8 integers and doubles are distinct bridge values.
            match case.get("result_json") {
                Some(expected) => {
                    assert_eq!(serde_json::to_string(&result).unwrap(), *expected, "{name}")
                }
                None => {
                    let digest: String = Sha256::digest(serde_json::to_string(&result).unwrap())
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect();
                    assert_eq!(digest, case["result_sha256"], "{name}");
                }
            }
        }
    });
}

#[test]
fn phone_messages_are_written_as_the_desktop_reads_them() {
    with_stack(|| {
        let vectors = vectors();
        for case in vectors["encode"].as_array().expect("encode cases") {
            let name = case["name"].as_str().expect("name");
            let written = encode(&case["bridge"]).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            assert_eq!(written, frames(case), "{name}");
            // Every fragment but the last is full; only the last is final.
            for (i, fragment) in written.iter().enumerate() {
                let last = i + 1 == written.len();
                assert_eq!(fragment[0], u8::from(last), "{name} flags");
                if !last {
                    assert_eq!(fragment.len(), FRAGMENT + 1, "{name} size");
                }
            }
        }
    });
}

fn deflate(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(bytes).expect("deflate");
    encoder.finish().expect("deflate")
}

#[test]
fn fragment_and_size_bounds() {
    let small = encode(&json!({"v": 1})).expect("encodes");
    let body = &small[0][1..];
    // Empty fragments, unknown flags (including transport control) and short
    // non-final fragments are malformed.
    for bad in [
        vec![],
        [vec![4], body.to_vec()].concat(),
        [vec![0], body.to_vec()].concat(),
    ] {
        assert_eq!(
            Assembler::default().push(&bad).err().map(|e| e.code),
            Some("malformed_v8".to_owned())
        );
    }
    // A message keeps one compression flag across its fragments. The
    // desktop's two-fragment compressed message reads; with only its first
    // fragment marked uncompressed, the same bytes would still inflate as one
    // deflate stream, so only the flag check refuses them.
    let compressed = vectors()["decode"]
        .as_array()
        .expect("decode cases")
        .iter()
        .find(|case| case["name"] == "size.compressed_fragments")
        .map(frames)
        .expect("compressed fragments case");
    assert_eq!(
        compressed.iter().map(|f| f[0]).collect::<Vec<_>>(),
        [2, 3],
        "compressed, then compressed and final"
    );
    assert!(read(&compressed).get("ok").is_some());
    let mut mixed = compressed.clone();
    mixed[0][0] = 0;
    assert_eq!(read(&mixed)["error"], "malformed_v8", "mixed flags refused");
    // A compressed message reads; one that inflates past 12 MiB does not.
    assert_eq!(
        Assembler::default()
            .push(&[vec![3u8], deflate(body)].concat())
            .expect("compressed message"),
        Some(json!({"v": 1}))
    );
    // Zero padding after a value decodes, so only the size limit refuses the
    // padded message below.
    let padded = deflate(&[body, &vec![0u8; 1024]].concat());
    assert_eq!(
        Assembler::default()
            .push(&[vec![3u8], padded].concat())
            .expect("padded message"),
        Some(json!({"v": 1}))
    );
    let bomb = deflate(&[body, &vec![0u8; 13 * 1024 * 1024]].concat());
    assert!(bomb.len() < FRAGMENT);
    assert!(
        Assembler::default()
            .push(&[vec![3u8], bomb].concat())
            .is_err()
    );
    // The core refuses to write a message over 16 MiB.
    assert!(encode(&json!({"v": "x".repeat(17 * 1024 * 1024)})).is_err());
}

#[test]
fn refusals_envelopes_and_versions() {
    // A refusal keeps the desktop's code and the first 4096 UTF-16 units of
    // its message, never splitting a surrogate pair.
    let long = format!("{}🦀tail", "a".repeat(4095));
    let refused = rpc::refusal(&json!({"code": "remote_channel_unavailable", "message": long}));
    assert_eq!(refused.kind, FailureKind::Refused);
    assert_eq!(refused.code, "remote_channel_unavailable");
    assert_eq!(refused.message.as_deref(), Some("a".repeat(4095).as_str()));
    let bare = rpc::refusal(&json!({}));
    assert_eq!(bare.code, "desktop_refused");
    assert_eq!(
        bare.message.as_deref(),
        Some("The desktop refused the request.")
    );

    // Relay frame envelope: version, peer id length, peer, kind, session.
    let session = [7u8; 16];
    let frame = rpc::envelope("AAAAAAAAAAAAAAAAAAAAAA", &session, 32, b"body").expect("frame");
    assert_eq!(&frame[..2], &[1, 22]);
    assert_eq!(&frame[2..24], b"AAAAAAAAAAAAAAAAAAAAAA");
    assert_eq!(frame[24], 32);
    assert_eq!(&frame[25..41], &session);
    assert_eq!(&frame[41..], b"body");
    assert!(rpc::envelope("short", &session, 32, b"").is_err());
    assert!(rpc::envelope("AAAAAAAAAAAAAAAAAAAAAA", &session, 32, &[0; 65_500]).is_err());

    // Hello negotiation: the client asks for its minimum, accepts newer.
    assert_eq!(
        rpc::hello_params(MIN_PROTOCOL),
        json!({"version": {"protocolVersion": 7, "appVersion": "mobile-prototype"}})
    );
    let hello = |v: Value| json!({"version": {"protocolVersion": v}});
    assert_eq!(rpc::read_version(&hello(json!(22))).expect("version"), 22);
    let old = rpc::read_version(&hello(json!(6))).expect_err("too old");
    assert_eq!(
        (old.code.as_str(), old.protocol_version),
        ("desktop_update_required", Some(6))
    );
    assert_eq!(
        rpc::read_version(&hello(json!("x")))
            .expect_err("unreadable")
            .code,
        "unreadable_version"
    );
    assert_eq!(
        rpc::check_version(&hello(json!(21)), 22)
            .expect_err("changed")
            .code,
        "protocol_changed"
    );
}
