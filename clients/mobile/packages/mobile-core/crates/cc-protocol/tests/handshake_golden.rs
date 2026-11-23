//! Golden: Computer Connect wire contract (Rust), secure session.
//!
//! Replays desktop handshakes recorded with the desktop's own initiator and
//! responder (`apps/desktop-app/src/main/remote-control/crypto`): the phone
//! sends the same hello1 and hello3 (commitment, transcript signature),
//! derives the same pairing code and traffic keys, opens the frames the
//! desktop sealed and seals frames byte for byte as the desktop expects
//! (AES-GCM counters as nonces). A responder signature verifies only over its
//! own transcript, also against another signed by the same desktop key.
//! Broken peers fail with the pinned codes.
//! Fixture: `tests/fixtures/handshake_transcripts.json`.
use cc_protocol::secure::{self, Handshake, HandshakeSecrets};
use serde_json::{Value, json};

fn transcripts() -> Vec<Value> {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/handshake_transcripts.json"))
        .expect("fixture parses");
    fixture["transcripts"]
        .as_array()
        .expect("transcripts")
        .clone()
}

fn hex<const N: usize>(v: &Value) -> [u8; N] {
    let s = v.as_str().expect("hex");
    let bytes: Vec<u8> = (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect();
    bytes.try_into().expect("length")
}
fn bytes(v: &Value) -> Vec<u8> {
    let s = v.as_str().expect("hex");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

fn initiator(t: &Value) -> Handshake {
    Handshake::with_secrets(
        secure::decode::<32>(t["mobileSeed"].as_str().expect("seed")).expect("seed"),
        t["desktopDeviceId"].as_str().expect("id"),
        t["desktopPublicKey"].as_str().expect("key"),
        t["purpose"].as_str().expect("purpose"),
        HandshakeSecrets {
            ephemeral: hex(&t["ephemeralSecret"]),
            nonce: hex(&t["nonce"]),
            session: hex(&t["sessionId"]),
        },
    )
    .expect("handshake")
}

#[test]
fn desktop_handshakes_replay_with_the_same_keys_and_pairing_code() {
    let transcripts = transcripts();
    assert_eq!(transcripts.len(), 2);
    for t in &transcripts {
        let purpose = t["purpose"].as_str().expect("purpose");
        assert_eq!(
            secure::device_id(t["desktopPublicKey"].as_str().unwrap()).unwrap(),
            t["desktopDeviceId"],
            "{purpose}: device id is the key hash"
        );
        let mut handshake = initiator(t);
        assert_eq!(handshake.session, hex::<16>(&t["sessionId"]));
        assert_eq!(handshake.start().expect("hello1"), t["hello1"], "{purpose}");
        assert_eq!(
            handshake.hello2(t["hello2"].clone()).expect("hello3"),
            t["hello3"],
            "{purpose}"
        );
        let (mut channel, code) = handshake.hello4(t["hello4"].clone()).expect("hello4");
        assert_eq!(code, t["pairingCode"], "{purpose}");
        let aad = bytes(&t["aad"]);
        for frame in t["toPhone"].as_array().expect("frames") {
            assert_eq!(
                channel.open(&bytes(&frame["sealed"]), &aad).expect("opens"),
                bytes(&frame["plain"]),
                "{purpose}"
            );
        }
        for frame in t["toDesktop"].as_array().expect("frames") {
            assert_eq!(
                channel.seal(&bytes(&frame["plain"]), &aad).expect("seals"),
                bytes(&frame["sealed"]),
                "{purpose}"
            );
        }
    }
}

#[test]
fn a_responder_signature_binds_its_own_transcript() {
    // Two handshakes the same desktop identity signed for the same phone, so
    // the responder key cannot tell their signatures apart; only the
    // transcript can.
    let fixture: Value = serde_json::from_str(include_str!("fixtures/handshake_transcripts.json"))
        .expect("fixture parses");
    let pair = fixture["sameResponder"].as_array().expect("sameResponder");
    assert_eq!(pair.len(), 2);
    for key in ["desktopPublicKey", "desktopDeviceId", "mobileSeed"] {
        assert_eq!(pair[0][key], pair[1][key], "{key} shared");
    }
    assert_eq!(
        pair[0]["hello2"]["responderKey"],
        pair[1]["desktopPublicKey"]
    );
    assert_ne!(pair[0]["sessionId"], pair[1]["sessionId"]);
    let signature = |t: &Value| json!({"signature": t["hello4"]["signature"]});
    for (own, other) in [(&pair[0], &pair[1]), (&pair[1], &pair[0])] {
        let after_hello2 = || {
            let mut h = initiator(own);
            assert_eq!(h.start().expect("hello1"), own["hello1"]);
            assert_eq!(
                h.hello2(own["hello2"].clone()).expect("hello3"),
                own["hello3"]
            );
            h
        };
        let (_, code) = after_hello2()
            .hello4(signature(own))
            .expect("its own signature verifies");
        assert_eq!(code, own["pairingCode"]);
        assert_eq!(
            after_hello2()
                .hello4(signature(other))
                .err()
                .map(|e| e.code),
            Some("peer_signature".into()),
            "the same key's signature over the other transcript"
        );
    }
}

#[test]
fn broken_peers_and_frames_fail_closed() {
    let transcripts = transcripts();
    let t = &transcripts[1];
    let code = |r: Result<Value, cc_protocol::RpcFailure>| r.expect_err("fails").code;

    // A responder key other than the addressed computer's.
    let mut h = initiator(t);
    h.start().unwrap();
    let mut other = t["hello2"].clone();
    other["responderKey"] = t["mobilePublicKey"].clone();
    assert_eq!(code(h.hello2(other)), "peer_identity");

    // Messages out of order.
    let mut h = initiator(t);
    assert_eq!(code(h.hello2(t["hello2"].clone())), "peer_identity");
    let mut h = initiator(t);
    assert_eq!(
        h.hello4(t["hello4"].clone()).err().map(|e| e.code),
        Some("handshake_order".into())
    );

    // Another desktop's signature (`a_responder_signature_binds_its_own_transcript`
    // covers the same desktop's signature over another transcript).
    let mut h = initiator(t);
    h.start().unwrap();
    h.hello2(t["hello2"].clone()).unwrap();
    let forged = json!({"signature": transcripts[0]["hello4"]["signature"]});
    assert_eq!(
        h.hello4(forged).err().map(|e| e.code),
        Some("peer_signature".into())
    );

    // A peer id that is not the key's hash.
    assert!(
        Handshake::with_secrets(
            [1; 32],
            t["mobilePublicKey"].as_str().unwrap(),
            t["desktopPublicKey"].as_str().unwrap(),
            "control",
            HandshakeSecrets {
                ephemeral: [2; 32],
                nonce: [3; 32],
                session: [4; 16],
            },
        )
        .is_err()
    );

    // A replayed or tampered frame ends the channel.
    let mut h = initiator(t);
    h.start().unwrap();
    h.hello2(t["hello2"].clone()).unwrap();
    let (mut channel, _) = h.hello4(t["hello4"].clone()).unwrap();
    let aad = bytes(&t["aad"]);
    let first = bytes(&t["toPhone"][0]["sealed"]);
    channel.open(&first, &aad).expect("first frame");
    assert_eq!(
        channel.open(&first, &aad).err().map(|e| e.code),
        Some("channel_sequence".into())
    );
    let mut h = initiator(t);
    h.start().unwrap();
    h.hello2(t["hello2"].clone()).unwrap();
    let (mut channel, _) = h.hello4(t["hello4"].clone()).unwrap();
    let mut tampered = first.clone();
    *tampered.last_mut().unwrap() ^= 1;
    assert_eq!(
        channel.open(&tampered, &aad).err().map(|e| e.code),
        Some("decrypt_failed".into())
    );
    assert!(
        channel.open(&first, &aad).is_err(),
        "the channel stays failed"
    );
    assert!(channel.seal(b"x", &aad).is_err(), "and seals nothing");
}
