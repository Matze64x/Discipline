//! Syncing between PCs on the local network: TCP with TLS 1.3, both sides showing the same
//! certificate as for phones and pinning each other's (stored at pairing). PCs find each other with
//! mDNS (`_discipline._tcp`); each keeps a connection to every paired PC it can reach.
//!
//! **Pairing** (a PC found on the network, confirmed on both screens): the TLS connection is made
//! without pinning, then a 6-digit code is derived from both certificates and two random numbers,
//! and both users check that their screens show the same code. The accepting PC commits to its
//! number (sends its hash) before it learns the dialer's, and reveals it only after the dialer sent
//! its own; both show the code from then on. So neither side can steer the code, and a machine in
//! the middle can't try codes against the accepting PC unseen: every attempt shows its code there
//! (against the dialing PC, each attempt takes a click). A PC accepts pairing only while its
//! Settings dialog is open, and at most one attempt every few seconds. The code also covers both
//! device ids, and a PC already paired under that id with another key is refused.
//!
//! **Connections:** both sides dial paired PCs they aren't connected to (the one with the higher id
//! a little later); if two connections to one PC come about anyway, both keep the one dialed by
//! the lower id. Messages are framed by a 4-byte length; an empty frame is a keepalive, and a
//! connection that stays silent too long counts as lost. After the first message (which says who
//! dials and why), sync messages pass between the window and the other PC; the sync itself
//! happens in the window, as with phones.

use std::collections::{HashMap, HashSet};
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{DigitallySignedStruct, DistinguishedName, SignatureScheme};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::runtime::Handle;
use tokio::sync::{mpsc, watch, Notify};
use tokio::time::{sleep, timeout};
use tokio_rustls::{TlsAcceptor, TlsConnector};

use super::endpoint::{is_local, next_conn};
use super::state::{constant_time_eq, fingerprint, random_hex, sha256_hex, PairedPc, SyncState};

const SERVICE_TYPE: &str = "_discipline._tcp.local.";
/// Ports tried after the configured one is taken
const PORT_TRIES: u16 = 10;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// For the TLS handshake and the first messages
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The first messages (who dials, pairing) are small
const FIRST_MESSAGE_LIMIT: usize = 4 * 1024;
/// Later messages carry the whole data (about 5 MB at 20 000 transactions)
const MESSAGE_LIMIT: usize = 256 * 1024 * 1024;
/// An empty frame goes out after this long without sending anything
const KEEPALIVE: Duration = Duration::from_secs(15);
/// Nothing received for this long: the other PC is gone (asleep, off the network)
const SILENCE_LIMIT: Duration = Duration::from_secs(45);
/// How often paired PCs that aren't connected are dialed
const DIAL_INTERVAL: Duration = Duration::from_secs(15);
/// The PC with the higher id waits this long before dialing (the other one usually dials first)
const HIGHER_ID_DELAY: Duration = Duration::from_secs(3);
/// Incoming connections that haven't said who they are yet
const MAX_PENDING: usize = 8;
/// … of those from one address (so one device can't take them all)
const MAX_PENDING_PER_ADDRESS: usize = 2;
/// How long the users have to compare the code
const PAIRING_TIME: Duration = Duration::from_secs(120);
/// The least time between two incoming pairing attempts
const PAIRING_INTERVAL: Duration = Duration::from_secs(2);
/// Writing one message may take this long (a slow network); then the connection counts as lost
const WRITE_TIMEOUT: Duration = Duration::from_secs(120);
/// A connection that ends sooner than this counts as failed: the next dial waits longer each time
const SHORT_CONNECTION: Duration = Duration::from_secs(30);
const MAX_BACKOFF: Duration = Duration::from_secs(300);
/// PCs kept from the network (more are ignored, unless paired)
const MAX_FOUND: usize = 32;

/// A PC running Discipline, found on the network
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundPc {
    pub id: String,
    pub name: String,
    #[serde(skip)]
    pub addresses: Vec<SocketAddr>,
    #[serde(skip)]
    fullname: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PairingEvent {
    /// Both screens show this code now; the users compare and confirm it
    #[serde(rename_all = "camelCase")]
    Code { code: String, peer_id: String, peer_name: String, incoming: bool },
    #[serde(rename_all = "camelCase")]
    Done { peer_id: String, peer_name: String },
    /// Ended without pairing; the reason is empty if this side cancelled
    Failed { reason: String },
}

#[derive(Clone, Debug, PartialEq)]
pub enum PcEvent {
    /// A paired PC is connected; messages can flow
    Connected { conn: u64, peer_id: String, peer_name: String },
    Message { conn: u64, text: String },
    Closed { conn: u64 },
    /// The PCs on the network changed
    Found(Vec<FoundPc>),
    Pairing(PairingEvent),
    /// A paired PC refused this one (e.g. it was removed there)
    Refused { peer_id: String, reason: String },
}

pub type Events = Arc<dyn Fn(PcEvent) + Send + Sync>;
pub type SaveState = Arc<dyn Fn(&SyncState) -> io::Result<()> + Send + Sync>;

pub struct PcNetConfig {
    /// This PC's certificate and key (DER), the same as for phones
    pub certificate: Vec<u8>,
    pub private_key: Vec<u8>,
    pub state: Arc<Mutex<SyncState>>,
    pub save: SaveState,
    /// Announce and find PCs with mDNS (off in tests)
    pub discovery: bool,
}

// ------------------------------------------------------------------------------------- TLS

/// Accepts any certificate, but checks that the other side holds its key (the handshake
/// signature). Which certificate is acceptable is decided after the handshake (pinning).
#[derive(Debug)]
struct AnyCertificate(Arc<CryptoProvider>);

impl AnyCertificate {
    fn tls13(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
}

impl ServerCertVerifier for AnyCertificate {
    fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.2 isn't used".into()))
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.tls13(message, cert, dss)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

impl ClientCertVerifier for AnyCertificate {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }
    fn verify_client_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: UnixTime) -> Result<ClientCertVerified, rustls::Error> {
        Ok(ClientCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.2 isn't used".into()))
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.tls13(message, cert, dss)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
    // (client certificates are required: `client_auth_mandatory` defaults to `offer_client_auth`, true)
}

fn tls_configs(certificate: &[u8], private_key: &[u8]) -> io::Result<(TlsConnector, TlsAcceptor)> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let verifier = Arc::new(AnyCertificate(Arc::clone(&provider)));
    let cert = CertificateDer::from(certificate.to_vec());
    let key = || PrivateKeyDer::try_from(private_key.to_vec()).map_err(io::Error::other);
    let client = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(io::Error::other)?
        .dangerous()
        .with_custom_certificate_verifier(verifier.clone())
        .with_client_auth_cert(vec![cert.clone()], key()?)
        .map_err(io::Error::other)?;
    let server = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(io::Error::other)?
        .with_client_cert_verifier(verifier)
        .with_single_cert(vec![cert], key()?)
        .map_err(io::Error::other)?;
    Ok((TlsConnector::from(Arc::new(client)), TlsAcceptor::from(Arc::new(server))))
}

fn peer_fingerprint(certificates: Option<&[CertificateDer<'_>]>) -> Option<String> {
    certificates.and_then(|c| c.first()).map(|c| fingerprint(c.as_ref()))
}

// ------------------------------------------------------------------------------------- framing

/// Reads one frame: the message, or None for a keepalive.
async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R, limit: usize) -> io::Result<Option<String>> {
    let len = reader.read_u32().await? as usize;
    if len > limit {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "message too large"));
    }
    if len == 0 {
        return Ok(None);
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await?;
    String::from_utf8(buf).map(Some).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "not UTF-8"))
}

/// Reads one frame, giving up if nothing arrives for `silence` (a long message may take longer
/// in all, as long as it keeps coming).
async fn read_frame_patiently<R: AsyncRead + Unpin>(reader: &mut R, limit: usize, silence: Duration) -> io::Result<Option<String>> {
    let quiet = || io::Error::new(io::ErrorKind::TimedOut, "silent");
    let len = timeout(silence, reader.read_u32()).await.map_err(|_| quiet())?? as usize;
    if len > limit {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "message too large"));
    }
    if len == 0 {
        return Ok(None);
    }
    let mut buf = vec![0u8; len];
    let mut filled = 0;
    while filled < len {
        let end = (filled + 64 * 1024).min(len);
        let n = timeout(silence, reader.read(&mut buf[filled..end])).await.map_err(|_| quiet())??;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        filled += n;
    }
    String::from_utf8(buf).map(Some).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "not UTF-8"))
}

