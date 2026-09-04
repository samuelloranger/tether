//! C ABI over tether-core::noise. Opaque handles; (ptr,len,out_written) buffers;
//! i32 status returns. No panics cross the boundary.

use pairing::{PairingInitiator, PairingResponder};
use tether_core::noise::reconnect::{ReconnectInitiator, ReconnectResponder};
use tether_core::noise::{code, pairing, psk, NoiseSession};

pub const STATUS_OK: i32 = 0;
pub const STATUS_NULL: i32 = -1;
pub const STATUS_SMALL: i32 = -2;
pub const STATUS_CRYPTO: i32 = -3;
pub const STATUS_STATE: i32 = -4;

pub enum Handshake {
    PairInit(PairingInitiator),
    PairResp(PairingResponder),
    ReconInit(ReconnectInitiator),
    ReconResp(ReconnectResponder),
}

pub struct NoiseHandle {
    // Option so into_transport can take the handshake out and swap in a
    // transport session without moving the box.
    hs: Option<Handshake>,
    ts: Option<NoiseSession>,
}

impl NoiseHandle {
    fn boxed(hs: Handshake) -> *mut NoiseHandle {
        Box::into_raw(Box::new(NoiseHandle {
            hs: Some(hs),
            ts: None,
        }))
    }
}

unsafe fn read_key(ptr: *const u8) -> Option<[u8; 32]> {
    if ptr.is_null() {
        return None;
    }
    let mut k = [0u8; 32];
    std::ptr::copy_nonoverlapping(ptr, k.as_mut_ptr(), 32);
    Some(k)
}

// Shared: copy `src` into (out,out_cap), reporting length via out_written.
unsafe fn copy_out(src: &[u8], out: *mut u8, out_cap: usize, out_written: *mut usize) -> i32 {
    if !out_written.is_null() {
        *out_written = src.len();
    }
    if out.is_null() || out_cap < src.len() {
        return STATUS_SMALL;
    }
    std::ptr::copy_nonoverlapping(src.as_ptr(), out, src.len());
    STATUS_OK
}

/// # Safety
/// `out_pub` and `out_priv` must each point to at least 32 writable bytes.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_gen_keypair(out_pub: *mut u8, out_priv: *mut u8) -> i32 {
    if out_pub.is_null() || out_priv.is_null() {
        return STATUS_NULL;
    }
    match pairing::generate_static_keypair() {
        Ok(kp) => {
            std::ptr::copy_nonoverlapping(kp.public.as_ptr(), out_pub, 32);
            std::ptr::copy_nonoverlapping(kp.private.as_ptr(), out_priv, 32);
            STATUS_OK
        }
        Err(_) => STATUS_CRYPTO,
    }
}

/// # Safety
/// `code` must point to `code_len` readable bytes; `out_psk` to 32 writable bytes.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_derive_psk(
    code: *const u8,
    code_len: usize,
    out_psk: *mut u8,
) -> i32 {
    if code.is_null() || out_psk.is_null() {
        return STATUS_NULL;
    }
    let raw = std::slice::from_raw_parts(code, code_len);
    let Ok(text) = std::str::from_utf8(raw) else {
        return STATUS_CRYPTO;
    };
    let Ok(normalized) = code::normalize(text) else {
        return STATUS_CRYPTO;
    };
    match psk::derive(&normalized) {
        Ok(k) => {
            std::ptr::copy_nonoverlapping(k.as_ptr(), out_psk, 32);
            STATUS_OK
        }
        Err(_) => STATUS_CRYPTO,
    }
}

