//! Syncing with phones and other PCs on the local network: the window loads the sync state
//! (`sync_start`) once it's ready for connections; the user turns networking on (`sync_set_enabled`;
//! off at every start: nothing listens, announces or connects until then), pairs devices, and exchanges the sync messages
//! with connected devices through commands (`sync_send`) and events (`sync-connected`,
//! `sync-message`, `sync-closed`, …). Phones connect over WebRTC (`endpoint.rs`), PCs over TLS
//! (`pcs.rs`); connection numbers are unique across both.

pub mod endpoint;
pub mod framing;
pub mod pcs;
pub mod state;

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use qrcode::render::svg;
use qrcode::QrCode;
use serde::Serialize;
use str0m::config::DtlsCert;
use str0m::{IceCreds, RtcConfig};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::data_dir::DataDir;
use endpoint::{Command, Endpoint, EndpointConfig, EndpointEvent};
use pcs::{PcEvent, PcNet, PcNetConfig};
use state::{random_text, state_path, SyncState};

/// How long a pairing QR code works
const PAIRING_TIME: Duration = Duration::from_secs(5 * 60);
/// How often the PC checks whether its network address changed
const ADDRESS_CHECK: Duration = Duration::from_secs(20);
/// Ports tried after the configured one is taken
const PORT_TRIES: u16 = 10;

/// The address used to reach other machines on the network (no packet is sent)
fn lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_unspecified() && endpoint::is_local(ip)).then_some(ip)
}

struct Running {
    commands: Sender<Command>,
    thread: Option<JoinHandle<()>>,
    address: SocketAddr,
    /// Connections to other PCs (None if it couldn't start)
    pcs: Option<PcNet>,
}