async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, text: &str) -> io::Result<()> {
    let len = u32::try_from(text.len()).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "message too large"))?;
    writer.write_u32(len).await?;
    writer.write_all(text.as_bytes()).await?;
    writer.flush().await
}

/// A small JSON message (skipping keepalives), within the handshake time.
async fn read_json<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Value> {
    timeout(HANDSHAKE_TIMEOUT, async {
        loop {
            if let Some(text) = read_frame(reader, FIRST_MESSAGE_LIMIT).await? {
                return serde_json::from_str(&text).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e));
            }
        }
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "no answer"))?
}

async fn write_json<W: AsyncWrite + Unpin>(writer: &mut W, value: Value) -> io::Result<()> {
    write_frame(writer, &value.to_string()).await
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn is_device_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn is_nonce(nonce: &str) -> bool {
    nonce.len() == 64 && nonce.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn clean_name(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).take(64).collect();
    if name.trim().is_empty() { "PC".into() } else { name.trim().to_string() }
}

fn now_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// The code both screens show while pairing: 6 digits from both certificates and both numbers
pub fn pairing_code(dialer: (&str, &str), server: (&str, &str), dialer_nonce: &str, server_nonce: &str) -> String {
    let ((dialer_id, dialer_fingerprint), (server_id, server_fingerprint)) = (dialer, server);
    let hash = sha256_hex(&format!("discipline-pair-v2|{dialer_id}|{dialer_fingerprint}|{server_id}|{server_fingerprint}|{dialer_nonce}|{server_nonce}"));
    let n = u32::from_str_radix(&hash[..8], 16).expect("hex") % 1_000_000;
    format!("{:03} {:03}", n / 1000, n % 1000)
}

// ------------------------------------------------------------------------------------- state

enum Out {
    Text(String),
    Close,
}

struct Conn {
    peer_id: String,
    /// Dialed by the PC with the lower id (the one both sides keep)
    preferred: bool,
    tx: mpsc::UnboundedSender<Out>,
}

enum PairCommand {
    /// The user saw this code on both screens
    Confirm(String),
    Cancel,
}

struct ActivePairing {
    attempt: u64,
    commands: mpsc::UnboundedSender<PairCommand>,
}

struct Shared {
    self_id: String,
    fingerprint: String,
    state: Arc<Mutex<SyncState>>,
    save: SaveState,
    events: Events,
    connector: TlsConnector,
    acceptor: TlsAcceptor,
    conns: Mutex<HashMap<u64, Conn>>,
    found: Mutex<HashMap<String, FoundPc>>,
    dialing: Mutex<HashSet<String>>,
    pairing: Mutex<Option<ActivePairing>>,
    /// Incoming pairing is accepted (the Settings dialog is open)
    pairing_allowed: AtomicBool,
    last_incoming_pairing: Mutex<Option<Instant>>,
    /// Per PC: don't dial before this time, and how many connections in a row ended early
    backoff: Mutex<HashMap<String, (Instant, u32)>>,
    next_attempt: AtomicU64,
    pending: Mutex<HashMap<IpAddr, usize>>,
    /// The port this PC listens on (other PCs remember it with the address)
    port: u16,
    wake_dialer: Notify,
    stop: watch::Receiver<bool>,
}

impl Shared {
    fn emit(&self, event: PcEvent) {
        (self.events)(event);
    }

    /// This instance was stopped (networking turned off, or serving restarted)
    fn stopped(&self) -> bool {
        *self.stop.borrow()
    }

    fn name(&self) -> String {
        self.state.lock().unwrap().name.clone()
    }

    fn connected(&self, peer_id: &str) -> bool {
        self.conns.lock().unwrap().values().any(|c| c.peer_id == peer_id)
    }

    /// Changes the state and saves it; unchanged if saving fails.
    fn update_state(&self, change: impl FnOnce(&mut SyncState)) -> io::Result<()> {
        let mut state = self.state.lock().unwrap();
        let mut next = state.clone();
        change(&mut next);
        (self.save)(&next)?;
        *state = next;
        Ok(())
    }

    /// Notes how long a connection to a PC lasted: after short ones, the next dial waits longer.
    fn connection_ended(&self, peer_id: &str, lasted: Duration) {
        let mut backoff = self.backoff.lock().unwrap();
        if lasted >= SHORT_CONNECTION {
            backoff.remove(peer_id);
            return;
        }
        let failures = backoff.get(peer_id).map_or(0, |(_, n)| *n) + 1;
        let wait = (Duration::from_secs(5) * 2u32.saturating_pow(failures.min(10) - 1)).min(MAX_BACKOFF);
        backoff.insert(peer_id.to_string(), (Instant::now() + wait, failures));
    }

    fn may_dial(&self, peer_id: &str) -> bool {
        self.backoff.lock().unwrap().get(peer_id).is_none_or(|(at, _)| Instant::now() >= *at)
    }

    /// Whether a connection to this PC dialed by the lower id exists (a second one wouldn't be kept)
    fn has_preferred(&self, peer_id: &str) -> bool {
        self.conns.lock().unwrap().values().any(|c| c.peer_id == peer_id && c.preferred)
    }

    fn found_list(&self) -> Vec<FoundPc> {
        let mut list: Vec<FoundPc> = self.found.lock().unwrap().values().cloned().collect();
        list.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
        list
    }
}

/// Counts an incoming connection that hasn't said who it is yet, until dropped
struct Pending(Arc<Shared>, IpAddr);

impl Pending {
    /// None if there are too many already (in all, or from this address)
    fn new(shared: &Arc<Shared>, ip: IpAddr) -> Option<Pending> {
        let mut pending = shared.pending.lock().unwrap();
        let total: usize = pending.values().sum();
        if total >= MAX_PENDING || pending.get(&ip).is_some_and(|n| *n >= MAX_PENDING_PER_ADDRESS) {
            return None;
        }
        *pending.entry(ip).or_insert(0) += 1;
        Some(Pending(Arc::clone(shared), ip))
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        let mut pending = self.0.pending.lock().unwrap();
        if let Some(n) = pending.get_mut(&self.1) {
            *n -= 1;
            if *n == 0 {
                pending.remove(&self.1);
            }
        }
    }
}

/// Marks a PC as being dialed, until dropped
struct Dialing(Arc<Shared>, String);

impl Drop for Dialing {
    fn drop(&mut self) {
        self.0.dialing.lock().unwrap().remove(&self.1);
    }
}

// ------------------------------------------------------------------------------------- service

pub struct PcNet {
    shared: Arc<Shared>,
    stop: watch::Sender<bool>,
    local: SocketAddr,
    mdns: Option<ServiceDaemon>,
    runtime: Handle,
}

impl PcNet {
    /// Listens on `ip` (the configured port, or one of the next ones; the one it got is saved) and
    /// starts announcing, finding and dialing PCs.
    pub fn start(runtime: &Handle, ip: IpAddr, config: PcNetConfig, events: Events) -> io::Result<PcNet> {
        let (connector, acceptor) = tls_configs(&config.certificate, &config.private_key)?;
        let (self_id, port) = {
            let s = config.state.lock().unwrap();
            (s.device_id.clone(), s.tcp_port)
        };
        // (the previous instance may still be letting go of the port: retry it briefly first)
        let preferred = (0..10).find_map(|attempt| {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(100));
            }
            std::net::TcpListener::bind(SocketAddr::new(ip, port)).ok()
        });
        let std_listener = preferred
            .or_else(|| (1..PORT_TRIES).find_map(|i| std::net::TcpListener::bind(SocketAddr::new(ip, port.wrapping_add(i))).ok()))
            .ok_or_else(|| io::Error::other("no free port"))?;
        std_listener.set_nonblocking(true)?;
        let local = std_listener.local_addr()?;
        let (stop_tx, stop_rx) = watch::channel(false);
        let shared = Arc::new(Shared {
            self_id: self_id.clone(),
            fingerprint: fingerprint(&config.certificate),
            state: config.state,
            save: config.save,
            events,
            connector,
            acceptor,
            conns: Mutex::new(HashMap::new()),
            found: Mutex::new(HashMap::new()),
            dialing: Mutex::new(HashSet::new()),
            pairing: Mutex::new(None),
            pairing_allowed: AtomicBool::new(false),
            last_incoming_pairing: Mutex::new(None),
            backoff: Mutex::new(HashMap::new()),
            next_attempt: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            port: local.port(),
            wake_dialer: Notify::new(),
            stop: stop_rx,
        });
        // other PCs know this port from now on (port 0: tests)
        if port != 0 && local.port() != port
            && let Err(e) = shared.update_state(|s| s.tcp_port = local.port())
        {
            log::warn!("can't save the sync port: {e}");
        }
        let listener = {
            let _guard = runtime.enter();
            TcpListener::from_std(std_listener)?
        };
        runtime.spawn(accept_loop(Arc::clone(&shared), listener));
        runtime.spawn(dial_loop(Arc::clone(&shared)));

        let mdns = if config.discovery {
            let started = announce(&shared, local).and_then(|daemon| match daemon.browse(SERVICE_TYPE) {
                Ok(receiver) => Ok((daemon, receiver)),
                Err(e) => {
                    let _ = daemon.shutdown();
                    Err(e)
                }
            });
            match started {
                Ok((daemon, receiver)) => {
                    runtime.spawn(discover(Arc::clone(&shared), receiver));
                    Some(daemon)
                }
                Err(e) => {
                    log::warn!("can't look for other PCs: {e}");
                    None
                }
            }
        } else {
            None
        };
        Ok(PcNet { shared, stop: stop_tx, local, mdns, runtime: runtime.clone() })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    pub fn found(&self) -> Vec<FoundPc> {
        self.shared.found_list()
    }

    /// Makes a PC known without mDNS (tests; the address must be its listening one)
    pub fn add_found(&self, id: &str, name: &str, address: SocketAddr) {
        let pc = FoundPc { id: id.into(), name: name.into(), addresses: vec![address], fullname: String::new() };
        self.shared.found.lock().unwrap().insert(id.into(), pc);
        self.shared.wake_dialer.notify_one();
    }

    pub fn send(&self, conn: u64, text: String) {
        if let Some(c) = self.shared.conns.lock().unwrap().get(&conn) {
            let _ = c.tx.send(Out::Text(text));
        }
    }

    pub fn close(&self, conn: u64) {
        if let Some(c) = self.shared.conns.lock().unwrap().get(&conn) {
            let _ = c.tx.send(Out::Close);
        }
    }

    /// Starts pairing with a PC found on the network. The progress comes as `Pairing` events.
    pub fn pair(&self, peer_id: &str) -> Result<(), String> {
        let peer = self.shared.found.lock().unwrap().get(peer_id).cloned().ok_or("That PC isn't on the network any more.")?;
        let (attempt, commands) = claim_pairing(&self.shared).ok_or("Already pairing.")?;
        self.runtime.spawn(pair_outgoing(Arc::clone(&self.shared), peer, attempt, commands));
        Ok(())
    }

    /// The user saw `code` on both screens (ignored unless it's the code of the pairing under way)
    pub fn confirm_pairing(&self, code: &str) {
        if let Some(p) = self.shared.pairing.lock().unwrap().as_ref() {
            let _ = p.commands.send(PairCommand::Confirm(code.to_string()));
        }
    }

    /// Whether other PCs may start pairing with this one (while the user has the Settings dialog open)
    pub fn set_pairing_allowed(&self, allowed: bool) {
        self.shared.pairing_allowed.store(allowed, Ordering::SeqCst);
    }

    pub fn cancel_pairing(&self) {
        if let Some(p) = self.shared.pairing.lock().unwrap().as_ref() {
            let _ = p.commands.send(PairCommand::Cancel);
        }
    }

    /// Unpairs a PC: removes it from the state and closes its connections.
    pub fn forget(&self, peer_id: &str) -> io::Result<()> {
        self.shared.update_state(|s| {
            s.forget_pc(peer_id);
        })?;
        for c in self.shared.conns.lock().unwrap().values().filter(|c| c.peer_id == peer_id) {
            let _ = c.tx.send(Out::Close);
        }
        Ok(())
    }

    /// Announces the new name (the state has it already)
    pub fn renamed(&self) {
        if let Some(daemon) = &self.mdns
            && let Ok(info) = service_info(&self.shared, self.local)
        {
            let _ = daemon.register(info);
        }
    }

    pub fn stop(&self) {
        let _ = self.stop.send(true);
        if let Some(daemon) = &self.mdns {
            // (its command queue may be full for a moment: it must stop announcing)
            for _ in 0..20 {
                if !matches!(daemon.shutdown(), Err(mdns_sd::Error::Again)) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

impl Drop for PcNet {
    fn drop(&mut self) {
        self.stop();
    }
}

fn service_info(shared: &Shared, local: SocketAddr) -> mdns_sd::Result<ServiceInfo> {
    let name = shared.name();
    let properties = [("id", shared.self_id.as_str()), ("name", name.as_str()), ("v", "1")];
    ServiceInfo::new(SERVICE_TYPE, &shared.self_id, &format!("discipline-{}.local.", shared.self_id), local.ip(), local.port(), &properties[..])
}

fn announce(shared: &Shared, local: SocketAddr) -> mdns_sd::Result<ServiceDaemon> {
    let daemon = ServiceDaemon::new()?;
    daemon.register(service_info(shared, local)?)?;
    Ok(daemon)
}

async fn discover(shared: Arc<Shared>, receiver: mdns_sd::Receiver<ServiceEvent>) {
    let mut stop = shared.stop.clone();
    loop {
        let event = tokio::select! {
            event = receiver.recv_async() => event,
            _ = stop.changed() => return,
        };
        let changed = match event {
            Ok(ServiceEvent::ServiceResolved(service)) => {
                let id = service.get_property_val_str("id").unwrap_or_default().to_string();
                if !is_device_id(&id) || id == shared.self_id {
                    continue;
                }
                let addresses: Vec<SocketAddr> = service
                    .addresses
                    .iter()
                    .map(|a| a.to_ip_addr())
                    // (a link-local IPv6 address would need its interface)
                    .filter(|ip| is_local(*ip) && !matches!(ip, IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) == 0xfe80))
                    .map(|ip| SocketAddr::new(ip, service.port))
                    .collect();
                if addresses.is_empty() {
                    continue;
                }
                let pc = FoundPc { id: id.clone(), name: clean_name(service.get_property_val_str("name").unwrap_or_default()), addresses, fullname: service.fullname.clone() };
                let paired = shared.state.lock().unwrap().pc(&id).is_some();
                let mut found = shared.found.lock().unwrap();
                if !paired && !found.contains_key(&id) && found.len() >= MAX_FOUND {
                    continue;
                }
                let changed = found.insert(id, pc.clone()).is_none_or(|old| old != pc);
                drop(found);
                if changed {
                    shared.wake_dialer.notify_one();
                }
                changed
            }
            Ok(ServiceEvent::ServiceRemoved(_, fullname)) => {
                let mut found = shared.found.lock().unwrap();
                let before = found.len();
                found.retain(|_, pc| pc.fullname != fullname);
                found.len() != before
            }
            Ok(_) => false,
            Err(_) => return,
        };
        if changed {
            shared.emit(PcEvent::Found(shared.found_list()));
        }
    }
}

// ------------------------------------------------------------------------------------- incoming

async fn accept_loop(shared: Arc<Shared>, listener: TcpListener) {
    let mut stop = shared.stop.clone();
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            _ = stop.changed() => return,
        };
        match accepted {
            // local network only
            Ok((tcp, source)) if is_local(source.ip()) => {
                let Some(pending) = Pending::new(&shared, source.ip()) else { continue };
                tokio::spawn(incoming(Arc::clone(&shared), tcp, source.ip(), pending));
            }
            Ok(_) => {}
            Err(e) => {
                log::debug!("sync accept: {e}");
                sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

async fn incoming(shared: Arc<Shared>, tcp: TcpStream, source: IpAddr, pending: Pending) {
    let _ = tcp.set_nodelay(true);
    let Ok(Ok(mut tls)) = timeout(HANDSHAKE_TIMEOUT, shared.acceptor.accept(tcp)).await else { return };
    if shared.stopped() {
        return;
    }
    let Some(peer_fp) = peer_fingerprint(tls.get_ref().1.peer_certificates()) else { return };
    let Ok(first) = read_json(&mut tls).await else { return };
    let id = text(&first, "id");
    let name = clean_name(&text(&first, "name"));
    if !is_device_id(&id) || id == shared.self_id {
        let _ = write_json(&mut tls, json!({ "t": "denied", "reason": "invalid" })).await;
        return;
    }
    match text(&first, "t").as_str() {
        "sync" => {
            let known = shared.state.lock().unwrap().pc(&id).map(|pc| (pc.fingerprint.clone(), pc.name.clone()));
            let reason = match &known {
                None => Some("unpaired"),
                Some((fp, _)) if !constant_time_eq(fp, &peer_fp) => Some("key"),
                Some(_) => None,
            };
            if let Some(reason) = reason {
                let _ = write_json(&mut tls, json!({ "t": "denied", "reason": reason })).await;
                return;
            }
            // (both PCs keep the connection dialed by the lower id)
            if id > shared.self_id && shared.has_preferred(&id) {
                let _ = write_json(&mut tls, json!({ "t": "denied", "reason": "duplicate" })).await;
                return;
            }
            // where it can be reached: its address and the port it listens on
            let address = first.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()).filter(|p| *p != 0).map(|p| SocketAddr::new(source, p).to_string());
            let (old_name, old_address) = shared.state.lock().unwrap().pc(&id).map(|p| (p.name.clone(), p.last_address.clone())).unwrap_or_default();
            if old_name != name || (address.is_some() && address != old_address) {
                let _ = shared.update_state(|s| {
                    for p in s.pcs.iter_mut().filter(|p| p.id == id) {
                        p.name = name.clone();
                        if address.is_some() {
                            p.last_address = address.clone();
                        }
                    }
                });
            }
            if write_json(&mut tls, json!({ "t": "ok", "id": shared.self_id, "name": shared.name() })).await.is_err() {
                return;
            }
            drop(pending);
            run_connection(shared, tls, id, name, peer_fp, false).await;
        }
        "pair" => {
            if !shared.pairing_allowed.load(Ordering::SeqCst) || shared.stopped() {
                let _ = write_json(&mut tls, json!({ "t": "denied", "reason": "closed" })).await;
                return;
            }
            let too_soon = {
                let mut last = shared.last_incoming_pairing.lock().unwrap();
                let too_soon = last.is_some_and(|at| at.elapsed() < PAIRING_INTERVAL);
                if !too_soon {
                    *last = Some(Instant::now());
                }
                too_soon
            };
            // (a PC paired under that id has its own key: one claiming it with another is refused)
            let impostor = shared.state.lock().unwrap().pc(&id).is_some_and(|pc| !constant_time_eq(&pc.fingerprint, &peer_fp));
            if impostor {
                let _ = write_json(&mut tls, json!({ "t": "denied", "reason": "paired" })).await;
                return;
            }
            let claimed = if too_soon { None } else { claim_pairing(&shared) };
            let Some((attempt, commands)) = claimed else {
                let _ = write_json(&mut tls, json!({ "t": "denied", "reason": "busy" })).await;
                return;
            };
            drop(pending);
            let result = pair_incoming(&shared, tls, id, name, peer_fp, commands).await;
            end_pairing(&shared, attempt, result);
        }
        _ => {
            let _ = write_json(&mut tls, json!({ "t": "denied", "reason": "invalid" })).await;
        }
    }
}

// ------------------------------------------------------------------------------------- dialing

async fn dial_loop(shared: Arc<Shared>) {
    let mut stop = shared.stop.clone();
    loop {
        let pcs: Vec<PairedPc> = shared.state.lock().unwrap().pcs.clone();
        for pc in pcs {
            if shared.connected(&pc.id) || !shared.may_dial(&pc.id) || !shared.dialing.lock().unwrap().insert(pc.id.clone()) {
                continue;
            }
            let dialing = Dialing(Arc::clone(&shared), pc.id.clone());
            tokio::spawn(dial(Arc::clone(&shared), pc, dialing));
        }
        tokio::select! {
            _ = sleep(DIAL_INTERVAL) => {}
            _ = shared.wake_dialer.notified() => {}
            _ = stop.changed() => return,
        }
    }
}

type ClientTls = tokio_rustls::client::TlsStream<TcpStream>;

async fn connect(shared: &Shared, address: SocketAddr) -> io::Result<(ClientTls, String)> {
    let tcp = timeout(CONNECT_TIMEOUT, TcpStream::connect(address)).await.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "connect"))??;
    let _ = tcp.set_nodelay(true);
    let name = ServerName::try_from("discipline").expect("a valid name");
    let tls = timeout(HANDSHAKE_TIMEOUT, shared.connector.connect(name, tcp)).await.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "TLS"))??;
    let fp = peer_fingerprint(tls.get_ref().1.peer_certificates()).ok_or_else(|| io::Error::other("no certificate"))?;
    Ok((tls, fp))
}

