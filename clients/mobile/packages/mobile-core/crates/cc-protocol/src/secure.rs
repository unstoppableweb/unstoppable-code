use crate::{Result, RpcFailure as Error, field};
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
/// Unpadded base64url.
pub fn encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}
pub fn decode<const N: usize>(raw: &str) -> Result<[u8; N]> {
    B64.decode(raw)
        .map_err(|_| Error::new("invalid_key"))?
        .try_into()
        .map_err(|_| Error::new("invalid_key"))
}
pub fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}
pub fn device_id(key: &str) -> Result<String> {
    Ok(encode(&Sha256::digest(decode::<32>(key)?)[..16]))
}
const PROTOCOL: &str = "canopy-remote-control/1";
/// The random inputs of one initiator handshake.
pub struct HandshakeSecrets {
    /// X25519 ephemeral secret.
    pub ephemeral: [u8; 32],
    pub nonce: [u8; 32],
    pub session: [u8; 16],
}
/// The initiator side of the desktop handshake
/// (`apps/desktop-app/src/main/remote-control/crypto/handshake.ts`).
pub struct Handshake {
    identity: SigningKey,
    peer: [u8; 32],
    secret: StaticSecret,
    public: [u8; 32],
    nonce: [u8; 32],
    commitment: [u8; 32],
    pub session: [u8; 16],
    purpose: String,
    transcript: Option<[u8; 32]>,
    remote: Option<[u8; 32]>,
    stage: u8,
}
impl Handshake {
    /// Starts an initiator handshake for `purpose` (`pair` or `control`)
    /// with fresh random ephemeral key, nonce and session id.
    pub fn new(seed: [u8; 32], peer_id: &str, key: &str, purpose: &str) -> Result<Self> {
        Self::with_secrets(
            seed,
            peer_id,
            key,
            purpose,
            HandshakeSecrets {
                ephemeral: random(),
                nonce: random(),
                session: random(),
            },
        )
    }
    /// [`Handshake::new`] with the random inputs given, so a recorded
    /// transcript can be replayed.
    pub fn with_secrets(
        seed: [u8; 32],
        peer_id: &str,
        key: &str,
        purpose: &str,
        secrets: HandshakeSecrets,
    ) -> Result<Self> {
        if device_id(key)? != peer_id || !matches!(purpose, "pair" | "control") {
            return Err(Error::new("peer_identity"));
        }
        let secret = StaticSecret::from(secrets.ephemeral);
        let public = PublicKey::from(&secret).to_bytes();
        let nonce = secrets.nonce;
        let commitment = Sha256::digest([b"commit".as_slice(), &public, &nonce].concat()).into();
        Ok(Self {
            identity: SigningKey::from_bytes(&seed),
            peer: decode(key)?,
            secret,
            public,
            nonce,
            commitment,
            session: secrets.session,
            purpose: purpose.into(),
            transcript: None,
            remote: None,
            stage: 0,
        })
    }
    pub fn start(&mut self) -> Result<Value> {
        if self.stage != 0 {
            return Err(Error::new("handshake_order"));
        }
        self.stage = 1;
        Ok(
            json!({"protocol":PROTOCOL,"purpose":self.purpose,"initiatorKey":encode(&self.identity.verifying_key().to_bytes()),"commitment":encode(&self.commitment)}),
        )
    }
    pub fn hello2(&mut self, v: Value) -> Result<Value> {
        if self.stage != 1 || field(&v, "responderKey")? != encode(&self.peer) {
            return Err(Error::new("peer_identity"));
        }
        self.stage = 2;
        let remote = decode::<32>(field(&v, "ephemeral")?)?;
        let nonce = decode::<32>(field(&v, "nonce")?)?;
        let mut transcript = Vec::new();
        for part in [
            PROTOCOL.as_bytes(),
            self.purpose.as_bytes(),
            &self.session,
            &self.identity.verifying_key().to_bytes(),
            &self.peer,
            &self.commitment,
            &self.public,
            &self.nonce,
            &remote,
            &nonce,
        ] {
            transcript.extend((part.len() as u32).to_be_bytes());
            transcript.extend(part);
        }
        let hash: [u8; 32] = Sha256::digest(transcript).into();
        let signature = self
            .identity
            .sign(&[b"initiator".as_slice(), &hash].concat());
        self.transcript = Some(hash);
        self.remote = Some(remote);
        Ok(
            json!({"ephemeral":encode(&self.public),"nonce":encode(&self.nonce),"signature":encode(&signature.to_bytes())}),
        )
    }
    pub fn hello4(&mut self, v: Value) -> Result<(Channel, String)> {
        if self.stage != 2 {
            return Err(Error::new("handshake_order"));
        }
        self.stage = 3;
        let hash = self
            .transcript
            .ok_or_else(|| Error::new("handshake_order"))?;
        VerifyingKey::from_bytes(&self.peer)
            .map_err(|_| Error::new("peer_identity"))?
            .verify_strict(
                &[b"responder".as_slice(), &hash].concat(),
                &Signature::from_bytes(&decode::<64>(field(&v, "signature")?)?),
            )
            .map_err(|_| Error::new("peer_signature"))?;
        let shared = self.secret.diffie_hellman(&PublicKey::from(
            self.remote.ok_or_else(|| Error::new("handshake_order"))?,
        ));
        if !shared.was_contributory() {
            return Err(Error::new("peer_identity"));
        }
        let hk = Hkdf::<Sha256>::new(Some(&hash), shared.as_bytes());
        let mut traffic = [0; 64];
        hk.expand(format!("{PROTOCOL} traffic").as_bytes(), &mut traffic)
            .map_err(|_| Error::new("derive_key"))?;
        let mut sas = [0; 4];
        hk.expand(format!("{PROTOCOL} sas").as_bytes(), &mut sas)
            .map_err(|_| Error::new("derive_key"))?;
        let channel = Channel {
            send: Aes256Gcm::new_from_slice(&traffic[..32])
                .map_err(|_| Error::new("derive_key"))?,
            receive: Aes256Gcm::new_from_slice(&traffic[32..])
                .map_err(|_| Error::new("derive_key"))?,
            tx: 0,
            rx: 0,
            failed: false,
        };
        zeroize::Zeroize::zeroize(&mut traffic);
        Ok((
            channel,
            format!("{:06}", u32::from_be_bytes(sas) % 1_000_000),
        ))
    }
}
pub struct Channel {
    send: Aes256Gcm,
    receive: Aes256Gcm,
    tx: u64,
    rx: u64,
    failed: bool,
}
impl Channel {
    fn nonce(n: u64) -> [u8; 12] {
        let mut nonce = [0; 12];
        nonce[4..].copy_from_slice(&n.to_be_bytes());
        nonce
    }
    pub fn seal(&mut self, bytes: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        if self.failed || self.tx >= i64::MAX as u64 {
            return Err(Error::new("channel_closed"));
        }
        let n = self.tx;
        self.tx += 1;
        match self.send.encrypt(
            Nonce::from_slice(&Self::nonce(n)),
            Payload { msg: bytes, aad },
        ) {
            Ok(sealed) => Ok([n.to_be_bytes().as_slice(), &sealed].concat()),
            Err(_) => {
                self.failed = true;
                Err(Error::new("encrypt_failed"))
            }
        }
    }
    pub fn open(&mut self, bytes: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        if self.failed || bytes.len() < 24 || bytes[..8] != self.rx.to_be_bytes() {
            self.failed = true;
            return Err(Error::new("channel_sequence"));
        }
        match self.receive.decrypt(
            Nonce::from_slice(&Self::nonce(self.rx)),
            Payload {
                msg: &bytes[8..],
                aad,
            },
        ) {
            Ok(clear) => {
                self.rx += 1;
                Ok(clear)
            }
            Err(_) => {
                self.failed = true;
                Err(Error::new("decrypt_failed"))
            }
        }
    }
}