/// # Safety
/// `device_priv` and `psk` must each point to 32 readable bytes.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_pair_initiator_new(
    device_priv: *const u8,
    psk: *const u8,
) -> *mut NoiseHandle {
    let (Some(sk), Some(k)) = (read_key(device_priv), read_key(psk)) else {
        return std::ptr::null_mut();
    };
    match PairingInitiator::new(&sk, &k) {
        Ok(h) => NoiseHandle::boxed(Handshake::PairInit(h)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `server_priv` and `psk` must each point to 32 readable bytes.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_pair_responder_new(
    server_priv: *const u8,
    psk: *const u8,
) -> *mut NoiseHandle {
    let (Some(sk), Some(k)) = (read_key(server_priv), read_key(psk)) else {
        return std::ptr::null_mut();
    };
    match PairingResponder::new(&sk, &k) {
        Ok(h) => NoiseHandle::boxed(Handshake::PairResp(h)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `device_priv` and `server_pub` must each point to 32 readable bytes.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_reconnect_initiator_new(
    device_priv: *const u8,
    server_pub: *const u8,
) -> *mut NoiseHandle {
    let (Some(sk), Some(pk)) = (read_key(device_priv), read_key(server_pub)) else {
        return std::ptr::null_mut();
    };
    match ReconnectInitiator::new(&sk, &pk) {
        Ok(h) => NoiseHandle::boxed(Handshake::ReconInit(h)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `server_priv` must point to 32 readable bytes.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_reconnect_responder_new(
    server_priv: *const u8,
) -> *mut NoiseHandle {
    let Some(sk) = read_key(server_priv) else {
        return std::ptr::null_mut();
    };
    match ReconnectResponder::new(&sk) {
        Ok(h) => NoiseHandle::boxed(Handshake::ReconResp(h)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `h` must be a valid handle; `payload`/`out` valid for their lengths; `out_written` writable.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_write_message(
    h: *mut NoiseHandle,
    payload: *const u8,
    payload_len: usize,
    out: *mut u8,
    out_cap: usize,
    out_written: *mut usize,
) -> i32 {
    let Some(handle) = h.as_mut() else {
        return STATUS_NULL;
    };
    let Some(hs) = handle.hs.as_mut() else {
        return STATUS_STATE;
    };
    let payload_slice = if payload.is_null() {
        &[][..]
    } else {
        std::slice::from_raw_parts(payload, payload_len)
    };
    let mut tmp = [0u8; 65535];
    let res = match hs {
        Handshake::PairInit(x) => x.write_message(payload_slice, &mut tmp),
        Handshake::PairResp(x) => x.write_message(payload_slice, &mut tmp),
        Handshake::ReconInit(x) => x.write_message(payload_slice, &mut tmp),
        Handshake::ReconResp(x) => x.write_message(payload_slice, &mut tmp),
    };
    match res {
        Ok(n) => copy_out(&tmp[..n], out, out_cap, out_written),
        Err(_) => STATUS_CRYPTO,
    }
}

/// # Safety
/// `h` must be a valid handle; `msg`/`out` valid for their lengths; `out_written` writable.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_read_message(
    h: *mut NoiseHandle,
    msg: *const u8,
    msg_len: usize,
    out: *mut u8,
    out_cap: usize,
    out_written: *mut usize,
) -> i32 {
    let Some(handle) = h.as_mut() else {
        return STATUS_NULL;
    };
    let Some(hs) = handle.hs.as_mut() else {
        return STATUS_STATE;
    };
    let msg_slice = std::slice::from_raw_parts(msg, msg_len);
    let mut tmp = [0u8; 65535];
    let res = match hs {
        Handshake::PairInit(x) => x.read_message(msg_slice, &mut tmp),
        Handshake::PairResp(x) => x.read_message(msg_slice, &mut tmp),
        Handshake::ReconInit(x) => x.read_message(msg_slice, &mut tmp),
        Handshake::ReconResp(x) => x.read_message(msg_slice, &mut tmp),
    };
    match res {
        Ok(n) => copy_out(&tmp[..n], out, out_cap, out_written),
        Err(_) => STATUS_CRYPTO,
    }
}

/// # Safety
/// `h` must be a valid handle previously returned by a `*_new` function, or null.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_is_finished(h: *mut NoiseHandle) -> i32 {
    let Some(handle) = h.as_ref() else {
        return STATUS_NULL;
    };
    match handle.hs.as_ref() {
        Some(Handshake::PairInit(x)) => x.is_finished() as i32,
        Some(Handshake::PairResp(x)) => x.is_finished() as i32,
        Some(Handshake::ReconInit(x)) => x.is_finished() as i32,
        Some(Handshake::ReconResp(x)) => x.is_finished() as i32,
        None => 1, // already in transport mode ⇒ handshake was finished
    }
}

/// # Safety
/// `h` valid; `out` valid for `out_cap`; `out_written` writable.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_remote_static(
    h: *mut NoiseHandle,
    out: *mut u8,
    out_cap: usize,
    out_written: *mut usize,
) -> i32 {
    let Some(handle) = h.as_ref() else {
        return STATUS_NULL;
    };
    let key = match handle.hs.as_ref() {
        Some(Handshake::PairInit(x)) => x.remote_static(),
        Some(Handshake::PairResp(x)) => x.remote_static(),
        Some(Handshake::ReconResp(x)) => x.remote_static(),
        // ReconInit knows the remote statically already; not exposed here.
        _ => return STATUS_STATE,
    };
    match key {
        Ok(k) => copy_out(&k, out, out_cap, out_written),
        Err(_) => STATUS_CRYPTO,
    }
}

/// # Safety
/// `h` must be a valid, handshake-finished handle.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_into_transport(h: *mut NoiseHandle) -> i32 {
    let Some(handle) = h.as_mut() else {
        return STATUS_NULL;
    };
    let Some(hs) = handle.hs.take() else {
        return STATUS_STATE;
    };
    let ts = match hs {
        Handshake::PairInit(x) => x.into_transport(),
        Handshake::PairResp(x) => x.into_transport(),
        Handshake::ReconInit(x) => x.into_transport(),
        Handshake::ReconResp(x) => x.into_transport(),
    };
    match ts {
        Ok(session) => {
            handle.ts = Some(session);
            STATUS_OK
        }
        Err(_) => STATUS_STATE, // handshake was not finished
    }
}

/// # Safety
/// `h` valid transport handle; buffers valid for their lengths.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_seal(
    h: *mut NoiseHandle,
    plaintext: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
    out_written: *mut usize,
) -> i32 {
    let Some(handle) = h.as_mut() else {
        return STATUS_NULL;
    };
    let Some(ts) = handle.ts.as_mut() else {
        return STATUS_STATE;
    };
    let src = if plaintext.is_null() {
        &[][..]
    } else {
        std::slice::from_raw_parts(plaintext, len)
    };
    match ts.seal(src) {
        Ok(wire) => copy_out(&wire, out, out_cap, out_written),
        Err(_) => STATUS_CRYPTO,
    }
}

/// # Safety
/// `h` valid transport handle; buffers valid for their lengths.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_open(
    h: *mut NoiseHandle,
    wire: *const u8,
    len: usize,
    out: *mut u8,
    out_cap: usize,
    out_written: *mut usize,
) -> i32 {
    let Some(handle) = h.as_mut() else {
        return STATUS_NULL;
    };
    let Some(ts) = handle.ts.as_mut() else {
        return STATUS_STATE;
    };
    let src = std::slice::from_raw_parts(wire, len);
    match ts.open(src) {
        Ok(plain) => copy_out(&plain, out, out_cap, out_written),
        Err(_) => STATUS_CRYPTO,
    }
}

/// # Safety
/// `h` must be a valid transport handle, or null.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_rekey_outgoing(h: *mut NoiseHandle) -> i32 {
    let Some(handle) = h.as_mut() else {
        return STATUS_NULL;
    };
    match handle.ts.as_mut() {
        Some(ts) => {
            ts.rekey_outgoing();
            STATUS_OK
        }
        None => STATUS_STATE,
    }
}

/// # Safety
/// `h` must be a valid transport handle, or null.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_rekey_incoming(h: *mut NoiseHandle) -> i32 {
    let Some(handle) = h.as_mut() else {
        return STATUS_NULL;
    };
    match handle.ts.as_mut() {
        Some(ts) => {
            ts.rekey_incoming();
            STATUS_OK
        }
        None => STATUS_STATE,
    }
}

/// # Safety
/// `h` must be a handle previously returned by a `*_new` function, or null.
#[no_mangle]
pub unsafe extern "C" fn tether_noise_free(h: *mut NoiseHandle) {
    if !h.is_null() {
        drop(Box::from_raw(h));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Helper: pump one message direction.
    unsafe fn pump(
        from: *mut NoiseHandle,
        to: *mut NoiseHandle,
        buf: &mut [u8],
        scratch: &mut [u8],
    ) -> bool {
        let mut w = 0usize;
        if tether_noise_write_message(
            from,
            std::ptr::null(),
            0,
            buf.as_mut_ptr(),
            buf.len(),
            &mut w,
        ) != STATUS_OK
        {
            return false;
        }
        let mut r = 0usize;
        tether_noise_read_message(
            to,
            buf.as_ptr(),
            w,
            scratch.as_mut_ptr(),
            scratch.len(),
            &mut r,
        ) == STATUS_OK
    }

    #[test]
    fn gen_keypair_writes_two_distinct_32_byte_keys() {
        let mut pk = [0u8; 32];
        let mut sk = [0u8; 32];
        let rc = unsafe { tether_noise_gen_keypair(pk.as_mut_ptr(), sk.as_mut_ptr()) };
        assert_eq!(rc, STATUS_OK);
        assert_ne!(pk, [0u8; 32]);
        assert_ne!(sk, [0u8; 32]);
        assert_ne!(pk, sk);
    }

    #[test]
    fn gen_keypair_rejects_null() {
        let mut pk = [0u8; 32];
        assert_eq!(
            unsafe { tether_noise_gen_keypair(pk.as_mut_ptr(), std::ptr::null_mut()) },
            STATUS_NULL
        );
    }

    #[test]
    fn derive_psk_is_deterministic() {
        let code = b"011B-2345-6789";
        let mut a = [0u8; 32];
        let mut b = [0u8; 32];
        assert_eq!(
            unsafe { tether_noise_derive_psk(code.as_ptr(), code.len(), a.as_mut_ptr()) },
            STATUS_OK
        );
        assert_eq!(
            unsafe { tether_noise_derive_psk(code.as_ptr(), code.len(), b.as_mut_ptr()) },
            STATUS_OK
        );
        assert_eq!(a, b);
    }

    #[test]
    fn pairing_handshake_completes_through_the_abi() {
        let mut dpk = [0u8; 32];
        let mut dsk = [0u8; 32];
        let mut spk = [0u8; 32];
        let mut ssk = [0u8; 32];
        unsafe { tether_noise_gen_keypair(dpk.as_mut_ptr(), dsk.as_mut_ptr()) };
        unsafe { tether_noise_gen_keypair(spk.as_mut_ptr(), ssk.as_mut_ptr()) };
        let code = b"011B-2345-6789";
        let mut pskb = [0u8; 32];
        unsafe { tether_noise_derive_psk(code.as_ptr(), code.len(), pskb.as_mut_ptr()) };

        let i = unsafe { tether_noise_pair_initiator_new(dsk.as_ptr(), pskb.as_ptr()) };
        let r = unsafe { tether_noise_pair_responder_new(ssk.as_ptr(), pskb.as_ptr()) };
        assert!(!i.is_null() && !r.is_null());

        let (mut buf, mut scratch) = ([0u8; 65535], [0u8; 65535]);
        unsafe {
            assert!(pump(i, r, &mut buf, &mut scratch)); // -> e
            assert!(pump(r, i, &mut buf, &mut scratch)); // <- e,ee,s,es
            assert!(pump(i, r, &mut buf, &mut scratch)); // -> s,se
            assert_eq!(tether_noise_is_finished(i), 1);
            assert_eq!(tether_noise_is_finished(r), 1);

            let mut rs = [0u8; 32];
            let mut w = 0usize;
            assert_eq!(
                tether_noise_remote_static(r, rs.as_mut_ptr(), rs.len(), &mut w),
                STATUS_OK
            );
            assert_eq!(rs, dpk);

            tether_noise_free(i);
            tether_noise_free(r);
            tether_noise_free(std::ptr::null_mut());
        }
    }

    #[test]
    fn transport_round_trips_through_the_abi() {
        let mut dpk = [0u8; 32];
        let mut dsk = [0u8; 32];
        let mut spk = [0u8; 32];
        let mut ssk = [0u8; 32];
        unsafe { tether_noise_gen_keypair(dpk.as_mut_ptr(), dsk.as_mut_ptr()) };
        unsafe { tether_noise_gen_keypair(spk.as_mut_ptr(), ssk.as_mut_ptr()) };
        let code = b"011B-2345-6789";
        let mut pskb = [0u8; 32];
        unsafe { tether_noise_derive_psk(code.as_ptr(), code.len(), pskb.as_mut_ptr()) };

        let i = unsafe { tether_noise_pair_initiator_new(dsk.as_ptr(), pskb.as_ptr()) };
        let r = unsafe { tether_noise_pair_responder_new(ssk.as_ptr(), pskb.as_ptr()) };
        let (mut buf, mut scratch) = ([0u8; 65535], [0u8; 65535]);
        unsafe {
            pump(i, r, &mut buf, &mut scratch);
            pump(r, i, &mut buf, &mut scratch);
            pump(i, r, &mut buf, &mut scratch);
            assert_eq!(tether_noise_into_transport(i), STATUS_OK);
            assert_eq!(tether_noise_into_transport(r), STATUS_OK);

            let msg = b"hello over ffi";
            let mut wire = [0u8; 256];
            let mut wn = 0usize;
            assert_eq!(
                tether_noise_seal(
                    i,
                    msg.as_ptr(),
                    msg.len(),
                    wire.as_mut_ptr(),
                    wire.len(),
                    &mut wn
                ),
                STATUS_OK
            );
            let mut plain = [0u8; 256];
            let mut pn = 0usize;
            assert_eq!(
                tether_noise_open(
                    r,
                    wire.as_ptr(),
                    wn,
                    plain.as_mut_ptr(),
                    plain.len(),
                    &mut pn
                ),
                STATUS_OK
            );
            assert_eq!(&plain[..pn], msg);

            tether_noise_free(i);
            tether_noise_free(r);
        }
    }
}