fn addresses_of(shared: &Shared, pc: &PairedPc) -> Vec<SocketAddr> {
    let mut addresses = shared.found.lock().unwrap().get(&pc.id).map(|f| f.addresses.clone()).unwrap_or_default();
    if let Some(last) = pc.last_address.as_deref().and_then(|a| a.parse::<SocketAddr>().ok())
        && !addresses.contains(&last)
    {
        addresses.push(last);
    }
    addresses.retain(|a| is_local(a.ip()));
    addresses
}

async fn dial(shared: Arc<Shared>, pc: PairedPc, dialing: Dialing) {
    if shared.self_id > pc.id {
        sleep(HIGHER_ID_DELAY).await;
        if shared.connected(&pc.id) {
            return;
        }
    }
    for address in addresses_of(&shared, &pc) {
        if shared.stopped() {
            return;
        }
        let Ok((mut tls, fp)) = connect(&shared, address).await else { continue };
        if shared.stopped() {
            return;
        }
        // another PC at that address, or one posing as it
        if !constant_time_eq(&fp, &pc.fingerprint) {
            continue;
        }
        if write_json(&mut tls, json!({ "t": "sync", "id": shared.self_id, "name": shared.name(), "port": shared.port })).await.is_err() {
            continue;
        }
        let Ok(reply) = read_json(&mut tls).await else { continue };
        match text(&reply, "t").as_str() {
            "ok" if text(&reply, "id") == pc.id => {
                let name = clean_name(&text(&reply, "name"));
                let address = address.to_string();
                if pc.name != name || pc.last_address.as_deref() != Some(&address) {
                    let _ = shared.update_state(|s| {
                        for p in s.pcs.iter_mut().filter(|p| p.id == pc.id) {
                            p.name = name.clone();
                            p.last_address = Some(address.clone());
                        }
                    });
                }
                drop(dialing);
                run_connection(shared, tls, pc.id, name, fp, true).await;
                return;
            }
            // (it has a connection to this PC already)
            "denied" if text(&reply, "reason") == "duplicate" => {
                shared.connection_ended(&pc.id, Duration::ZERO);
                return;
            }
            "denied" => {
                shared.connection_ended(&pc.id, Duration::ZERO);
                let reason = match text(&reply, "reason").as_str() {
                    "unpaired" | "key" => format!("{} removed this PC. Remove it here and pair again.", pc.name),
                    _ => format!("{} refused the connection.", pc.name),
                };
                shared.emit(PcEvent::Refused { peer_id: pc.id.clone(), reason });
                return;
            }
            _ => {}
        }
    }
}

