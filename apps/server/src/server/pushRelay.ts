/**
 * Where this server sends encrypted pushes.
 *
 * APNs only accepts a push signed by the credential of the team that publishes
 * the app, so a self-hosted server can never talk to Apple directly — it posts
 * `{token, ciphertext}` to a relay that can read neither. That makes the relay
 * part of the app's distribution, not part of the user's configuration: the
 * only relay that can serve the App Store build is the one holding the matching
 * APNs key. So the URL is baked in at build time rather than typed into a
 * settings field, where a wrong value would look like broken notifications.
 *
 * `TETHER_DEFAULT_PUSH_RELAY_URL` is substituted at compile time by the
 * `--define` in `build:binary` (see apps/server/package.json), which is how CI
 * stamps the official relay into release binaries. The literal below is the
 * fallback for `bun dev:server` and any build that doesn't pass one.
 *
 * `TETHER_PUSH_RELAY_URL` still wins at runtime, for anyone running their own
 * relay against their own Apple team.
 */
export const PUSH_RELAY_URL: string =
  process.env.TETHER_PUSH_RELAY_URL ||
  process.env.TETHER_DEFAULT_PUSH_RELAY_URL ||
  'https://tether-relay.samlo.cloud';
