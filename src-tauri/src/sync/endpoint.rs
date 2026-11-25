//! The desktop app's endpoint for phones: WebRTC data channels without a signaling server.
//!
//! The PC is an ICE-lite, DTLS-server endpoint on a fixed UDP port with fixed ICE credentials and a
//! fixed certificate, all announced once in the pairing QR code. A phone builds the PC's side of the
//! WebRTC handshake from that and connects; it checks the PC's certificate fingerprint (DTLS), so
//! nobody else on the network can pose as the PC. The PC accepts any phone certificate and instead
//! authenticates the phone over the encrypted channel: with the one-time pairing secret from the QR
//! code (then it hands the phone a long-term token), or later with that token (stored only as a hash).
//!
//! Each connection attempt gets its own `Rtc` (one per remote ICE ufrag, learned from the phone's
//! first STUN request: an ICE-lite endpoint never sends checks, so it needs no remote password).
//! Only addresses on the local network are served; nothing goes through STUN/TURN servers.
//! After authentication, messages pass between the phone and the app's window (framed, see
//! `framing.rs`); the sync itself happens in the window.

use std::collections::VecDeque;
use std::io::ErrorKind;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use str0m::channel::{ChannelConfig, ChannelId};
use str0m::config::DtlsCert;
use str0m::crypto::Fingerprint;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event as RtcEvent, IceConnectionState, IceCreds, Input, Output, Rtc, RtcConfig};

use super::framing::{split, Reassembler};
use super::state::{constant_time_eq, random_hex, sha256_hex, Phone, SyncState};

/// Connections served at once (more are ignored until one ends)
const MAX_SESSIONS: usize = 16;
/// Of those, the ones not authenticated yet (so strangers can't crowd out paired phones)
const MAX_PENDING: usize = 8;
/// A phone's ICE ufrag whose session ended isn't served again for this long: the browser's checks
/// would revive the ICE side alone, without DTLS, and the phone would think it's still connected
/// (it reconnects with a new ufrag instead)
const ENDED_UFRAG_TIME: Duration = Duration::from_secs(120);

/// Connection numbers, unique for the whole run of the app (the endpoint restarts when the address
/// changes, and the window may still send to an old connection's number)
static NEXT_CONN: AtomicU64 = AtomicU64::new(1);

/// A new connection number (phones and PCs share them)
pub(crate) fn next_conn() -> u64 {
    NEXT_CONN.fetch_add(1, Ordering::Relaxed)
}
/// A phone must prove who it is within this time
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
/// The first message (the proof) is small
const AUTH_MESSAGE_LIMIT: usize = 4 * 1024;
/// Later messages carry the whole data (about 5 MB at 20 000 transactions)
const MESSAGE_LIMIT: usize = 256 * 1024 * 1024;
/// How long a refused phone gets to receive the reason before the connection closes
const LINGER: Duration = Duration::from_secs(2);
/// Upper bound for waiting on the socket, so commands are picked up promptly
const POLL: Duration = Duration::from_millis(50);

/// Something for the app's window
#[derive(Debug, Clone, PartialEq)]
pub enum EndpointEvent {
    /// A phone proved who it is; messages can flow
    Connected { conn: u64, phone_id: String, phone_name: String },
    Message { conn: u64, text: String },
    Closed { conn: u64 },
    /// A new phone was paired (it's stored already)
    Paired { phone_id: String, phone_name: String },
}

#[derive(Debug)]
pub enum Command {
    Send { conn: u64, text: String },
    Close { conn: u64 },
    /// Accept a pairing with this secret until the given time (None: stop accepting)
    Pairing(Option<(String, Instant)>),
    /// Forgets a phone: closes its connections (the state was updated already)
    Forget { phone_id: String },
    Stop,
}

/// Saves the sync state (after a phone was paired or renamed)
pub type SaveState = Box<dyn Fn(&SyncState) -> std::io::Result<()> + Send>;

pub struct EndpointConfig {
    pub cert: DtlsCert,
    pub ice: IceCreds,
    pub device_id: String,
    /// Read when a phone connects (the name can change)
    pub state: Arc<Mutex<SyncState>>,
    pub save: SaveState,
}