// ------------------------------------------------------------------------------------- connected

/// Registers a connection to a paired PC. If there is one already, both PCs keep the one dialed by
/// the lower id (a reconnection replaces the old one); None: this one is dropped.
fn register(shared: &Shared, peer_id: &str, fingerprint: &str, preferred: bool) -> Option<(u64, mpsc::UnboundedReceiver<Out>)> {
    if shared.stopped() {
        return None;
    }
    let mut conns = shared.conns.lock().unwrap();
    // (removed, or paired anew, while this connection was being made)
    if !shared.state.lock().unwrap().pc(peer_id).is_some_and(|pc| constant_time_eq(&pc.fingerprint, fingerprint)) {
        return None;
    }
    let existing: Vec<u64> = conns.iter().filter(|(_, c)| c.peer_id == peer_id).map(|(k, _)| *k).collect();
    if existing.iter().any(|k| conns[k].preferred) && !preferred {
        return None;
    }
    for k in existing {
        let _ = conns[&k].tx.send(Out::Close);
    }
    let conn = next_conn();
    let (tx, rx) = mpsc::unbounded_channel();
    conns.insert(conn, Conn { peer_id: peer_id.into(), preferred, tx });
    Some((conn, rx))
}

async fn run_connection<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(shared: Arc<Shared>, stream: S, peer_id: String, peer_name: String, fingerprint: String, dialed_here: bool) {
    let dialed_by_lower = if dialed_here { shared.self_id < peer_id } else { peer_id < shared.self_id };
    let Some((conn, mut outbox)) = register(&shared, &peer_id, &fingerprint, dialed_by_lower) else { return };
    let started = Instant::now();
    shared.emit(PcEvent::Connected { conn, peer_id: peer_id.clone(), peer_name });
    let (mut reader, mut writer) = tokio::io::split(stream);
    let mut stop = shared.stop.clone();
    let send = async {
        loop {
            tokio::select! {
                out = outbox.recv() => match out {
                    Some(Out::Text(text)) => timeout(WRITE_TIMEOUT, write_frame(&mut writer, &text)).await.map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??,
                    Some(Out::Close) | None => break,
                },
                _ = sleep(KEEPALIVE) => timeout(WRITE_TIMEOUT, write_frame(&mut writer, "")).await.map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??,
                _ = stop.changed() => break,
            }
        }
        let _ = timeout(Duration::from_secs(2), writer.shutdown()).await;
        Ok::<(), io::Error>(())
    };
    let receive = async {
        while let Ok(frame) = read_frame_patiently(&mut reader, MESSAGE_LIMIT, SILENCE_LIMIT).await {
            if let Some(text) = frame {
                shared.emit(PcEvent::Message { conn, text });
            }
        }
    };
    tokio::select! {
        _ = send => {}
        _ = receive => {}
    }
    shared.conns.lock().unwrap().remove(&conn);
    shared.connection_ended(&peer_id, started.elapsed());
    shared.emit(PcEvent::Closed { conn });
    shared.wake_dialer.notify_one();
}

