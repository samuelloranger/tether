# Security & networking

## The trust model

Tether's root of trust is **shell access to the host**. Whoever can run `tether pair` on the machine can enroll a device — the same trust decision SSH makes with `authorized_keys`. There is no shared password: nothing to leak, phish, or brute-force.

Each device holds its own **X25519 keypair**. The server keeps a registry of authorized device public keys, and a device proves possession of its private key during a cryptographic handshake — it never sends a reusable secret over the wire. Revoke one device and the others are untouched.

::: warning The password is gone
Earlier releases authenticated every request with a shared `Authorization: Bearer <password>`. That model is **removed outright** — no `set-password`, no bearer routes, no coexistence. On upgrade, every existing client stops connecting until you re-pair it (see [Upgrading from the password model](#upgrading-from-the-password-model)).
:::

## Enrolling a device

Pairing runs from the host and requires a human at the keyboard to confirm each new device.

```sh
tether pair
```

This opens a single-use enrollment window (about 5 minutes) and prints:

- a **12-character code**, grouped `XXXX-XXXX-XXXX`, case-insensitive (Crockford base32 — no `0/O` or `1/I/L`), and
- a **QR code** carrying the server address(es), the code, and the server's key fingerprint.

On the device you either **scan the QR** (phone) or **type the 12-char code plus the address** (desktop — it has no camera, so typing is the primary path). The device generates a fresh keypair, runs the handshake, and sends its public key plus a label you choose.

The host then prompts you to confirm:

```
Device 'sam-iphone'  fp b3f8a1…  authorize? [y/N]
```

Only on `y` is the device written into the registry and the window closed. Knowing the code is necessary but **not sufficient** — a leaked or shoulder-surfed code cannot enroll a device without someone at the host approving it. A second party racing for the same window gets a distinct "code already used" error, and you see both attempts.

Once approved, the device stores its private key in the iOS Keychain / desktop OS keyring, keyed per host, and every later connection authenticates with the key alone.

::: tip Per-host keypairs
A device generates a **separate keypair for each host it pairs with**. The same phone therefore presents different public keys to different servers, so no one — not even someone watching several servers — can correlate "the same device" across them.
:::

## Transport encryption

Every connection is end-to-end encrypted with the **Noise protocol** — the same handshake WireGuard uses — implemented once in Rust via the audited [`snow`](https://docs.rs/snow) crate and shared by iOS, desktop, and the server. This protects the wire **independently of TLS**: confidential, tamper-proof, and MITM-proof on first contact.

The whole API rides inside it. A paired client opens **one Noise-secured channel** — the WebSocket, which runs the handshake as its first bytes — and multiplexes everything over it: the request/response calls that used to be REST endpoints, the live PTY streams, and server→client events. There is no plaintext `/api/*` surface any more.

| Phase | Handshake | What it proves |
|---|---|---|
| **Pairing** (first contact) | `Noise_XXpsk2` | Neither side knows the other yet; the enrollment code is mixed in as a pre-shared key, so a party without the code cannot complete the handshake. The device learns and **pins** the server's static public key. |
| **Reconnect** (steady state) | `Noise_IK` | The device presents its authorized key against the pinned server key. No code, no PSK, no MITM window — every connection after the first. |

Both cipher suites are **fixed constants — never negotiated**, because negotiation is a downgrade surface. A version string (`tether-noise/1`) is bound into every handshake; a mismatch is a hard failure, not a fallback.

### The code is stretched

The enrollment code is not fed into the handshake raw. Both sides derive the pre-shared key as `Argon2id(code)` → 32 bytes, so each offline guess against a recorded pairing handshake costs a full Argon2id evaluation. Combined with the single-use, ~5-minute, rate-limited window, that makes online guessing hopeless and offline guessing expensive — on top of the code's own ~60 bits of entropy.

### Authorization is a registry lookup

Completing an `IK` handshake proves only that the device holds *a* private key — not that it is *authorized*. So after the handshake the server **looks up the device's public key in the registry and drops the connection before any application data if it is absent or revoked**. The drop is fail-closed and indistinguishable from other handshake failures — there is no oracle that confirms "right server, wrong device."

## The server's identity key

The server has its own long-term X25519 static keypair — the identity every device pins on pairing.

- **Generated on first boot** into `~/.tether/config/noise/` (private key `0600` inside a `0700` directory; Windows uses ACLs, as the TLS key already does).
- **Never rotated automatically.** Every paired device pins it, so minting a new one silently would lock all of them out.
- **As sensitive as the TLS private key** — theft enables MITM of every future reconnect — and stored the same way.
- Rotation is a deliberate operator action that invalidates all pins and forces every device to re-pair. Reach for it only if you believe the key is compromised.

## Managing devices

```sh
tether devices                          # list authorized devices
tether device revoke <name|fp-prefix>   # revoke by label or fingerprint prefix
```

```
NAME              FINGERPRINT   PAIRED        LAST SEEN     ADDRESS
sam-iphone        b3f8a1c9      2026-09-01    2m ago        100.x.x.x
desktop-homelab   7q4k92de      2026-09-03    now           127.0.0.1
```

Revoke targets a label or a fingerprint prefix; if the target is ambiguous the CLI refuses and lists the matches rather than guessing. The app mirrors these operations (list plus swipe-to-revoke).

### Revocation keeps your shells alive

Revoking a device does **not** kill any PTY — that would break the persistence that is the whole point of Tether. Precisely:

- Revoke drops **that device's live connection only.** The detached holders and their shells keep running; another authorized device (or the same one, re-paired) reattaches and replays the missed output.
- It also removes the device from the **push** registry, so a revoked phone stops receiving notifications.
- A later reconnect from the revoked key fails the registry lookup and is dropped before any data.
- Revoking your *last* device only warns — shell access plus `tether pair` is always the recovery path.

## What TLS is for now

TLS is no longer what protects your traffic — Noise does that end to end. TLS becomes **optional defence in depth**: an extra outer layer on any HTTP surface that remains, useful but not load-bearing. New installs no longer open a plaintext listener by default; disabling encryption entirely is now an explicit opt-out.

## Reaching the server from outside your LAN

Exposing an inbound port to the internet is a **deployment choice, not something Tether does for you**. A rendezvous relay was considered and deliberately cut — forwarding continuous terminal I/O would mean running bandwidth-heavy public infrastructure this project won't take on.

The recommended path is a **tunnel you already run** — Tailscale, WireGuard, or Cloudflare Tunnel — none of which require an open inbound port. The Noise end-to-end encryption rides safely over any of them. See [Reach your server from anywhere](/reach-from-anywhere) for a step-by-step walkthrough.

## Honest limits

- **A compromised server sees your PTY.** The server runs your shell, so it inherently reads the bytes flowing through it. Noise protects the wire and the pairing — not the host against itself. This is an accepted, documented limit, not a bug.
- **The SQLite session log is not encrypted at rest.** It is locked to the owning user by filesystem permissions (POSIX modes, or ACLs on Windows), but at-rest encryption is deliberately out of scope for now.
- **Not yet audited.** The design targets internet-exposability, but the protocol and crypto have not been through an external audit. Until they have, treat any "internet-safe" or "audited" claim as unearned — pair and run over a network you trust or a tunnel.

::: warning
A remote shell is a high-trust surface. Per-device keypairs and Noise raise the bar considerably, but until the external audit lands, prefer a private network or a tunnel over a bare open port.
:::