impl Running {
    fn stop(&mut self) {
        if let Some(pcs) = &self.pcs {
            pcs.stop();
        }
        let _ = self.commands.send(Command::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[derive(Default)]
pub struct SyncService {
    inner: Mutex<Option<Inner>>,
}

struct Inner {
    state: Arc<Mutex<SyncState>>,
    path: PathBuf,
    cert: DtlsCert,
    fingerprint: String,
    running: Option<Running>,
    /// The user turned networking on (it may still not run: no local network)
    enabled: bool,
    /// Other PCs may start pairing (the Settings dialog is open); kept here, so it survives restarts of serving
    pairing_allowed: bool,
    /// Bumped on each start and stop, so an old address watcher stops
    generation: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncInfo {
    device_id: String,
    name: String,
    /// Networking is on
    enabled: bool,
    /// "ip:port" phones connect to, or null if networking is off or this PC isn't on a local network
    address: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PhoneInfo {
    id: String,
    name: String,
    paired_at: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    /// What the QR code holds
    payload: String,
    svg: String,
    seconds: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PcInfo {
    id: String,
    name: String,
    paired_at: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PcsInfo {
    paired: Vec<PcInfo>,
    /// PCs on the network (paired ones too)
    found: Vec<pcs::FoundPc>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConnectedPayload {
    conn: u64,
    peer_id: String,
    peer_name: String,
    /// "phone" or "pc"
    kind: &'static str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RefusedPayload {
    peer_id: String,
    reason: String,
}

#[derive(Serialize, Clone)]
struct MessagePayload {
    conn: u64,
    text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PairedPayload {
    phone_id: String,
    phone_name: String,
}

fn fingerprint_hex(cert: &DtlsCert) -> String {
    let mut probe = RtcConfig::new().set_dtls_cert(cert.clone()).build(Instant::now());
    state::hex(&probe.direct_api().local_dtls_fingerprint().bytes)
}

fn load(app: &AppHandle) -> Result<Inner, String> {
    let dir = app.try_state::<DataDir>().ok_or("The app has no data folder.")?.path.clone();
    let path = state_path(&dir);
    let provider = str0m::crypto::from_feature_flags();
    let state = SyncState::load_or_create(&path, || {
        let cert = provider.dtls_provider.generate_certificate().expect("a certificate");
        (cert.certificate, cert.private_key)
    })
    .map_err(|e| format!("Can't load the sync settings: {e}"))?;
    let cert = DtlsCert { certificate: state.certificate_der().unwrap(), private_key: state.private_key_der().unwrap() };
    Ok(Inner { fingerprint: fingerprint_hex(&cert), state: Arc::new(Mutex::new(state)), path, cert, running: None, enabled: false, pairing_allowed: false, generation: 0 })
}

/// Binds the endpoint's socket on the LAN address and starts serving.
fn start_endpoint(app: &AppHandle, inner: &mut Inner) -> Option<SocketAddr> {
    if let Some(mut running) = inner.running.take() {
        running.stop();
    }
    let ip = lan_ip()?;
    let (port, ice) = {
        let s = inner.state.lock().unwrap();
        (s.port, IceCreds { ufrag: s.ice_ufrag.clone(), pass: s.ice_pass.clone() })
    };
    let socket = (0..PORT_TRIES).find_map(|i| UdpSocket::bind(SocketAddr::new(ip, port.wrapping_add(i))).ok())?;
    let address = socket.local_addr().ok()?;
    // phones paired from now on know this port: keep it (also for when the usual one is free again)
    if address.port() != port {
        let mut s = inner.state.lock().unwrap();
        let mut next = s.clone();
        next.port = address.port();
        match next.save(&inner.path) {
            Ok(()) => *s = next,
            Err(e) => log::warn!("can't save the sync port: {e}"),
        }
    }
    let path = inner.path.clone();
    let config = EndpointConfig {
        cert: inner.cert.clone(),
        ice,
        device_id: inner.state.lock().unwrap().device_id.clone(),
        state: Arc::clone(&inner.state),
        save: Box::new(move |s: &SyncState| s.save(&path)),
    };
    let events_app = app.clone();
    let events = Box::new(move |event: EndpointEvent| {
        let _ = match event {
            EndpointEvent::Connected { conn, phone_id, phone_name } => events_app.emit("sync-connected", ConnectedPayload { conn, peer_id: phone_id, peer_name: phone_name, kind: "phone" }),
            EndpointEvent::Message { conn, text } => events_app.emit("sync-message", MessagePayload { conn, text }),
            EndpointEvent::Closed { conn } => events_app.emit("sync-closed", conn),
            EndpointEvent::Paired { phone_id, phone_name } => events_app.emit("sync-paired", PairedPayload { phone_id, phone_name }),
        };
    });
    let endpoint = Endpoint::new(socket, config, events).ok()?;
    let (commands, receiver) = mpsc::channel();
    let thread = std::thread::Builder::new().name("discipline-sync".into()).spawn(move || endpoint.run(receiver)).ok()?;
    let pcs = start_pcs(app, inner, ip);
    inner.running = Some(Running { commands, thread: Some(thread), address, pcs });
    Some(address)
}

fn start_pcs(app: &AppHandle, inner: &Inner, ip: IpAddr) -> Option<PcNet> {
    let app = app.clone();
    let events: pcs::Events = Arc::new(move |event: PcEvent| {
        let _ = match event {
            PcEvent::Connected { conn, peer_id, peer_name } => app.emit("sync-connected", ConnectedPayload { conn, peer_id, peer_name, kind: "pc" }),
            PcEvent::Message { conn, text } => app.emit("sync-message", MessagePayload { conn, text }),
            PcEvent::Closed { conn } => app.emit("sync-closed", conn),
            PcEvent::Found(found) => app.emit("sync-pcs-found", found),
            PcEvent::Pairing(pairing) => app.emit("sync-pc-pairing", pairing),
            PcEvent::Refused { peer_id, reason } => app.emit("sync-pc-refused", RefusedPayload { peer_id, reason }),
        };
    });
    let path = inner.path.clone();
    let config = PcNetConfig {
        certificate: inner.cert.certificate.clone(),
        private_key: inner.cert.private_key.clone(),
        state: Arc::clone(&inner.state),
        save: Arc::new(move |s: &SyncState| s.save(&path)),
        discovery: true,
    };
    let pcs = PcNet::start(tauri::async_runtime::handle().inner(), ip, config, events).map_err(|e| log::warn!("can't serve other PCs: {e}")).ok()?;
    pcs.set_pairing_allowed(inner.pairing_allowed);
    Some(pcs)
}

fn info(inner: &Inner) -> SyncInfo {
    let s = inner.state.lock().unwrap();
    SyncInfo { device_id: s.device_id.clone(), name: s.name.clone(), enabled: inner.enabled, address: inner.running.as_ref().map(|r| r.address.to_string()) }
}

fn pcs_of(inner: &Inner) -> Result<&PcNet, String> {
    if !inner.enabled {
        return Err("Turn on syncing first.".into());
    }
    inner.running.as_ref().and_then(|r| r.pcs.as_ref()).ok_or_else(|| "This PC isn't connected to a local network.".into())
}

fn send(inner: &Inner, command: Command) {
    if let Some(running) = &inner.running {
        let _ = running.commands.send(command);
    }
}

/// Loads the sync state. Networking is off at every start (also after the window reloaded): the
/// window must be listening for events before it's turned on.
#[tauri::command(async)]
pub fn sync_start(app: AppHandle, service: State<'_, SyncService>) -> Result<SyncInfo, String> {
    let mut guard = service.inner.lock().unwrap();
    if guard.is_none() {
        *guard = Some(load(&app)?);
    }
    let inner = guard.as_mut().unwrap();
    stop_serving(inner);
    // (a reloaded window has no dialog open)
    inner.pairing_allowed = false;
    Ok(info(inner))
}

/// Turns networking on (listening for phones and PCs, announcing this PC, dialing paired PCs) or off.
#[tauri::command(async)]
pub fn sync_set_enabled(app: AppHandle, service: State<'_, SyncService>, enabled: bool) -> Result<SyncInfo, String> {
    let mut guard = service.inner.lock().unwrap();
    let inner = guard.as_mut().ok_or("Syncing hasn't started.")?;
    if enabled && !inner.enabled {
        serve(&app, inner);
    } else if !enabled {
        stop_serving(inner);
    }
    Ok(info(inner))
}

fn stop_serving(inner: &mut Inner) {
    if let Some(mut running) = inner.running.take() {
        running.stop();
    }
    inner.enabled = false;
    inner.generation += 1;
}

fn serve(app: &AppHandle, inner: &mut Inner) {
    inner.enabled = true;
    start_endpoint(app, inner);
    inner.generation += 1;
    let generation = inner.generation;
    let address = inner.running.as_ref().map(|r| r.address);

    // a new network address (other Wi-Fi, a new lease): serve there instead
    let watcher = app.clone();
    std::thread::spawn(move || {
        let mut current = address;
        loop {
            std::thread::sleep(ADDRESS_CHECK);
            let service = watcher.state::<SyncService>();
            let mut guard = service.inner.lock().unwrap();
            let Some(inner) = guard.as_mut() else { return };
            if inner.generation != generation {
                return;
            }
            // (also if the endpoint stopped, e.g. it panicked)
            let stopped = inner.running.as_ref().is_some_and(|r| r.thread.as_ref().is_none_or(|t| t.is_finished()));
            if stopped || lan_ip() != current.map(|a| a.ip()) {
                current = start_endpoint(&watcher, inner);
                let _ = watcher.emit("sync-address", current.map(|a| a.to_string()));
            } else if let Some(address) = current
                && inner.running.as_ref().is_some_and(|r| r.pcs.is_none())
            {
                // (serving PCs couldn't start: try again)
                let pcs = start_pcs(&watcher, inner, address.ip());
                if let Some(running) = inner.running.as_mut() {
                    running.pcs = pcs;
                }
            }
        }
    });
}

fn with_inner<T>(service: &State<'_, SyncService>, f: impl FnOnce(&mut Inner) -> Result<T, String>) -> Result<T, String> {
    let mut guard = service.inner.lock().unwrap();
    let inner = guard.as_mut().ok_or("Syncing hasn't started.")?;
    f(inner)
}

/// Opens pairing for a few minutes: returns the QR code a phone scans.
#[tauri::command(async)]
pub fn sync_pairing_start(service: State<'_, SyncService>) -> Result<PairingCode, String> {
    with_inner(&service, |inner| {
        if !inner.enabled {
            return Err("Turn on syncing first.".into());
        }
        let address = inner.running.as_ref().map(|r| r.address).ok_or("This PC isn't connected to a local network.")?;
        let secret = random_text(20);
        let (ufrag, pass, id) = {
            let s = inner.state.lock().unwrap();
            (s.ice_ufrag.clone(), s.ice_pass.clone(), s.device_id.clone())
        };
        let payload = format!("DS1|{}|{}|{}|{}|{}|{}|{}", address.ip(), address.port(), ufrag, pass, inner.fingerprint, secret, id);
        let code = QrCode::new(payload.as_bytes()).map_err(|e| e.to_string())?;
        let svg = code.render::<svg::Color>().min_dimensions(240, 240).quiet_zone(true).build();
        send(inner, Command::Pairing(Some((secret, Instant::now() + PAIRING_TIME))));
        Ok(PairingCode { payload, svg, seconds: PAIRING_TIME.as_secs() })
    })
}

#[tauri::command(async)]
pub fn sync_pairing_stop(service: State<'_, SyncService>) -> Result<(), String> {
    with_inner(&service, |inner| {
        send(inner, Command::Pairing(None));
        Ok(())
    })
}

#[tauri::command(async)]
pub fn sync_phones(service: State<'_, SyncService>) -> Result<Vec<PhoneInfo>, String> {
    with_inner(&service, |inner| {
        let s = inner.state.lock().unwrap();
        Ok(s.phones.iter().map(|p| PhoneInfo { id: p.id.clone(), name: p.name.clone(), paired_at: p.paired_at }).collect())
    })
}

/// Unpairs a phone: it can't connect any more (until paired again).
#[tauri::command(async)]
pub fn sync_forget(service: State<'_, SyncService>, phone_id: String) -> Result<(), String> {
    with_inner(&service, |inner| {
        {
            let mut s = inner.state.lock().unwrap();
            let mut next = s.clone();
            if next.forget_phone(&phone_id) {
                next.save(&inner.path).map_err(|e| format!("Can't save: {e}"))?;
                *s = next;
            }
        }
        send(inner, Command::Forget { phone_id });
        Ok(())
    })
}

#[tauri::command(async)]
pub fn sync_rename(service: State<'_, SyncService>, name: String) -> Result<SyncInfo, String> {
    with_inner(&service, |inner| {
        let name: String = name.chars().filter(|c| !c.is_control()).take(64).collect::<String>().trim().to_string();
        if name.is_empty() {
            return Err("Enter a name.".into());
        }
        {
            let mut s = inner.state.lock().unwrap();
            let mut next = s.clone();
            next.name = name;
            next.save(&inner.path).map_err(|e| format!("Can't save: {e}"))?;
            *s = next;
        }
        if let Ok(pcs) = pcs_of(inner) {
            pcs.renamed();
        }
        Ok(info(inner))
    })
}

#[tauri::command(async)]
pub fn sync_send(service: State<'_, SyncService>, conn: u64, text: String) -> Result<(), String> {
    with_inner(&service, |inner| {
        // (the connection is a phone's or a PC's; each side ignores numbers it doesn't know)
        if let Ok(pcs) = pcs_of(inner) {
            pcs.send(conn, text.clone());
        }
        send(inner, Command::Send { conn, text });
        Ok(())
    })
}

#[tauri::command(async)]
pub fn sync_close(service: State<'_, SyncService>, conn: u64) -> Result<(), String> {
    with_inner(&service, |inner| {
        if let Ok(pcs) = pcs_of(inner) {
            pcs.close(conn);
        }
        send(inner, Command::Close { conn });
        Ok(())
    })
}

/// The paired PCs, and the PCs on the network.
#[tauri::command(async)]
pub fn sync_pcs(service: State<'_, SyncService>) -> Result<PcsInfo, String> {
    with_inner(&service, |inner| {
        let paired = inner.state.lock().unwrap().pcs.iter().map(|p| PcInfo { id: p.id.clone(), name: p.name.clone(), paired_at: p.paired_at }).collect();
        let found = pcs_of(inner).map(PcNet::found).unwrap_or_default();
        Ok(PcsInfo { paired, found })
    })
}

/// Starts pairing with a PC on the network; both screens then show a code (`sync-pc-pairing`).
#[tauri::command(async)]
pub fn sync_pc_pair(service: State<'_, SyncService>, peer_id: String) -> Result<(), String> {
    with_inner(&service, |inner| pcs_of(inner)?.pair(&peer_id))
}

/// The user confirmed that both screens show this code.
#[tauri::command(async)]
pub fn sync_pc_pair_confirm(service: State<'_, SyncService>, code: String) -> Result<(), String> {
    with_inner(&service, |inner| {
        pcs_of(inner)?.confirm_pairing(&code);
        Ok(())
    })
}

/// Other PCs may start pairing with this one only while this is on (the Settings dialog is open).
#[tauri::command(async)]
pub fn sync_pc_pairing_allowed(service: State<'_, SyncService>, allowed: bool) -> Result<(), String> {
    with_inner(&service, |inner| {
        inner.pairing_allowed = allowed;
        if let Ok(pcs) = pcs_of(inner) {
            pcs.set_pairing_allowed(allowed);
        }
        Ok(())
    })
}

#[tauri::command(async)]
pub fn sync_pc_pair_cancel(service: State<'_, SyncService>) -> Result<(), String> {
    with_inner(&service, |inner| {
        if let Ok(pcs) = pcs_of(inner) {
            pcs.cancel_pairing();
        }
        Ok(())
    })
}

/// Unpairs a PC: it can't connect any more (until paired again).
#[tauri::command(async)]
pub fn sync_forget_pc(service: State<'_, SyncService>, peer_id: String) -> Result<(), String> {
    with_inner(&service, |inner| match pcs_of(inner) {
        Ok(pcs) => pcs.forget(&peer_id).map_err(|e| format!("Can't save: {e}")),
        // (not serving right now: just remove it)
        Err(_) => {
            let mut s = inner.state.lock().unwrap();
            let mut next = s.clone();
            if next.forget_pc(&peer_id) {
                next.save(&inner.path).map_err(|e| format!("Can't save: {e}"))?;
                *s = next;
            }
            Ok(())
        }
    })
}