/// Only devices on the local network: private, link-local and loopback addresses
pub fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local() || v4.is_loopback(),
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// The USERNAME of a STUN binding request ("receiver:sender" ufrags), if the packet is one
pub fn stun_usernames(packet: &[u8]) -> Option<(String, String)> {
    // STUN: first two bits 0, magic cookie at 4..8, class/method "binding request" (0x0001)
    if packet.len() < 20 || packet[0] & 0xC0 != 0 || packet[4..8] != [0x21, 0x12, 0xA4, 0x42] || packet[0..2] != [0x00, 0x01] {
        return None;
    }
    let mut at = 20;
    while at + 4 <= packet.len() {
        let kind = u16::from_be_bytes([packet[at], packet[at + 1]]);
        let len = u16::from_be_bytes([packet[at + 2], packet[at + 3]]) as usize;
        let value = packet.get(at + 4..at + 4 + len)?;
        if kind == 0x0006 {
            let (ours, theirs) = std::str::from_utf8(value).ok()?.split_once(':')?;
            return Some((ours.to_string(), theirs.to_string()));
        }
        at += 4 + len.div_ceil(4) * 4;
    }
    None
}

/// The phone's first message: pairing (with the QR code's secret) or a later connection (token)
#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Hello {
    Pair { secret: String, id: String, name: String },
    Auth { id: String, token: String, name: String },
}

#[derive(Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Reply<'a> {
    Ok { id: &'a str, name: &'a str, #[serde(skip_serializing_if = "Option::is_none")] token: Option<String> },
    Denied { reason: &'a str },
}

fn valid_phone_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn clean_name(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).take(64).collect();
    if name.trim().is_empty() { "Phone".into() } else { name.trim().to_string() }
}

struct Session {
    conn: u64,
    rtc: Rtc,
    cid: ChannelId,
    remote_ufrag: String,
    started: Instant,
    next_timeout: Instant,
    /// The phone, once it proved who it is
    phone: Option<String>,
    reassembler: Reassembler,
    outbox: VecDeque<String>,
    /// Refused: closes at this time (after the reason went out); no more messages are read
    close_at: Option<Instant>,
    dead: bool,
}

pub struct Endpoint {
    socket: UdpSocket,
    local: SocketAddr,
    config: EndpointConfig,
    sessions: Vec<Session>,
    /// ICE ufrags of ended sessions, and when they ended
    ended: VecDeque<(String, Instant)>,
    pairing: Option<(String, Instant)>,
    events: Box<dyn Fn(EndpointEvent) + Send>,
}

impl Endpoint {
    pub fn new(socket: UdpSocket, config: EndpointConfig, events: Box<dyn Fn(EndpointEvent) + Send>) -> std::io::Result<Self> {
        let local = socket.local_addr()?;
        Ok(Endpoint { socket, local, config, sessions: Vec::new(), ended: VecDeque::new(), pairing: None, events })
    }