// ------------------------------------------------------------------------------------- pairing

fn claim_pairing(shared: &Shared) -> Option<(u64, mpsc::UnboundedReceiver<PairCommand>)> {
    let mut slot = shared.pairing.lock().unwrap();
    if slot.is_some() {
        return None;
    }
    let attempt = shared.next_attempt.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::unbounded_channel();
    *slot = Some(ActivePairing { attempt, commands: tx });
    Some((attempt, rx))
}

fn end_pairing(shared: &Shared, attempt: u64, result: Result<(), String>) {
    {
        let mut slot = shared.pairing.lock().unwrap();
        if slot.as_ref().is_some_and(|p| p.attempt == attempt) {
            *slot = None;
        }
    }
    if let Err(reason) = result {
        shared.emit(PcEvent::Pairing(PairingEvent::Failed { reason }));
    }
}

async fn pair_outgoing(shared: Arc<Shared>, peer: FoundPc, attempt: u64, commands: mpsc::UnboundedReceiver<PairCommand>) {
    let result = async {
        let mut connected = None;
        for address in &peer.addresses {
            if shared.stopped() {
                return Err(String::new());
            }
            if let Ok(c) = connect(&shared, *address).await {
                connected = Some(c);
                break;
            }
        }
        let (mut tls, server_fp) = connected.ok_or_else(|| format!("{} can't be reached.", peer.name))?;
        let lost = |_: io::Error| format!("The connection to {} ended.", peer.name);
        write_json(&mut tls, json!({ "t": "pair", "id": shared.self_id, "name": shared.name() })).await.map_err(lost)?;
        let reply = read_json(&mut tls).await.map_err(lost)?;
        match text(&reply, "t").as_str() {
            "pair-ok" => {}
            "denied" if text(&reply, "reason") == "closed" => return Err(format!("Open Devices on {} first, then try again.", peer.name)),
            "denied" if text(&reply, "reason") == "busy" => return Err(format!("{} is busy pairing. Try again in a moment.", peer.name)),
            "denied" if text(&reply, "reason") == "paired" => return Err(format!("{} knows another PC by this one's id. Remove it there first.", peer.name)),
            _ => return Err(format!("{} refused to pair.", peer.name)),
        }
        // its number, committed to before it learns ours
        let commit = text(&reply, "commit");
        if text(&reply, "id") != peer.id || !is_nonce(&commit) {
            return Err(format!("{} answered strangely.", peer.name));
        }
        let name = clean_name(&text(&reply, "name"));
        let nonce = random_hex(32);
        write_json(&mut tls, json!({ "t": "nonce", "nonce": nonce })).await.map_err(lost)?;
        let reveal = read_json(&mut tls).await.map_err(lost)?;
        let their_nonce = text(&reveal, "nonce");
        if text(&reveal, "t") != "reveal" || !is_nonce(&their_nonce) || !constant_time_eq(&sha256_hex(&their_nonce), &commit) {
            return Err(format!("{name} answered strangely."));
        }
        let code = pairing_code((&shared.self_id, &shared.fingerprint), (&peer.id, &server_fp), &nonce, &their_nonce);
        confirm(&shared, tls, peer.id.clone(), name, server_fp, code, false, commands).await
    }
    .await;
    end_pairing(&shared, attempt, result);
}

async fn pair_incoming<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    shared: &Arc<Shared>,
    mut stream: S,
    peer_id: String,
    peer_name: String,
    peer_fp: String,
    commands: mpsc::UnboundedReceiver<PairCommand>,
) -> Result<(), String> {
    let lost = |_: io::Error| format!("The connection to {peer_name} ended.");
    // commit to our number first; reveal it only once the other PC sent its own
    let nonce = random_hex(32);
    write_json(&mut stream, json!({ "t": "pair-ok", "id": shared.self_id, "name": shared.name(), "commit": sha256_hex(&nonce) })).await.map_err(lost)?;
    let theirs = read_json(&mut stream).await.map_err(lost)?;
    let their_nonce = text(&theirs, "nonce");
    if text(&theirs, "t") != "nonce" || !is_nonce(&their_nonce) {
        return Err(format!("{peer_name} answered strangely."));
    }
    write_json(&mut stream, json!({ "t": "reveal", "nonce": nonce })).await.map_err(lost)?;
    let code = pairing_code((&peer_id, &peer_fp), (&shared.self_id, &shared.fingerprint), &their_nonce, &nonce);
    confirm(shared, stream, peer_id, peer_name, peer_fp, code, true, commands).await
}

