# Tether rendezvous relay — internet exposure with no open inbound port

**Status:** design / spec review
**Date:** 2026-09-03
**Depends on:** [`2026-09-03-tether-noise-pairing-design.md`](./2026-09-03-tether-noise-pairing-design.md) (the Noise foundation). This sub-project is meaningless without per-device keypairs + Noise E2E already in place.
**Scope:** let a client reach a Tether server from anywhere on the internet **without the server opening any inbound port**, while keeping the relay zero-knowledge.

## Problem

The foundation makes an open port *survivable* (Noise auth, no shared secret, revocable devices). It does not make the port *unnecessary*. To reach your shell from a coffee shop today you still need one of:

- an inbound port exposed to the internet (scannable, floodable, and the thing r/selfhosted tells you never to do), or
- a tunnel/VPN (Tailscale / WireGuard / SSH) you set up and maintain.

Goal: a third option with **no inbound port on the host and no VPN to run** — the server reaches out, the client reaches out, something in the middle introduces them, and it can't read a thing.

## Goals

- **No listening port on the host.** The server makes only *outbound* connections. Nothing to scan, nothing to flood, nothing reachable without completing a Noise handshake.
- **Zero-knowledge relay.** The relay forwards opaque Noise frames. It never holds a private key, never sees plaintext, cannot MITM, cannot impersonate a server.
- **No accounts.** The keypair *is* the identity, exactly as in the foundation. No relay login, no user database of secrets.
- **Self-hostable, allowlisted.** You run the relay (like the existing push relay); it accepts registrations only from server keys you allow. It is not an open public service.
- **Graceful fallback.** Direct LAN / tunnel still works and is preferred when reachable; the relay is the path when the host isn't directly addressable.

## Non-goals

- Hiding *metadata* from the relay. The relay necessarily sees which two public keys are talking, and traffic timing/size. Content stays encrypted; metadata does not. Documented.
- Anonymity / onion routing. This is a rendezvous, not Tor.
- Removing the compromised-server risk. Unchanged from the foundation; the relay doesn't touch it.

## Architecture

```
   server (no inbound port)                         client (phone/desktop)
        │                                                   │
        │  outbound, persistent                             │  outbound
        │  registers pubkey S, proves it                    │  "connect me to pubkey S"
        ▼                                                   ▼
   ┌─────────────────────────────  RELAY  ─────────────────────────────┐
   │  routes on pubkey S · verifies S's registration signature         │
   │  forwards opaque Noise frames both ways · holds no key · logs none │
   └───────────────────────────────────────────────────────────────────┘
        ▲                                                   ▲
        └───────────────── Noise IK handshake ─────────────┘
              end-to-end, THROUGH the relay, client pins S
```

### The rendezvous address = the server's static Noise public key

The server's static Noise public key `S` (from the foundation) is **both its identity and its address** on the relay:

- The server opens a persistent outbound connection to the relay and **registers as `S`**, proving possession by signing a relay-issued challenge with its static private key. The relay verifies the signature against `S`. No accounts, no secrets stored — squatting `S` is impossible without `S`'s private key.
- A client that paired with this server already **pinned `S`** during pairing (out-of-band, via the enrollment code). To connect it tells the relay "route me to `S`." The relay matches `S` to the registered outbound server connection and pipes bytes between the two sockets.
- `S` is a public key — not a secret — so routing on it leaks nothing beyond "these two parties are talking," which the relay would see regardless.

### Zero-knowledge property (why the relay can't cheat)

