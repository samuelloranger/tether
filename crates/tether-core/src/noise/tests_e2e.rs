//! One test that walks the whole intended flow: generate a code, derive the
//! PSK on both sides, pair, then reconnect with the pinned key and exchange a
//! large payload over the transport.

use super::{code, pairing, psk, reconnect};

#[test]
fn pair_then_reconnect_then_stream() {
    let server = pairing::generate_static_keypair().unwrap();
    let device = pairing::generate_static_keypair().unwrap();

    let printed = code::generate();
    let typed = code::normalize(&code::grouped(&printed)).unwrap();
    let psk_server = psk::derive(&code::normalize(&printed).unwrap()).unwrap();
    let psk_device = psk::derive(&typed).unwrap();

    let mut i = pairing::PairingInitiator::new(&device.private, &psk_device).unwrap();
    let mut r = pairing::PairingResponder::new(&server.private, &psk_server).unwrap();
    let (mut b, mut rb) = ([0u8; 65535], [0u8; 65535]);
    let n = i.write_message(&[], &mut b).unwrap();
    r.read_message(&b[..n], &mut rb).unwrap();
    let n = r.write_message(&[], &mut b).unwrap();
    i.read_message(&b[..n], &mut rb).unwrap();
    let n = i.write_message(&[], &mut b).unwrap();
    r.read_message(&b[..n], &mut rb).unwrap();

    let pinned_server_pub = i.remote_static().unwrap();
    let enrolled_device_pub = r.remote_static().unwrap();
    assert_eq!(pinned_server_pub, server.public);
    assert_eq!(enrolled_device_pub, device.public);

    let mut ri = reconnect::ReconnectInitiator::new(&device.private, &pinned_server_pub).unwrap();
    let mut rr = reconnect::ReconnectResponder::new(&server.private).unwrap();
    let n = ri.write_message(&[], &mut b).unwrap();
    rr.read_message(&b[..n], &mut rb).unwrap();
    let n = rr.write_message(&[], &mut b).unwrap();
    ri.read_message(&b[..n], &mut rb).unwrap();

    // server would look this up in its registry to authorize:
    assert_eq!(rr.remote_static().unwrap(), device.public);

    let mut cs = ri.into_transport().unwrap();
    let mut ss = rr.into_transport().unwrap();
    let payload = vec![0x42u8; 200_000];
    let wire = cs.seal(&payload).unwrap();
    assert_eq!(ss.open(&wire).unwrap(), payload);
}
