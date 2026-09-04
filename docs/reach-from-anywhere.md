# Reach your server from anywhere

You don't need to open a port on your router to reach Tether from outside your LAN — and you shouldn't. A **tunnel** gives your devices a private path to the server with **no inbound port exposed to the internet**, and Tether's end-to-end [Noise encryption](/security#transport-encryption) rides safely inside whatever tunnel you pick.

Tether deliberately ships no rendezvous relay of its own: forwarding continuous terminal I/O would mean running bandwidth-heavy public infrastructure. Instead it leans on the tunnels you can already run for free.

::: tip Encryption either way
The tunnel and Tether's own encryption are independent layers. Even a plain LAN connection is already end-to-end encrypted by Noise; the tunnel only decides *how the packets reach the host*, not whether they're readable. You get defence in depth for free.
:::

## Option 1 — Tailscale (recommended)

[Tailscale](https://tailscale.com) builds a private WireGuard network across your devices. Nothing is exposed to the public internet — every device joins your *tailnet* and talks over it directly.

1. **Install Tailscale on the host** and sign in:

   ```sh
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

   (On Windows, install the Tailscale app and sign in.)

2. **Note the host's tailnet address.** `tailscale ip -4` prints a `100.x.x.x` address; the host also has a MagicDNS name like `homelab.tailnet-name.ts.net`.

3. **Install Tailscale on your phone / laptop** — the same app, signed into the same account — and enable it.

4. **Point Tether at the tailnet address.** In the client's setup screen, use the host's `100.x.x.x` address (or its MagicDNS name) instead of a LAN IP, with your usual port. Pair as normal.

That's it. The server never needs a public port, and it's reachable from anywhere both devices can get online.

## Option 2 — Cloudflare Tunnel

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) makes an **outbound-only** connection from your host to Cloudflare, which then serves a hostname you control — again with no inbound port open on your machine.

1. **Install `cloudflared`** on the host and authenticate it (`cloudflared tunnel login`).

2. **Create a tunnel** and route a hostname to Tether's local port:

   ```sh
   cloudflared tunnel create tether
   cloudflared tunnel route dns tether tether.example.com
   ```

3. **Run the tunnel**, forwarding your chosen hostname to the local server:

   ```sh
   cloudflared tunnel run --url http://localhost:8085 tether
   ```

4. **Point Tether at the hostname** (`tether.example.com`) in the client setup screen and pair as normal.

::: tip
Cloudflare terminates its own TLS at the edge, which is fine — Tether's Noise layer stays end-to-end *inside* that anyway, so Cloudflare forwards ciphertext it can't read for the tunnelled API traffic.
:::

## Option 3 — Plain WireGuard or an SSH forward

If you already run your own WireGuard network, just place the host and your devices on it and use the host's WireGuard address — same idea as Tailscale, self-hosted. An `ssh -L` port-forward to the host works too for a one-off from a machine you're already SSH'd into.

## Which should I pick?

| | No open port | Setup effort | Reaches from anywhere |
|---|---|---|---|
| **Tailscale** | Yes | Lowest | Yes |
| **Cloudflare Tunnel** | Yes | Medium (needs a domain) | Yes |
| **Self-hosted WireGuard** | Yes | Higher | Yes |
| **SSH forward** | Yes | Low (per session) | Only while the SSH session is up |

For most people **Tailscale is the easiest path** to a private, always-available connection. Whatever you choose, Tether's per-device keypairs and Noise handshake protect the traffic end to end — the tunnel just gets the packets to the host without a hole in your firewall.