The Noise `IK` handshake (foundation's reconnect pattern) runs **end-to-end between client and server, tunnelled through the relay as opaque bytes**:

- The relay has neither static private key, so it **cannot decrypt** — it forwards ciphertext.
- The relay **cannot MITM**: the client pinned `S` at pairing, so a relay that substituted its own key would fail the client's handshake against the pinned `S`. Authenticity does not depend on trusting the relay.
- A **compromised relay** therefore reduces to an *availability + metadata* risk: it can drop/delay traffic (DoS) and see which pubkeys talk and when, but it **cannot read, inject, or impersonate**. This is the strongest property this sub-project buys and should be stated plainly in the docs.

### Transport to the relay

- Server↔relay and client↔relay legs are **WebSocket over TLS** (reuses the existing WS stack; TLS here is transport hygiene for the relay hop, not the trust anchor — Noise is). QUIC is a possible later optimization, out of scope.
- The server keeps its relay connection alive with heartbeats and reconnects with backoff; a dropped relay link must not kill running PTY sessions (same detached-holder guarantee as today).
- Multiplexing: one server relay connection carries multiple client sessions, keyed by a per-session channel id the relay assigns. The relay routes frames by channel; it never inspects payloads.

### Reuse the existing relay deployment

`apps/relay` already exists: a Bun + Hono, Dockerized, zero-knowledge **push** relay you deploy yourself. The rendezvous relay is a sibling capability in the same repo/deployment:

- Same zero-knowledge posture, same "you run it" model, same Docker/compose delivery.
- New endpoints: server registration (`/register`, challenge/verify), server carrier connection, client connect-to-pubkey. Push routing stays untouched.
- Relay URL is baked in at build time like the push relay URL (`pushRelay.ts` precedent), overridable for self-hosters.

## Abuse & DoS (the relay is now a reachable service)

The relay is the one internet-facing surface — harden it as such:

- **Server allowlist.** The relay only accepts registrations from server pubkeys on its allowlist (your servers). It is not an open rendezvous for the world. Adding a server key to the relay is an operator action.
- **Per-pubkey connection caps** and global connection limits; drop unauthenticated/incomplete registrations fast.
- **Rate-limit client connect attempts** per source and per target pubkey.
- **No payload logging, no persistence** — matches the push relay's stated posture; a stolen relay disk yields nothing but (at most) pubkey routing metadata, and ideally not even that.
- The relay runs unprivileged with the same systemd hardening recommended for the server.

## Client UX

- A paired host profile gains a **reachability mode**: `direct` (LAN/tunnel address) and/or `relay` (via `S` through the relay).
- Client tries **direct first** (fast path, no relay hop, lowest latency), falls back to relay when direct fails — or the user pins a mode per host.
- Latency: the relay adds one hop. For an interactive terminal this is fine; self-hosting the relay near your servers minimizes it.
- Pairing already delivered `S`; enabling relay for a host needs no re-pair — just the relay URL (baked in) and the host opting its server into relay registration.

## Server UX / CLI

```
tether relay enable        # server starts registering with the relay (outbound only)
tether relay disable       # stop registering
tether relay status        # registered? last heartbeat? current channels?
```

No inbound firewall change is ever required to use the relay — that is the entire point.

## Affected components

- **`apps/relay`** — new rendezvous endpoints + routing; push path untouched; own tests (`bun --cwd apps/relay run test`).
- **`apps/server`** — outbound relay carrier client, `tether relay` verbs, session multiplexing over the carrier, reconnect/backoff that preserves holders.
- **`crates/tether-core`** — the Noise `IK` handshake already exists (foundation); add framing that runs it over a relay channel rather than a direct socket. Client-side relay dialing + `S`-routing request.
- **iOS / desktop clients** — per-host reachability mode UI (direct / relay / auto), relay dialing via the core.
- **Docs** — a "reach your server from anywhere, no open port" page; the zero-knowledge + metadata caveat stated honestly.

## Testing strategy

- **Relay routing:** register `S` (valid signature) → client "connect to `S`" → bytes pipe; wrong/absent signature rejected; unknown-pubkey connect fails cleanly.
- **Zero-knowledge / MITM negative:** a relay that swaps in its own static key must fail the client handshake against pinned `S`; a relay that mangles frames must fail Noise integrity.
- **Resilience:** relay drop mid-session → server reconnects with backoff, holder + PTY survive, client resumes replay (`sinceId`) unchanged.
- **Allowlist / abuse:** non-allowlisted server registration rejected; connection caps enforced; no payload written to disk (assert relay persistence layer stays empty).
- **Fallback:** direct reachable → relay not used; direct fails → relay used; user-pinned mode honored.

## Open questions (resolve during planning)

- Carrier protocol details: WS framing vs a small length-prefixed binary framing for the multiplexed channels.
- Whether relay registration signature reuses the Noise static key directly or a derived signing key (Ed25519 vs X25519 signing ergonomics).
- Relay discovery for fully self-hosted setups: baked-in default + per-host override, or a small discovery record.
- Metadata minimization: can the relay route on a rotating blinded token derived from `S` rather than `S` itself, to avoid even pubkey-level metadata? (Nice-to-have; adds complexity.)
- Multiple relays / failover for availability.
