//! The desktop app's endpoint for phones without the app around it, for end-to-end tests
//! (`tests/e2e/phone-sync.spec.ts`): pairing is open from the start, the first stdout line is
//! the pairing code; then one JSON line per event. Commands come as JSON lines on stdin.
//!
//! Usage: sync_endpoint <state folder>

use std::io::{BufRead, Write};
use std::net::{SocketAddr, UdpSocket};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use discipline_lib::sync::endpoint::{Command, Endpoint, EndpointConfig, EndpointEvent};
use discipline_lib::sync::state::{hex, state_path, SyncState};
use serde_json::{json, Value};
use str0m::config::DtlsCert;
use str0m::{IceCreds, RtcConfig};

fn main() {
    let provider = str0m::crypto::from_feature_flags();
    provider.clone().install_process_default();
    let dir = std::env::args().nth(1).expect("a state folder");
    let path = state_path(dir.as_ref());
    let mut state = SyncState::load_or_create(&path, || {
        let c = provider.dtls_provider.generate_certificate().unwrap();
        (c.certificate, c.private_key)
    })
    .unwrap();
    state.name = "Test PC".into();
    let cert = DtlsCert { certificate: state.certificate_der().unwrap(), private_key: state.private_key_der().unwrap() };
    let fingerprint = {
        let mut probe = RtcConfig::new().set_dtls_cert(cert.clone()).build(Instant::now());
        hex(&probe.direct_api().local_dtls_fingerprint().bytes)
    };
    let ip = {
        let s = UdpSocket::bind("0.0.0.0:0").unwrap();
        s.connect("192.0.2.1:9").unwrap();
        s.local_addr().unwrap().ip()
    };
    let socket = UdpSocket::bind(SocketAddr::new(ip, 0)).unwrap();
    let address = socket.local_addr().unwrap();
    let secret = "E2eTestSecret0123456";
    println!("DS1|{}|{}|{}|{}|{}|{}|{}", address.ip(), address.port(), state.ice_ufrag, state.ice_pass, fingerprint, secret, state.device_id);
    std::io::stdout().flush().unwrap();

    let ice = IceCreds { ufrag: state.ice_ufrag.clone(), pass: state.ice_pass.clone() };
    let device_id = state.device_id.clone();
    let config = EndpointConfig { cert, ice, device_id, state: Arc::new(Mutex::new(state)), save: Box::new(move |s| s.save(&path)) };
    let out = Mutex::new(std::io::stdout());
    let events = Box::new(move |event: EndpointEvent| {
        let line = match event {
            EndpointEvent::Connected { conn, phone_id, phone_name } => json!({ "event": "connected", "conn": conn, "phoneId": phone_id, "phoneName": phone_name }),
            EndpointEvent::Message { conn, text } => json!({ "event": "message", "conn": conn, "text": text }),
            EndpointEvent::Closed { conn } => json!({ "event": "closed", "conn": conn }),
            EndpointEvent::Paired { phone_id, phone_name } => json!({ "event": "paired", "phoneId": phone_id, "phoneName": phone_name }),
        };
        let mut out = out.lock().unwrap();
        writeln!(out, "{line}").unwrap();
        out.flush().unwrap();
    });
    let endpoint = Endpoint::new(socket, config, events).unwrap();
    let (commands, receiver) = mpsc::channel();
    commands.send(Command::Pairing(Some((secret.into(), Instant::now() + Duration::from_secs(600))))).unwrap();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let conn = v["conn"].as_u64().unwrap_or(0);
            let command = match v["cmd"].as_str() {
                Some("send") => Command::Send { conn, text: v["text"].as_str().unwrap_or_default().to_string() },
                Some("close") => Command::Close { conn },
                Some("pairing") => Command::Pairing(Some((secret.into(), Instant::now() + Duration::from_secs(600)))),
                _ => continue,
            };
            if commands.send(command).is_err() {
                break;
            }
        }
        let _ = commands.send(Command::Stop);
    });
    endpoint.run(receiver);
}