    /// Serves until `Command::Stop` or the command channel closes.
    pub fn run(mut self, commands: Receiver<Command>) {
        let mut buf = vec![0u8; 2048];
        loop {
            loop {
                match commands.try_recv() {
                    Ok(Command::Stop) | Err(TryRecvError::Disconnected) => {
                        self.close_all();
                        return;
                    }
                    Ok(command) => self.command(command),
                    Err(TryRecvError::Empty) => break,
                }
            }
            let now = Instant::now();
            for i in 0..self.sessions.len() {
                let s = &mut self.sessions[i];
                if s.next_timeout <= now {
                    let _ = s.rtc.handle_input(Input::Timeout(now));
                }
                if s.phone.is_none() && now.duration_since(s.started) > AUTH_TIMEOUT {
                    s.dead = true;
                }
                if s.close_at.is_some_and(|t| t <= now) {
                    s.dead = true;
                }
                self.drive(i);
            }
            self.reap();

            let wake = self.sessions.iter().map(|s| s.next_timeout).min().map_or(POLL, |t| t.saturating_duration_since(Instant::now()).clamp(Duration::from_millis(1), POLL));
            self.socket.set_read_timeout(Some(wake)).expect("a non-zero read timeout");
            match self.socket.recv_from(&mut buf) {
                Ok((n, source)) => self.receive(&buf[..n], source),
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted) => {}
                // e.g. ICMP "port unreachable" from an earlier send, reported on Windows
                Err(e) if e.kind() == ErrorKind::ConnectionReset => {}
                Err(e) => {
                    log::warn!("sync socket: {e}");
                    std::thread::sleep(POLL);
                }
            }
        }
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Send { conn, text } => {
                if let Some(i) = self.sessions.iter().position(|s| s.conn == conn && s.phone.is_some() && !s.dead) {
                    self.sessions[i].outbox.extend(split(&text));
                    self.drive(i);
                }
            }
            Command::Close { conn } => {
                if let Some(s) = self.sessions.iter_mut().find(|s| s.conn == conn) {
                    s.dead = true;
                }
                self.reap();
            }
            Command::Pairing(pairing) => self.pairing = pairing,
            Command::Forget { phone_id } => {
                for s in &mut self.sessions {
                    if s.phone.as_deref() == Some(&phone_id) {
                        s.dead = true;
                    }
                }
                self.reap();
            }
            Command::Stop => unreachable!("handled in run"),
        }
    }

    fn receive(&mut self, packet: &[u8], source: SocketAddr) {
        // local network only
        if !is_local(source.ip()) {
            return;
        }
        let now = Instant::now();
        // STUN requests are routed by the phone's ufrag: all sessions share our credentials
        let index = if let Some((ours, theirs)) = stun_usernames(packet) {
            if ours != self.config.ice.ufrag {
                return;
            }
            match self.sessions.iter().position(|s| s.remote_ufrag == theirs && !s.dead) {
                Some(i) => Some(i),
                None if self.may_start(&theirs, now) => Some(self.start_session(theirs, now)),
                None => return,
            }
        } else {
            None
        };
        let Ok(contents) = packet.try_into() else { return };
        let input = Input::Receive(now, Receive { proto: Protocol::Udp, source, destination: self.local, contents });
        let index = index.or_else(|| self.sessions.iter().rposition(|s| !s.dead && s.rtc.accepts(&input)));
        let Some(i) = index else { return };
        if let Err(e) = self.sessions[i].rtc.handle_input(input) {
            log::debug!("sync connection {}: {e}", self.sessions[i].conn);
            // (a bad packet, perhaps forged by someone else, mustn't end a working connection)
            if !self.sessions[i].rtc.is_alive() {
                self.sessions[i].dead = true;
            }
        }
        self.drive(i);
        self.reap();
    }

    fn may_start(&mut self, remote_ufrag: &str, now: Instant) -> bool {
        while self.ended.front().is_some_and(|(_, at)| now.duration_since(*at) > ENDED_UFRAG_TIME) {
            self.ended.pop_front();
        }
        let pending = self.sessions.iter().filter(|s| s.phone.is_none()).count();
        self.sessions.len() < MAX_SESSIONS && pending < MAX_PENDING && !self.ended.iter().any(|(u, _)| u == remote_ufrag)
    }

    fn start_session(&mut self, remote_ufrag: String, now: Instant) -> usize {
        let mut rtc = RtcConfig::new()
            .set_ice_lite(true)
            .set_local_ice_credentials(self.config.ice.clone())
            .set_dtls_cert(self.config.cert.clone())
            // the phone's certificate isn't known in advance; it authenticates inside the channel
            .set_fingerprint_verification(false)
            .build(now);
        rtc.add_local_candidate(Candidate::host(self.local, "udp").expect("the bound address is valid")).expect("a host candidate");
        let mut api = rtc.direct_api();
        // str0m wants a remote fingerprint before DTLS; with verification off, any certificate passes
        api.set_remote_fingerprint(Fingerprint { hash_func: "sha-256".into(), bytes: vec![0; 32] });
        // an ICE-lite endpoint never sends checks, so the phone's ICE password isn't needed
        api.set_remote_ice_credentials(IceCreds { ufrag: remote_ufrag.clone(), pass: "unused-by-ice-lite".into() });
        api.set_ice_controlling(false);
        api.start_dtls(false).expect("DTLS starts once");
        api.start_sctp(false);
        let cid = api.create_data_channel(ChannelConfig { label: "discipline".into(), negotiated: Some(0), ..Default::default() });
        let conn = next_conn();
        self.sessions.push(Session {
            conn,
            rtc,
            cid,
            remote_ufrag,
            started: now,
            next_timeout: now,
            phone: None,
            reassembler: Reassembler::new(AUTH_MESSAGE_LIMIT),
            outbox: VecDeque::new(),
            close_at: None,
            dead: false,
        });
        self.sessions.len() - 1
    }

    /// Runs a session until it waits for input: sends what it wants to send, handles its events.
    fn drive(&mut self, i: usize) {
        loop {
            if self.sessions[i].dead {
                return;
            }
            self.flush(i);
            let output = self.sessions[i].rtc.poll_output();
            match output {
                Ok(Output::Timeout(t)) => {
                    self.sessions[i].next_timeout = t;
                    return;
                }
                Ok(Output::Transmit(t)) => {
                    let _ = self.socket.send_to(&t.contents, t.destination);
                }
                Ok(Output::Event(event)) => match event {
                    RtcEvent::IceConnectionStateChange(IceConnectionState::Disconnected) | RtcEvent::ChannelClose(_) => self.sessions[i].dead = true,
                    RtcEvent::ChannelData(data) => {
                        if data.binary {
                            self.sessions[i].dead = true;
                            continue;
                        }
                        match String::from_utf8(data.data) {
                            Ok(frame) => self.frame(i, &frame),
                            Err(_) => self.sessions[i].dead = true,
                        }
                    }
                    _ => {}
                },
                Err(e) => {
                    log::debug!("sync connection {}: {e}", self.sessions[i].conn);
                    self.sessions[i].dead = true;
                }
            }
        }
    }

    /// Writes queued frames as long as the channel takes them (it says when it has room again).
    fn flush(&mut self, i: usize) {
        let s = &mut self.sessions[i];
        let cid = s.cid;
        let Some(mut channel) = s.rtc.channel(cid) else { return };
        while let Some(frame) = s.outbox.front() {
            match channel.write(false, frame.as_bytes()) {
                Ok(true) => {
                    s.outbox.pop_front();
                }
                Ok(false) => return,
                Err(_) => {
                    s.dead = true;
                    return;
                }
            }
        }
    }

    fn frame(&mut self, i: usize, frame: &str) {
        let s = &mut self.sessions[i];
        if s.close_at.is_some() {
            return;
        }
        let message = match s.reassembler.push(frame) {
            Ok(Some(message)) => message,
            Ok(None) => return,
            Err(e) => {
                log::debug!("sync connection {}: bad frame ({e:?})", s.conn);
                s.dead = true;
                return;
            }
        };
        if s.phone.is_some() {
            (self.events)(EndpointEvent::Message { conn: s.conn, text: message });
        } else {
            self.hello(i, &message);
        }
    }

    fn reply(&mut self, i: usize, reply: &Reply) {
        let text = serde_json::to_string(reply).expect("a reply serializes");
        self.sessions[i].outbox.extend(split(&text));
    }

    fn deny(&mut self, i: usize, reason: &str) {
        self.reply(i, &Reply::Denied { reason });
        self.sessions[i].close_at = Some(Instant::now() + LINGER);
    }

    /// The phone's proof of who it is
    fn hello(&mut self, i: usize, message: &str) {
        let Ok(hello) = serde_json::from_str::<Hello>(message) else {
            return self.deny(i, "Unexpected first message.");
        };
        let state = Arc::clone(&self.config.state);
        let mut state = state.lock().unwrap();
        let (phone_id, phone_name, token) = match hello {
            Hello::Pair { secret, id, name } => {
                let open = self.pairing.as_ref().is_some_and(|(expected, until)| Instant::now() < *until && constant_time_eq(&secret, expected));
                if !open || !valid_phone_id(&id) {
                    drop(state);
                    return self.deny(i, "The pairing code is wrong or expired. Show a new code on the PC and scan it again.");
                }
                let token = random_hex(32);
                let name = clean_name(&name);
                let paired_at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
                let mut next = state.clone();
                next.pair_phone(Phone { id: id.clone(), name: name.clone(), token_hash: sha256_hex(&token), paired_at });
                if let Err(e) = (self.config.save)(&next) {
                    log::warn!("saving a paired phone failed: {e}");
                    drop(state);
                    return self.deny(i, "The PC couldn't save the pairing. Try again.");
                }
                *state = next;
                // a pairing code works once
                self.pairing = None;
                (self.events)(EndpointEvent::Paired { phone_id: id.clone(), phone_name: name.clone() });
                (id, name, Some(token))
            }
            Hello::Auth { id, token, name } => {
                let known = state.phone(&id).is_some_and(|p| constant_time_eq(&sha256_hex(&token), &p.token_hash));
                if !known {
                    drop(state);
                    return self.deny(i, "This phone isn't paired with this PC (any more). Pair it again.");
                }
                let name = clean_name(&name);
                if state.phone(&id).is_some_and(|p| p.name != name) {
                    let mut next = state.clone();
                    if let Some(p) = next.phones.iter_mut().find(|p| p.id == id) {
                        p.name = name.clone();
                    }
                    // (only the name: not saving it is harmless)
                    if (self.config.save)(&next).is_ok() {
                        *state = next;
                    }
                }
                (id, name, None)
            }
        };
        let pc_name = state.name.clone();
        drop(state);
        // one connection per phone: an older one is replaced
        for (j, other) in self.sessions.iter_mut().enumerate() {
            if j != i && other.phone.as_deref() == Some(&phone_id) {
                other.dead = true;
            }
        }
        let device_id = self.config.device_id.clone();
        self.reply(i, &Reply::Ok { id: &device_id, name: &pc_name, token });
        let s = &mut self.sessions[i];
        s.phone = Some(phone_id.clone());
        s.reassembler.set_limit(MESSAGE_LIMIT);
        (self.events)(EndpointEvent::Connected { conn: s.conn, phone_id, phone_name });
    }

    /// Removes finished sessions, telling the window about authenticated ones.
    fn reap(&mut self) {
        let events = &self.events;
        let ended = &mut self.ended;
        let now = Instant::now();
        self.sessions.retain_mut(|s| {
            if !s.dead {
                return true;
            }
            s.rtc.disconnect();
            ended.push_back((std::mem::take(&mut s.remote_ufrag), now));
            if s.phone.is_some() {
                events(EndpointEvent::Closed { conn: s.conn });
            }
            false
        });
    }

    fn close_all(&mut self) {
        for s in &mut self.sessions {
            s.dead = true;
        }
        self.reap();
    }
}