/// Shows the code and waits until both users confirmed it (then the PCs are paired), or one cancels.
#[allow(clippy::too_many_arguments)]
async fn confirm<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    shared: &Arc<Shared>,
    stream: S,
    peer_id: String,
    peer_name: String,
    peer_fp: String,
    code: String,
    incoming: bool,
    mut commands: mpsc::UnboundedReceiver<PairCommand>,
) -> Result<(), String> {
    shared.emit(PcEvent::Pairing(PairingEvent::Code { code: code.clone(), peer_id: peer_id.clone(), peer_name: peer_name.clone(), incoming }));
    let (mut reader, mut writer) = tokio::io::split(stream);
    // (reading in its own task: a read cut short by another event would lose its bytes)
    let (received_tx, mut received) = mpsc::unbounded_channel();
    let reading = tokio::spawn(async move {
        loop {
            let message = match read_frame(&mut reader, FIRST_MESSAGE_LIMIT).await {
                Ok(None) => continue,
                Ok(Some(text)) => serde_json::from_str::<Value>(&text).ok(),
                Err(_) => None,
            };
            let end = message.is_none();
            if received_tx.send(message).is_err() || end {
                return;
            }
        }
    });
    let deadline = sleep(PAIRING_TIME);
    tokio::pin!(deadline);
    let mut stop = shared.stop.clone();
    let (mut mine, mut theirs) = (false, false);
    let result = loop {
        if mine && theirs {
            let pc = PairedPc { id: peer_id.clone(), name: peer_name.clone(), fingerprint: peer_fp.clone(), paired_at: now_seconds(), last_address: None };
            break match shared.update_state(|s| s.pair_pc(pc)) {
                Ok(()) => Ok(()),
                Err(e) => Err(format!("Can't save: {e}")),
            };
        }
        tokio::select! {
            command = commands.recv() => match command {
                // (a confirmation of another code: the user saw an earlier pairing's)
                Some(PairCommand::Confirm(seen)) if seen != code => {}
                Some(PairCommand::Confirm(_)) => {
                    if !mine {
                        mine = true;
                        if write_json(&mut writer, json!({ "t": "confirm" })).await.is_err() {
                            break Err(format!("The connection to {peer_name} ended."));
                        }
                    }
                }
                Some(PairCommand::Cancel) | None => {
                    let _ = write_json(&mut writer, json!({ "t": "cancel" })).await;
                    break Err(String::new());
                }
            },
            message = received.recv() => match message.flatten() {
                Some(m) if text(&m, "t") == "confirm" => theirs = true,
                Some(m) if text(&m, "t") == "cancel" => break Err(format!("Cancelled on {peer_name}.")),
                Some(_) => {}
                None => break Err(format!("The connection to {peer_name} ended.")),
            },
            _ = &mut deadline => {
                let _ = write_json(&mut writer, json!({ "t": "cancel" })).await;
                break Err("The code wasn't confirmed in time.".into());
            }
            _ = stop.changed() => break Err(String::new()),
        }
    };
    let _ = timeout(Duration::from_secs(2), writer.shutdown()).await;
    reading.abort();
    if result.is_ok() {
        shared.emit(PcEvent::Pairing(PairingEvent::Done { peer_id, peer_name }));
        shared.wake_dialer.notify_one();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc as std_mpsc;

    fn state(id: &str, name: &str) -> SyncState {
        serde_json::from_value(json!({
            "deviceId": id, "name": name, "certificate": "00", "privateKey": "00",
            "iceUfrag": "u", "icePass": "p", "port": 0, "tcpPort": 0, "phones": []
        }))
        .unwrap()
    }

    struct Pc {
        net: PcNet,
        events: std_mpsc::Receiver<PcEvent>,
        state: Arc<Mutex<SyncState>>,
        id: String,
    }

    impl Pc {
        fn start(runtime: &tokio::runtime::Runtime, id: &str, name: &str) -> Pc {
            let cert = str0m::crypto::from_feature_flags().dtls_provider.generate_certificate().unwrap();
            let state = Arc::new(Mutex::new(state(id, name)));
            let (tx, events) = std_mpsc::channel();
            let tx = Mutex::new(tx);
            let config = PcNetConfig { certificate: cert.certificate, private_key: cert.private_key, state: Arc::clone(&state), save: Arc::new(|_| Ok(())), discovery: false };
            let net = PcNet::start(runtime.handle(), "127.0.0.1".parse().unwrap(), config, Arc::new(move |e| { let _ = tx.lock().unwrap().send(e); })).unwrap();
            // (as if the Settings dialog were open)
            net.set_pairing_allowed(true);
            Pc { net, events, state, id: id.into() }
        }

        /// The next event that `pick` accepts (others are skipped)
        fn wait<T>(&self, mut pick: impl FnMut(PcEvent) -> Option<T>) -> T {
            let end = std::time::Instant::now() + Duration::from_secs(20);
            while let Some(left) = end.checked_duration_since(std::time::Instant::now()) {
                if let Ok(event) = self.events.recv_timeout(left)
                    && let Some(found) = pick(event)
                {
                    return found;
                }
            }
            panic!("{}: the expected event didn't come", self.id);
        }

        fn code(&self) -> String {
            self.wait(|e| match e {
                PcEvent::Pairing(PairingEvent::Code { code, .. }) => Some(code),
                PcEvent::Pairing(PairingEvent::Failed { reason }) => panic!("pairing failed: {reason}"),
                _ => None,
            })
        }

        fn connected(&self) -> (u64, String) {
            self.wait(|e| match e {
                PcEvent::Connected { conn, peer_id, .. } => Some((conn, peer_id)),
                _ => None,
            })
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap()
    }

    #[test]
    fn the_code_depends_on_everything() {
        let code = |a: &str, b: &str, c: &str, d: &str, e: &str, f: &str| pairing_code((a, b), (c, d), e, f);
        let base = code("i1", "aa", "i2", "bb", "11", "22");
        assert_eq!(base.len(), 7);
        assert_eq!(base, code("i1", "aa", "i2", "bb", "11", "22"));
        for other in [
            code("i3", "aa", "i2", "bb", "11", "22"),
            code("i1", "ab", "i2", "bb", "11", "22"),
            code("i1", "aa", "i3", "bb", "11", "22"),
            code("i1", "aa", "i2", "bc", "11", "22"),
            code("i1", "aa", "i2", "bb", "12", "22"),
            code("i1", "aa", "i2", "bb", "11", "23"),
        ] {
            assert_ne!(base, other);
        }
    }

    #[test]
    fn two_pcs_pair_with_the_same_code_then_connect_and_exchange_messages() {
        let rt = runtime();
        let a = Pc::start(&rt, "000000000000000a", "Alpha");
        let b = Pc::start(&rt, "000000000000000b", "Beta");
        a.net.add_found(&b.id, "Beta", b.net.local_addr());

        a.net.pair(&b.id).unwrap();
        let (code_a, code_b) = (a.code(), b.code());
        assert_eq!(code_a, code_b);
        // nothing is stored until both confirmed
        a.net.confirm_pairing(&code_a);
        std::thread::sleep(Duration::from_millis(200));
        assert!(a.state.lock().unwrap().pcs.is_empty());
        b.net.confirm_pairing(&code_b);
        for pc in [&a, &b] {
            pc.wait(|e| matches!(e, PcEvent::Pairing(PairingEvent::Done { .. })).then_some(()));
        }
        assert_eq!(a.state.lock().unwrap().pc(&b.id).unwrap().fingerprint, b.net.shared.fingerprint);
        assert_eq!(a.state.lock().unwrap().pc(&b.id).unwrap().name, "Beta");
        assert_eq!(b.state.lock().unwrap().pc(&a.id).unwrap().name, "Alpha");

        // then they connect by themselves (A knows B's address; B only accepts)
        let (conn_a, peer_a) = a.connected();
        let (conn_b, peer_b) = b.connected();
        assert_eq!((peer_a.as_str(), peer_b.as_str()), (b.id.as_str(), a.id.as_str()));
        // both know where the other listens (B learned it from A's connection)
        assert_eq!(a.state.lock().unwrap().pc(&b.id).unwrap().last_address, Some(b.net.local_addr().to_string()));
        assert_eq!(b.state.lock().unwrap().pc(&a.id).unwrap().last_address, Some(a.net.local_addr().to_string()));
        let big = "Grüße € ".repeat(200_000);
        a.net.send(conn_a, big.clone());
        assert_eq!(b.wait(|e| match e { PcEvent::Message { conn, text } if conn == conn_b => Some(text), _ => None }), big);
        b.net.send(conn_b, "hello".into());
        assert_eq!(a.wait(|e| match e { PcEvent::Message { conn, text } if conn == conn_a => Some(text), _ => None }), "hello");

        // B removes A: the connection ends, and A is refused from then on
        b.net.forget(&a.id).unwrap();
        a.wait(|e| matches!(e, PcEvent::Closed { conn } if conn == conn_a).then_some(()));
        let reason = a.wait(|e| match e { PcEvent::Refused { reason, .. } => Some(reason), _ => None });
        assert!(reason.contains("removed this PC"), "{reason}");
    }

    #[test]
    fn cancelling_on_one_side_ends_the_pairing_on_both() {
        let rt = runtime();
        let a = Pc::start(&rt, "000000000000000a", "Alpha");
        let b = Pc::start(&rt, "000000000000000b", "Beta");
        a.net.add_found(&b.id, "Beta", b.net.local_addr());
        a.net.pair(&b.id).unwrap();
        a.code();
        b.code();
        b.net.cancel_pairing();
        let reason = a.wait(|e| match e { PcEvent::Pairing(PairingEvent::Failed { reason }) => Some(reason), _ => None });
        assert_eq!(reason, "Cancelled on Beta.");
        assert_eq!(b.wait(|e| match e { PcEvent::Pairing(PairingEvent::Failed { reason }) => Some(reason), _ => None }), "");
        assert!(a.state.lock().unwrap().pcs.is_empty() && b.state.lock().unwrap().pcs.is_empty());
        // a new attempt works (once the least time between attempts passed)
        std::thread::sleep(PAIRING_INTERVAL);
        a.net.pair(&b.id).unwrap();
        assert_eq!(a.code(), b.code());
    }

    #[test]
    fn a_pc_with_another_key_is_refused_even_with_a_paired_id() {
        let rt = runtime();
        let a = Pc::start(&rt, "000000000000000a", "Alpha");
        let b = Pc::start(&rt, "000000000000000b", "Beta");
        // an impostor claiming to be A, with its own key
        let impostor = Pc::start(&rt, "000000000000000a", "Alpha");
        let fp_a = a.net.shared.fingerprint.clone();
        b.state.lock().unwrap().pair_pc(PairedPc { id: a.id.clone(), name: "Alpha".into(), fingerprint: fp_a, paired_at: 0, last_address: None });
        impostor.state.lock().unwrap().pair_pc(PairedPc { id: b.id.clone(), name: "Beta".into(), fingerprint: b.net.shared.fingerprint.clone(), paired_at: 0, last_address: Some(b.net.local_addr().to_string()) });
        impostor.net.shared.wake_dialer.notify_one();
        let reason = impostor.wait(|e| match e { PcEvent::Refused { reason, .. } => Some(reason), _ => None });
        assert!(reason.contains("removed this PC"), "{reason}");
        std::thread::sleep(Duration::from_millis(200));
        assert!(b.events.try_iter().all(|e| !matches!(e, PcEvent::Connected { .. })));
    }

    #[test]
    fn a_pc_answering_with_another_key_is_not_connected_to() {
        let rt = runtime();
        let a = Pc::start(&rt, "000000000000000a", "Alpha");
        let b = Pc::start(&rt, "000000000000000b", "Beta");
        // A expects some other key at B's address
        a.state.lock().unwrap().pair_pc(PairedPc { id: b.id.clone(), name: "Beta".into(), fingerprint: "00".repeat(32), paired_at: 0, last_address: Some(b.net.local_addr().to_string()) });
        b.state.lock().unwrap().pair_pc(PairedPc { id: a.id.clone(), name: "Alpha".into(), fingerprint: a.net.shared.fingerprint.clone(), paired_at: 0, last_address: None });
        a.net.shared.wake_dialer.notify_one();
        std::thread::sleep(Duration::from_millis(1500));
        assert!(a.events.try_iter().all(|e| !matches!(e, PcEvent::Connected { .. })));
        assert!(b.events.try_iter().all(|e| !matches!(e, PcEvent::Connected { .. })));
    }

    #[test]
    fn when_both_dial_both_keep_the_same_connection() {
        let rt = runtime();
        let a = Pc::start(&rt, "000000000000000a", "Alpha");
        let b = Pc::start(&rt, "000000000000000b", "Beta");
        let (fp_a, fp_b) = (a.net.shared.fingerprint.clone(), b.net.shared.fingerprint.clone());
        a.state.lock().unwrap().pair_pc(PairedPc { id: b.id.clone(), name: "Beta".into(), fingerprint: fp_b, paired_at: 0, last_address: None });
        b.state.lock().unwrap().pair_pc(PairedPc { id: a.id.clone(), name: "Alpha".into(), fingerprint: fp_a, paired_at: 0, last_address: None });
        // both find each other at once
        a.net.add_found(&b.id, "Beta", b.net.local_addr());
        b.net.add_found(&a.id, "Alpha", a.net.local_addr());
        std::thread::sleep(HIGHER_ID_DELAY + Duration::from_secs(2));
        let open = |pc: &Pc| {
            let mut open = HashSet::new();
            for e in pc.events.try_iter() {
                match e {
                    PcEvent::Connected { conn, .. } => {
                        open.insert(conn);
                    }
                    PcEvent::Closed { conn } => {
                        open.remove(&conn);
                    }
                    _ => {}
                }
            }
            open
        };
        let (open_a, open_b) = (open(&a), open(&b));
        assert_eq!((open_a.len(), open_b.len()), (1, 1));
        // it's one connection: a message gets through
        let conn_a = *open_a.iter().next().unwrap();
        let conn_b = *open_b.iter().next().unwrap();
        a.net.send(conn_a, "over the kept connection".into());
        assert_eq!(b.wait(|e| match e { PcEvent::Message { conn, text } if conn == conn_b => Some(text), _ => None }), "over the kept connection");
    }

    #[test]
    fn of_two_connections_to_a_pc_the_one_dialed_by_the_lower_id_is_kept() {
        let rt = runtime();
        let a = Pc::start(&rt, "000000000000000a", "Alpha");
        let shared = &a.net.shared;
        let (b, fp) = ("000000000000000b", "ff".repeat(32));
        // only a paired PC with that key
        assert!(register(shared, b, &fp, true).is_none());
        a.state.lock().unwrap().pair_pc(PairedPc { id: b.into(), name: "Beta".into(), fingerprint: fp.clone(), paired_at: 0, last_address: None });
        assert!(register(shared, b, &"ee".repeat(32), true).is_none());
        let (_, mut first) = register(shared, b, &fp, false).unwrap();
        let (_, mut preferred) = register(shared, b, &fp, true).unwrap();
        assert!(matches!(first.try_recv(), Ok(Out::Close)));
        // one dialed by the higher id doesn't replace it
        assert!(register(shared, b, &fp, false).is_none());
        assert!(preferred.try_recv().is_err());
        // a new one dialed by the lower id (a reconnection) does
        let (_, _newer) = register(shared, b, &fp, true).unwrap();
        assert!(matches!(preferred.try_recv(), Ok(Out::Close)));
    }

    /// Needs a network with multicast (run by hand: `cargo test mdns -- --ignored`)
    #[test]
    #[ignore]
    fn two_pcs_find_each_other_with_mdns() {
        let rt = runtime();
        let ip = {
            let s = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
            s.connect("192.0.2.1:9").unwrap();
            s.local_addr().unwrap().ip()
        };
        let start = |id: &str, name: &str| {
            let cert = str0m::crypto::from_feature_flags().dtls_provider.generate_certificate().unwrap();
            let state = Arc::new(Mutex::new(state(id, name)));
            let (tx, events) = std_mpsc::channel();
            let tx = Mutex::new(tx);
            let config = PcNetConfig { certificate: cert.certificate, private_key: cert.private_key, state: Arc::clone(&state), save: Arc::new(|_| Ok(())), discovery: true };
            let net = PcNet::start(rt.handle(), ip, config, Arc::new(move |e| { let _ = tx.lock().unwrap().send(e); })).unwrap();
            net.set_pairing_allowed(true);
            Pc { net, events, state, id: id.into() }
        };
        let a = start("00000000000000a1", "Alpha");
        let b = start("00000000000000b1", "Beta");
        let found = a.wait(|e| match e { PcEvent::Found(list) if list.iter().any(|f| f.id == b.id) => Some(list), _ => None });
        assert_eq!(found.iter().find(|f| f.id == b.id).unwrap().name, "Beta");
        assert!(found.iter().all(|f| f.id != a.id));
        b.wait(|e| matches!(e, PcEvent::Found(list) if list.iter().any(|f| f.id == a.id)).then_some(()));
        // and pairing by what was found works
        a.net.pair(&b.id).unwrap();
        assert_eq!(a.code(), b.code());
    }

    #[test]
    fn a_reveal_that_doesnt_match_the_commitment_ends_the_pairing() {
        let rt = runtime();
        let a = Pc::start(&rt, "000000000000000a", "Alpha");
        // a fake "B" that changes its number after seeing A's (as a machine in the middle would need)
        let fake = Pc::start(&rt, "000000000000000b", "Beta");
        let acceptor = fake.net.shared.acceptor.clone();
        let listener = rt.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
        let address = listener.local_addr().unwrap();
        rt.spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut tls = acceptor.accept(tcp).await.unwrap();
            read_json(&mut tls).await.unwrap();
            write_json(&mut tls, json!({ "t": "pair-ok", "id": "000000000000000b", "name": "Beta", "commit": sha256_hex(&"11".repeat(32)) })).await.unwrap();
            read_json(&mut tls).await.unwrap();
            write_json(&mut tls, json!({ "t": "reveal", "nonce": "22".repeat(32) })).await.unwrap();
            sleep(Duration::from_secs(5)).await;
        });
        a.net.add_found("000000000000000b", "Beta", address);
        a.net.pair("000000000000000b").unwrap();
        let reason = a.wait(|e| match e {
            PcEvent::Pairing(PairingEvent::Failed { reason }) => Some(reason),
            PcEvent::Pairing(PairingEvent::Code { .. }) => panic!("a code was shown"),
            _ => None,
        });
        assert_eq!(reason, "Beta answered strangely.");
    }

    #[test]
    fn every_attempt_that_learns_the_code_shows_it_and_attempts_are_limited() {
        let rt = runtime();
        let b = Pc::start(&rt, "000000000000000b", "Beta");
        let a = Pc::start(&rt, "000000000000000a", "Alpha");
        let (address, shared) = (b.net.local_addr(), Arc::clone(&a.net.shared));
        // a dialer that learns B's number (and so the code) and hangs up
        let attempt = |shared: Arc<Shared>| async move {
            let (mut tls, _) = connect(&shared, address).await.unwrap();
            write_json(&mut tls, json!({ "t": "pair", "id": "000000000000000a", "name": "Alpha" })).await.unwrap();
            let reply = read_json(&mut tls).await.unwrap();
            if text(&reply, "t") != "pair-ok" {
                return text(&reply, "reason");
            }
            write_json(&mut tls, json!({ "t": "nonce", "nonce": "33".repeat(32) })).await.unwrap();
            let reveal = read_json(&mut tls).await.unwrap();
            assert_eq!(text(&reveal, "t"), "reveal");
            "revealed".into()
        };
        assert_eq!(rt.block_on(attempt(Arc::clone(&shared))), "revealed");
        // B showed that code
        b.code();
        // trying again right away is refused
        assert_eq!(rt.block_on(attempt(Arc::clone(&shared))), "busy");
        // and nobody can start pairing while B's Settings dialog is closed
        b.net.set_pairing_allowed(false);
        std::thread::sleep(PAIRING_INTERVAL);
        assert_eq!(rt.block_on(attempt(shared)), "closed");
    }

    #[test]
    fn confirming_another_code_does_nothing() {
        let rt = runtime();
        let a = Pc::start(&rt, "000000000000000a", "Alpha");
        let b = Pc::start(&rt, "000000000000000b", "Beta");
        a.net.add_found(&b.id, "Beta", b.net.local_addr());
        a.net.pair(&b.id).unwrap();
        let code = a.code();
        b.code();
        a.net.confirm_pairing("000 000");
        b.net.confirm_pairing("000 000");
        std::thread::sleep(Duration::from_millis(300));
        assert!(a.state.lock().unwrap().pcs.is_empty() && b.state.lock().unwrap().pcs.is_empty());
        a.net.confirm_pairing(&code);
        b.net.confirm_pairing(&code);
        a.wait(|e| matches!(e, PcEvent::Pairing(PairingEvent::Done { .. })).then_some(()));
    }

    #[test]
    fn one_address_cant_take_all_unauthenticated_slots() {
        let rt = runtime();
        let a = Pc::start(&rt, "000000000000000a", "Alpha");
        let ip = |n: u8| IpAddr::from([10, 0, 0, n]);
        let first = Pending::new(&a.net.shared, ip(1)).unwrap();
        let _second = Pending::new(&a.net.shared, ip(1)).unwrap();
        assert!(Pending::new(&a.net.shared, ip(1)).is_none());
        // others still get in, up to the limit in all
        let _others: Vec<Pending> = (2..MAX_PENDING as u8).map(|n| Pending::new(&a.net.shared, ip(n)).unwrap()).collect();
        assert!(Pending::new(&a.net.shared, ip(100)).is_none());
        drop(first);
        assert!(Pending::new(&a.net.shared, ip(1)).is_some());
    }

    #[test]
    fn once_stopped_nothing_listens_connects_or_registers() {
        let rt = runtime();
        let a = Pc::start(&rt, "000000000000000a", "Alpha");
        let b = Pc::start(&rt, "000000000000000b", "Beta");
        a.net.add_found(&b.id, "Beta", b.net.local_addr());
        a.net.pair(&b.id).unwrap();
        let code = a.code();
        b.code();
        a.net.confirm_pairing(&code);
        b.net.confirm_pairing(&code);
        let (conn_a, _) = a.connected();
        b.connected();
        b.net.stop();
        // the connection ends on both sides, and B's port is closed
        a.wait(|e| matches!(e, PcEvent::Closed { conn } if conn == conn_a).then_some(()));
        std::thread::sleep(Duration::from_millis(200));
        assert!(std::net::TcpStream::connect_timeout(&b.net.local_addr(), Duration::from_secs(1)).is_err());
        assert!(register(&b.net.shared, &a.id, &a.net.shared.fingerprint, true).is_none());
        // A keeps trying (and failing) to reach B; B never reports a connection again
        a.net.shared.wake_dialer.notify_one();
        std::thread::sleep(Duration::from_millis(500));
        assert!(b.events.try_iter().all(|e| !matches!(e, PcEvent::Connected { .. })));
    }

    #[test]
    fn a_pairing_under_an_already_paired_id_with_another_key_is_refused() {
        let rt = runtime();
        let a = Pc::start(&rt, "000000000000000a", "Alpha");
        let b = Pc::start(&rt, "000000000000000b", "Beta");
        // B knows "A" by another key
        b.state.lock().unwrap().pair_pc(PairedPc { id: a.id.clone(), name: "Alpha".into(), fingerprint: "00".repeat(32), paired_at: 0, last_address: None });
        a.net.add_found(&b.id, "Beta", b.net.local_addr());
        a.net.pair(&b.id).unwrap();
        let reason = a.wait(|e| match e { PcEvent::Pairing(PairingEvent::Failed { reason }) => Some(reason), PcEvent::Pairing(PairingEvent::Code { .. }) => panic!("a code was shown"), _ => None });
        assert!(reason.contains("Remove it there first"), "{reason}");
    }

    #[test]
    fn short_lived_connections_make_the_next_dial_wait_longer() {
        let rt = runtime();
        let a = Pc::start(&rt, "000000000000000a", "Alpha");
        let shared = &a.net.shared;
        assert!(shared.may_dial("000000000000000b"));
        shared.connection_ended("000000000000000b", Duration::from_secs(1));
        assert!(!shared.may_dial("000000000000000b"));
        let wait = |s: &Shared| s.backoff.lock().unwrap()["000000000000000b"].0.saturating_duration_since(Instant::now());
        let first = wait(shared);
        shared.connection_ended("000000000000000b", Duration::from_secs(1));
        assert!(wait(shared) > first + Duration::from_secs(3));
        for _ in 0..20 {
            shared.connection_ended("000000000000000b", Duration::ZERO);
        }
        assert!(wait(shared) <= MAX_BACKOFF);
        // a connection that lasted resets it
        shared.connection_ended("000000000000000b", SHORT_CONNECTION);
        assert!(shared.may_dial("000000000000000b"));
    }
}
