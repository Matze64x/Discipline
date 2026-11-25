//! What the desktop app keeps for syncing, in `sync.json` in its data folder: its identity (device
//! id, name, the key phones pin, fixed ICE credentials and port, so a phone's stored pairing stays
//! valid across restarts), the paired phones (their tokens only as SHA-256 hashes) and the paired
//! PCs (their certificates' fingerprints).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::files::write_private;

pub const DEFAULT_PORT: u16 = 47680;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Phone {
    pub id: String,
    pub name: String,
    /// SHA-256 of the phone's token, hex
    pub token_hash: String,
    /// Unix seconds
    pub paired_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairedPc {
    pub id: String,
    pub name: String,
    /// SHA-256 of its certificate (DER), hex: only that certificate is accepted from it
    pub fingerprint: String,
    /// Unix seconds
    pub paired_at: u64,
    /// "ip:port" it was reached at last (besides finding it on the network)
    #[serde(default)]
    pub last_address: Option<String>,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub device_id: String,
    pub name: String,
    /// DTLS certificate and its private key, DER as hex
    pub certificate: String,
    pub private_key: String,
    pub ice_ufrag: String,
    pub ice_pass: String,
    /// UDP port for phones
    pub port: u16,
    /// TCP port for other PCs
    #[serde(default = "default_port")]
    pub tcp_port: u16,
    #[serde(default)]
    pub phones: Vec<Phone>,
    #[serde(default)]
    pub pcs: Vec<PairedPc>,
}

pub fn random_text(len: usize) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut bytes = vec![0u8; len];
    getrandom::fill(&mut bytes).expect("the system's random number generator");
    // (256 % 62 leaves a tiny bias; irrelevant for these lengths)
    bytes.iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect()
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the system's random number generator");
    hex(&buf)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok()).collect()
}

pub fn sha256_hex(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

/// A certificate's fingerprint: SHA-256 of its DER, hex (as phones and other PCs pin it)
pub fn fingerprint(der: &[u8]) -> String {
    hex(&Sha256::digest(der))
}

/// Compares without stopping at the first difference (no timing hint about how much matched).
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn default_name() -> String {
    let name = gethostname::gethostname().to_string_lossy().trim().to_string();
    if name.is_empty() { "PC".into() } else { name }
}

impl SyncState {
    fn create(certificate: &[u8], private_key: &[u8]) -> Self {
        SyncState {
            device_id: random_hex(8),
            name: default_name(),
            certificate: hex(certificate),
            private_key: hex(private_key),
            ice_ufrag: random_text(8),
            ice_pass: random_text(24),
            port: DEFAULT_PORT,
            tcp_port: DEFAULT_PORT,
            phones: Vec::new(),
            pcs: Vec::new(),
        }
    }

    /// Loads the state, or creates (and saves) a new identity. `generate` makes a certificate and key (DER).
    pub fn load_or_create(path: &Path, generate: impl FnOnce() -> (Vec<u8>, Vec<u8>)) -> std::io::Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(text) => {
                let state: SyncState = serde_json::from_str(&text).map_err(|e| std::io::Error::other(format!("{} is damaged: {e}", path.display())))?;
                if state.certificate_der().is_none() || state.private_key_der().is_none() {
                    return Err(std::io::Error::other(format!("{} has a damaged key", path.display())));
                }
                Ok(state)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let (certificate, key) = generate();
                let state = SyncState::create(&certificate, &key);
                state.save(path)?;
                Ok(state)
            }
            Err(e) => Err(e),
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        // it holds the key: only for this user
        write_private(path, &text)
    }

    pub fn certificate_der(&self) -> Option<Vec<u8>> {
        unhex(&self.certificate)
    }

    pub fn private_key_der(&self) -> Option<Vec<u8>> {
        unhex(&self.private_key)
    }

    pub fn phone(&self, id: &str) -> Option<&Phone> {
        self.phones.iter().find(|p| p.id == id)
    }

    /// Adds or replaces a paired phone.
    pub fn pair_phone(&mut self, phone: Phone) {
        self.phones.retain(|p| p.id != phone.id);
        self.phones.push(phone);
    }

    pub fn forget_phone(&mut self, id: &str) -> bool {
        let before = self.phones.len();
        self.phones.retain(|p| p.id != id);
        self.phones.len() != before
    }

    pub fn pc(&self, id: &str) -> Option<&PairedPc> {
        self.pcs.iter().find(|p| p.id == id)
    }

    /// Adds or replaces a paired PC.
    pub fn pair_pc(&mut self, pc: PairedPc) {
        self.pcs.retain(|p| p.id != pc.id);
        self.pcs.push(pc);
    }

    pub fn forget_pc(&mut self, id: &str) -> bool {
        let before = self.pcs.len();
        self.pcs.retain(|p| p.id != id);
        self.pcs.len() != before
    }
}

pub fn state_path(data_dir: &Path) -> PathBuf {
    data_dir.join("sync.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_once_then_loads_the_same_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        let first = SyncState::load_or_create(&path, || (vec![1, 2, 3], vec![4, 5])).unwrap();
        let second = SyncState::load_or_create(&path, || panic!("must not generate again")).unwrap();
        assert_eq!(first.device_id, second.device_id);
        assert_eq!(second.certificate_der(), Some(vec![1, 2, 3]));
        assert_eq!(first.device_id.len(), 16);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn a_damaged_file_is_an_error_not_a_new_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        std::fs::write(&path, "{ not json").unwrap();
        assert!(SyncState::load_or_create(&path, || panic!("must not replace a damaged file")).is_err());
    }

    #[test]
    fn helpers() {
        assert_eq!(unhex(&hex(&[0, 15, 255])), Some(vec![0, 15, 255]));
        assert_eq!(unhex("abc"), None);
        assert_eq!(unhex("zz"), None);
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
        assert_eq!(sha256_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn pairing_replaces_the_same_phone() {
        let mut state = SyncState::create(&[1], &[2]);
        let phone = |name: &str| Phone { id: "p1".into(), name: name.into(), token_hash: "h".into(), paired_at: 0 };
        state.pair_phone(phone("old"));
        state.pair_phone(phone("new"));
        assert_eq!(state.phones.len(), 1);
        assert_eq!(state.phone("p1").unwrap().name, "new");
        assert!(state.forget_phone("p1"));
        assert!(!state.forget_phone("p1"));
    }
}