#[cfg(test)]
mod tests {
    use super::super::framing::{split, Reassembler};
    use super::super::state::SyncState;
    use super::*;
    use std::sync::mpsc;
    use std::sync::Once;

    fn crypto() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| str0m::crypto::from_feature_flags().install_process_default());
    }

    #[test]
    fn local_addresses_only() {
        for ip in ["192.168.1.2", "10.0.0.1", "172.16.5.4", "169.254.1.1", "127.0.0.1", "::1", "fd00::1", "fe80::1"] {
            assert!(is_local(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "172.32.0.1", "100.64.0.1", "2001:db8::1"] {
            assert!(!is_local(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn reads_the_ufrags_of_a_binding_request() {
        // header: binding request, length 12, magic cookie, transaction id; USERNAME "ab:cd" (padded)
        let mut packet = vec![0x00, 0x01, 0x00, 0x0c, 0x21, 0x12, 0xA4, 0x42];
        packet.extend([0; 12]);
        packet.extend([0x00, 0x06, 0x00, 0x05]);
        packet.extend(b"ab:cd\0\0\0");
        assert_eq!(stun_usernames(&packet), Some(("ab".into(), "cd".into())));
        // a binding response (0x0101) or no STUN at all
        packet[1] = 0x01;
        packet[0] = 0x01;
        assert_eq!(stun_usernames(&packet), None);
        assert_eq!(stun_usernames(b"\x16\xfe\xfd hello dtls"), None);
    }

    /// The PC's endpoint, serving on this machine's LAN address (None if there is none)
    struct Server {
        address: SocketAddr,
        ice: IceCreds,
        fingerprint: Fingerprint,
        commands: mpsc::Sender<Command>,
        events: mpsc::Receiver<EndpointEvent>,
        state: Arc<Mutex<SyncState>>,
    }

    fn server() -> Option<Server> {
        crypto();
        let ip = {
            let s = UdpSocket::bind("0.0.0.0:0").ok()?;
            s.connect("192.0.2.1:9").ok()?;
            s.local_addr().ok()?.ip()
        };
        if !is_local(ip) {
            return None;
        }
        let cert = str0m::crypto::from_feature_flags().dtls_provider.generate_certificate().unwrap();
        let state = Arc::new(Mutex::new(serde_json::from_value::<SyncState>(serde_json::json!({
            "deviceId": "00000000000000aa", "name": "Test PC", "certificate": "00", "privateKey": "00",
            "iceUfrag": "pcufrag1", "icePass": "pcpassword-0123456789ab", "port": 0, "phones": []
        })).unwrap()));
        let socket = UdpSocket::bind(SocketAddr::new(ip, 0)).unwrap();
        let address = socket.local_addr().unwrap();
        let ice = IceCreds { ufrag: "pcufrag1".into(), pass: "pcpassword-0123456789ab".into() };
        let fingerprint = {
            let mut probe = RtcConfig::new().set_dtls_cert(cert.clone()).build(Instant::now());
            probe.direct_api().local_dtls_fingerprint().clone()
        };
        let (event_tx, events) = mpsc::channel();
        let config = EndpointConfig { cert, ice: ice.clone(), device_id: "00000000000000aa".into(), state: Arc::clone(&state), save: Box::new(|_| Ok(())) };
        let endpoint = Endpoint::new(socket, config, Box::new(move |e| { let _ = event_tx.send(e); })).unwrap();
        let (commands, receiver) = mpsc::channel();
        std::thread::spawn(move || endpoint.run(receiver));
        Some(Server { address, ice, fingerprint, commands, events, state })
    }

    /// A phone, as the browser would act: full ICE (controlling), DTLS client, negotiated channel 0
    struct Phone {
        rtc: Rtc,
        socket: UdpSocket,
        local: SocketAddr,
        cid: ChannelId,
        open: bool,
        inbox: Vec<String>,
        reassembler: Reassembler,
        outbox: VecDeque<String>,
    }

    impl Phone {
        fn connect(server: &Server, fingerprint: Fingerprint) -> Phone {
            let socket = UdpSocket::bind(SocketAddr::new(server.address.ip(), 0)).unwrap();
            let local = socket.local_addr().unwrap();
            let mut rtc = RtcConfig::new().build(Instant::now());
            rtc.add_local_candidate(Candidate::host(local, "udp").unwrap()).unwrap();
            rtc.add_remote_candidate(Candidate::host(server.address, "udp").unwrap());
            let mut api = rtc.direct_api();
            api.set_remote_fingerprint(fingerprint);
            api.set_remote_ice_credentials(server.ice.clone());
            api.set_ice_controlling(true);
            api.start_dtls(true).unwrap();
            api.start_sctp(true);
            let cid = api.create_data_channel(ChannelConfig { label: "discipline".into(), negotiated: Some(0), ..Default::default() });
            Phone { rtc, socket, local, cid, open: false, inbox: Vec::new(), reassembler: Reassembler::new(usize::MAX), outbox: VecDeque::new() }
        }

        fn send(&mut self, text: &str) {
            self.outbox.extend(split(text));
        }

        /// Runs until `done` or the time is up; returns whether `done` became true
        fn run_until(&mut self, mut done: impl FnMut(&Phone) -> bool, seconds: u64) -> bool {
            let end = Instant::now() + Duration::from_secs(seconds);
            let mut buf = vec![0u8; 2048];
            while Instant::now() < end {
                if done(self) {
                    return true;
                }
                if self.open
                    && let Some(mut channel) = self.rtc.channel(self.cid)
                {
                    while let Some(frame) = self.outbox.front() {
                        if channel.write(false, frame.as_bytes()).unwrap() {
                            self.outbox.pop_front();
                        } else {
                            break;
                        }
                    }
                }
                let timeout = loop {
                    match self.rtc.poll_output() {
                        Ok(Output::Timeout(t)) => break t,
                        Ok(Output::Transmit(t)) => {
                            self.socket.send_to(&t.contents, t.destination).unwrap();
                        }
                        Ok(Output::Event(RtcEvent::ChannelOpen(..))) => self.open = true,
                        Ok(Output::Event(RtcEvent::ChannelData(d))) => {
                            if let Some(m) = self.reassembler.push(&String::from_utf8(d.data).unwrap()).unwrap() {
                                self.inbox.push(m);
                            }
                        }
                        Ok(Output::Event(_)) => {}
                        Err(e) => panic!("phone: {e:?}"),
                    }
                };
                let wait = timeout.saturating_duration_since(Instant::now()).clamp(Duration::from_millis(1), Duration::from_millis(20));
                self.socket.set_read_timeout(Some(wait)).unwrap();
                match self.socket.recv_from(&mut buf) {
                    Ok((n, source)) => {
                        let input = Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source, destination: self.local, contents: buf[..n].try_into().unwrap() });
                        self.rtc.handle_input(input).unwrap();
                    }
                    Err(_) => self.rtc.handle_input(Input::Timeout(Instant::now())).unwrap(),
                }
            }
            done(self)
        }
    }

    fn next_event(server: &Server, phone: &mut Phone, seconds: u64) -> Option<EndpointEvent> {
        let mut found = None;
        phone.run_until(|_| { found = found.take().or_else(|| server.events.try_recv().ok()); found.is_some() }, seconds);
        found
    }

    fn reply(phone: &mut Phone) -> serde_json::Value {
        assert!(phone.run_until(|p| !p.inbox.is_empty(), 10), "no reply");
        serde_json::from_str(&phone.inbox.remove(0)).unwrap()
    }

    #[test]
    fn pairs_exchanges_large_messages_and_reconnects_with_the_token() {
        let Some(server) = server() else { return eprintln!("no local network address: skipped") };
        server.commands.send(Command::Pairing(Some(("the-secret".into(), Instant::now() + Duration::from_secs(60))))).unwrap();

        let mut phone = Phone::connect(&server, server.fingerprint.clone());
        phone.send(r#"{"t":"pair","secret":"the-secret","id":"0123456789abcdef","name":"Test phone"}"#);
        let ok = reply(&mut phone);
        assert_eq!(ok["t"], "ok");
        assert_eq!(ok["id"], "00000000000000aa");
        assert_eq!(ok["name"], "Test PC");
        let token = ok["token"].as_str().unwrap().to_string();
        assert_eq!(next_event(&server, &mut phone, 5), Some(EndpointEvent::Paired { phone_id: "0123456789abcdef".into(), phone_name: "Test phone".into() }));
        let Some(EndpointEvent::Connected { conn, phone_id, .. }) = next_event(&server, &mut phone, 5) else { panic!("not connected") };
        assert_eq!(phone_id, "0123456789abcdef");
        // only the token's hash is kept
        assert_eq!(server.state.lock().unwrap().phone(&phone_id).unwrap().token_hash, sha256_hex(&token));

        // a large message each way, with multi-byte characters across frame borders
        let big: String = "Grüße € ".repeat(150_000);
        phone.send(&big);
        assert_eq!(next_event(&server, &mut phone, 20), Some(EndpointEvent::Message { conn, text: big.clone() }));
        server.commands.send(Command::Send { conn, text: big.clone() }).unwrap();
        assert!(phone.run_until(|p| !p.inbox.is_empty(), 20));
        assert_eq!(phone.inbox.remove(0), big);

        // the pairing code worked once
        let mut other = Phone::connect(&server, server.fingerprint.clone());
        other.send(r#"{"t":"pair","secret":"the-secret","id":"fedcba9876543210","name":"Intruder"}"#);
        assert_eq!(reply(&mut other)["t"], "denied");

        // later: the token, on a new connection, replaces the old one
        let mut again = Phone::connect(&server, server.fingerprint.clone());
        again.send(&format!(r#"{{"t":"auth","id":"0123456789abcdef","token":"{token}","name":"Test phone"}}"#));
        assert_eq!(reply(&mut again)["t"], "ok");
        let mut seen = Vec::new();
        again.run_until(|_| { while let Ok(e) = server.events.try_recv() { seen.push(e); } seen.len() >= 2 }, 5);
        assert!(seen.contains(&EndpointEvent::Closed { conn }), "{seen:?}");
        assert!(seen.iter().any(|e| matches!(e, EndpointEvent::Connected { phone_id, .. } if phone_id == "0123456789abcdef")), "{seen:?}");
    }

    #[test]
    fn refuses_unknown_phones_wrong_tokens_and_closed_pairing() {
        let Some(server) = server() else { return eprintln!("no local network address: skipped") };
        let cases = [
            // pairing isn't open
            r#"{"t":"pair","secret":"anything","id":"0123456789abcdef","name":"x"}"#.to_string(),
            // never paired
            r#"{"t":"auth","id":"0123456789abcdef","token":"guess","name":"x"}"#.to_string(),
            // not a proof at all
            r#"{"t":"hello"}"#.to_string(),
        ];
        for first in cases {
            let mut phone = Phone::connect(&server, server.fingerprint.clone());
            phone.send(&first);
            assert_eq!(reply(&mut phone)["t"], "denied", "{first}");
        }
        // nothing ever connected
        std::thread::sleep(Duration::from_millis(200));
        assert!(server.events.try_iter().all(|e| !matches!(e, EndpointEvent::Connected { .. })));
    }

    #[test]
    fn strangers_and_ended_connections_are_limited() {
        crypto();
        let cert = str0m::crypto::from_feature_flags().dtls_provider.generate_certificate().unwrap();
        let state = Arc::new(Mutex::new(serde_json::from_value::<SyncState>(serde_json::json!({
            "deviceId": "00000000000000aa", "name": "Test PC", "certificate": "00", "privateKey": "00",
            "iceUfrag": "pcufrag1", "icePass": "pcpassword-0123456789ab", "port": 0, "phones": []
        })).unwrap()));
        let ice = IceCreds { ufrag: "pcufrag1".into(), pass: "pcpassword-0123456789ab".into() };
        let config = EndpointConfig { cert, ice, device_id: "00000000000000aa".into(), state, save: Box::new(|_| Ok(())) };
        let mut endpoint = Endpoint::new(UdpSocket::bind("127.0.0.1:0").unwrap(), config, Box::new(|_| {})).unwrap();
        let now = Instant::now();
        // unauthenticated connections are capped
        for i in 0..MAX_PENDING {
            assert!(endpoint.may_start(&format!("u{i}"), now));
            endpoint.start_session(format!("u{i}"), now);
        }
        assert!(!endpoint.may_start("another", now));
        // connection numbers never repeat
        let conns: std::collections::HashSet<u64> = endpoint.sessions.iter().map(|s| s.conn).collect();
        assert_eq!(conns.len(), MAX_PENDING);
        // an ended connection's ufrag isn't served again for a while
        endpoint.sessions[0].dead = true;
        endpoint.reap();
        assert!(endpoint.may_start("another", now));
        assert!(!endpoint.may_start("u0", now));
        assert!(endpoint.may_start("u0", now + ENDED_UFRAG_TIME + Duration::from_secs(1)));
    }

    #[test]
    fn a_phone_expecting_another_pc_key_never_connects() {
        let Some(server) = server() else { return eprintln!("no local network address: skipped") };
        let wrong = Fingerprint { hash_func: "sha-256".into(), bytes: vec![7; 32] };
        let mut phone = Phone::connect(&server, wrong);
        // the phone aborts the DTLS handshake: the channel never opens
        let opened = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| phone.run_until(|p| p.open, 5)));
        assert!(!matches!(opened, Ok(true)));
    }
}
