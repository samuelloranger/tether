# Privacy

Tether is self-hosted. The app on your phone or desktop talks to a server **you** run, on hardware you control. There is no Tether account, no Tether backend, and no company on the other end of the connection.

## What the developer collects

Nothing.

There is no analytics SDK, no crash reporter, no telemetry, no advertising identifier, and no third-party tracking library in the app or the server. The developer operates no service that Tether reports to, and therefore receives no data about you, your devices, or your usage.

## Where your data lives

| Data | Stored | Leaves your machine? |
| --- | --- | --- |
| Terminal output and scrollback | SQLite on **your server**, under `~/.tether/` | No |
| Session names, working directories, activity state | SQLite on **your server** | No |
| Server password | argon2 hash on **your server** | No |
| Saved host profiles and preferences | Local app storage on your device | No |
| Host passwords | iOS Keychain / desktop keyring on your device | No |
| Files you browse, diff, or upload | Read from and written to **your server's** filesystem | No |

Terminal logs are capped per session and pruned automatically. Deleting a session, or the `~/.tether/` directory, deletes the data — there is no copy anywhere else.

## Network connections the app makes

Tether only connects where you point it:

- **Your Tether server(s)** — every host you add yourself. All terminal, file, and git traffic goes here and nowhere else.
- **A notification server, if you configure one** — Tether can send push notifications through an [ntfy](https://ntfy.sh)-compatible server when a session needs attention. There is no default endpoint; this is off until you set a URL, and the server you name receives the notification text. Point it at your own ntfy instance if you'd rather it stay in-house.
- **The push relay, if you enable native notifications** — Apple only accepts a push signed by the credential belonging to the app's publisher, so your server cannot talk to Apple directly. It instead sends to a relay, which forwards to Apple. **The relay cannot read your notifications:** your phone generates an encryption key, shares it only with your own servers, and the relay receives a device token and an encrypted blob it has no key for. The notification is decrypted on your phone. The relay stores nothing — no database, no accounts, no logging of payloads. Like everything else here, it is off until you configure a relay URL, and there is no default.
- **GitHub, for update checks** — the server and desktop app query the public GitHub releases API to see whether a newer version exists. This is an anonymous request for a public file.

## Transport security

Tether's own transport is **unencrypted** by default. The password controls access, not confidentiality — anyone able to observe the network between your client and your server can read the traffic. Run Tether over a private network or a tunnel (Tailscale, WireGuard, SSH). See [Security & networking](/security) for the details, because this matters more than anything else on this page.

## What Apple collects

The iOS app is distributed through TestFlight, so Apple collects installation and crash data under [Apple's privacy policy](https://www.apple.com/legal/privacy/), independent of anything Tether does. Crash reports reach the developer only if you opt in on your device, and they contain diagnostic stack traces — never terminal contents.

## Children

Tether is a developer tool for administering your own machines. It is not directed at children and collects nothing from anyone.

## Changes

This policy is versioned in the [Tether repository](https://github.com/samuelloranger/tether) alongside the code it describes; its history is the changelog.

## Contact

Questions: [samuel.loranger@tlmgo.com](mailto:samuel.loranger@tlmgo.com), or open an issue on [GitHub](https://github.com/samuelloranger/tether/issues).
