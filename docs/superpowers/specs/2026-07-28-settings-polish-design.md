# Settings correctness & design pass

Date: 2026-07-28
Status: designed

## Context

Specs 1–3 shipped the server config store, the multi-host client, and the per-host Server Settings screen. A post-review of that work found six correctness defects — all in the newest surface, `ServerSettings.tsx` — plus a design gap: the two new screens ignore the design foundations the rest of the app already uses.

Nothing structural is wrong. This spec is a finishing pass, in two parts that ship in that order.

## Part 1 — Correctness

### 1. Message severity is inferred from copy (`ServerSettings.tsx:350-358`)

```js
message.includes('failed') || message.includes('Could not') ? styles.error : styles.message
```

One `message` state carries every outcome and the style is chosen by substring-matching the text. `"New passwords must match."` and every validation error render in success green, and any future error phrased without "failed"/"Could not" reads as success.

Replace with an explicit `{ kind: 'success' | 'error', text: string }`. Every `setMessage` call site declares its kind. No string inspection anywhere in the render path.

### 2. Notification URL is validated even when notifications are off (`serverSettingsModel.ts:65-69`)

`new URL(draft.notify.url)` runs unconditionally, so clearing the URL with `notify.enabled === false` blocks Save on an unrelated field — you cannot rename the host until you satisfy a validator for a feature you disabled.

Validate `notify.url` and `notify.topic` only when `draft.notify.enabled` is true. An empty URL with notifications off is valid. Note the server default is `https://ntfy.sh`, which is why this is invisible on a fresh install — test the cleared-field case explicitly.

### 3. Numeric fields cannot be cleared (`ServerSettings.tsx:302, 328, 337`)

`onChangeText={v => set(field, Number(v))}` with `value={String(draft.field)}` means deleting the last digit produces `Number('') === 0`, which renders back as `"0"`.

Hold numeric inputs as **strings** in the draft and parse at the validation/patch boundary. An empty field is an editing state, not zero; it fails validation on Save with a field error, and Save stays disabled. `Number.isInteger` checks move to the parse step.

### 4. Only the first validation error is shown (`ServerSettings.tsx:113-115`)

`Object.values(errors)[0]` discards the per-field error map the model already computes, and shows one message at the bottom of a long scrolling screen.

Render each error inline, under its own field, from the existing `ServerSettingsErrors` map. The bottom message area is for operation outcomes (saved, test sent, update result) only.

### 5. SSRF surface on the notify URL (`app.ts:231`, `config.ts:10`)

`POST /api/admin/test-notification` accepts an arbitrary `notify.url` and makes the server POST to it, returning the failure text at 502 — an oracle for probing loopback, LAN, and cloud metadata addresses. `PATCH /api/config` stores the same arbitrary URL.

Severity is low (token-authed, and a token holder already has a shell), so this is hardening, not a hole. Reject URLs resolving to loopback, link-local (`169.254.0.0/16`, `fe80::/10`), and private ranges (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`) in the config schema, applied by both `PATCH /api/config` and the test endpoint.

Because self-hosted ntfy on the LAN is a legitimate setup — and one this project's users will actually have — gate the restriction behind an opt-out: `TETHER_ALLOW_PRIVATE_NOTIFY_URL=1`. When the check rejects a URL, the error must say why and name the env var, or the feature looks broken to exactly the audience most likely to hit it.

Also stop returning raw fetch error text at 502. Return a fixed message plus a stable code; log the detail server-side.

### 6. `deliver()` retries with no delay (`notifier.ts:72-78`)

`catch { await post() }` fires the retry immediately — against a flapping host, two 3s-timeout requests back to back. Add a 1s delay before the retry. Keep the total bounded and off the PTY path; failures stay swallowed by `send()`.

## Part 2 — Design

The app already has coherent foundations: `appTheme.ts` (Catppuccin latte/frappé/macchiato/mocha behind semantic `AppColors`), `interaction.ts` (`MIN_TOUCH_TARGET`, `SURFACE_RADIUS`), `motion.ts` (typed durations, reduced motion respected), and accessibility labels throughout. **This is not a redesign.** The problem is that `ServerSettings.tsx` and `HostsScreen.tsx` were built with inline styles and hardcoded sizes — 11, 12, 13, 18, 22, plus 10 and 13 in `styles.ts` — seven ad-hoc sizes and no scale.

Do not introduce new fonts (Fira Code is chosen for box-drawing/powerline glyph coverage — that constraint stands), a new palette, or new motion.

### 2.1 Type scale

New `apps/mobile/src/type.ts`, beside `interaction.ts`, derived from sizes already in use:

| Role | Size | Weight | Notes |
|---|---|---|---|
| `display` | 22 | 700 | screen titles |
| `title` | 18 | 700 | section headers |
| `body` | 14 | 400 | primary text, inputs |
| `label` | 12 | 500 | field labels |
| `caption` | 11 | 400 | hints, metadata |
| `eyebrow` | 13 | 700 | uppercase, letter-spacing 0.5 — the existing header treatment, promoted from a one-off |

Each role exports a complete `TextStyle` (size, weight, letter-spacing, line-height). `ServerSettings.tsx` and `HostsScreen.tsx` adopt it fully; `styles.ts` migrates opportunistically where a size already matches a role. Do not chase every call site in this pass.

### 2.2 Copy

Name things by what the user controls, never by how the system is built.

| Now | Becomes |
|---|---|
| OSC notify | Alerts from programs |
| Waiting | Agent needs input |
| Exit | Session ends |
| Long job | Long command finishes |
| Long job seconds | Count a command as long after |
| Silence threshold (ms) | Mark a session idle after |
| Server ops | Maintenance |
| Identity | This server |
| Replacement token | New token |
| Send test | Send test notification |

`silenceMs` is entered and displayed in **seconds**, converted at the API boundary. Milliseconds are a wire format, not a human unit. The server contract does not change.

Rules for any copy written here: sentence case; active voice; an action keeps its name from button to result ("Send test notification" → "Test notification sent"); errors say what happened and what to do, without apologising.

### 2.3 Structure

The four sections currently carry equal visual weight, so Change password / Update / Restart sit in the same register as a text field. Separate the destructive group: a divider, a quieter treatment, and danger-tinted actions below the settings proper, so the screen's shape shows where the sharp edges are.

### 2.4 Host colour as a spatial anchor

Each host's colour currently renders as a dot. Promote it to a **left edge rule** on the host's drawer section, and to the accent on that host's settings header. On a phone showing three machines, colour becomes something tracked peripherally rather than read. Reuses the per-host colour already in `hostStore` — no new tokens.

## Testing

- **Message severity** — success and error paths set the correct kind; no code path infers severity from text. A validation failure renders with error styling.
- **Validation** — an empty notify URL is valid when notifications are off and invalid when on; every field's error appears under that field; the outcome area shows only operation results.
- **Numeric inputs** — a field can be cleared and retyped; an empty field blocks Save with a field error rather than silently becoming 0; seconds↔ms conversion round-trips.
- **SSRF guard** — loopback, link-local, and private addresses are rejected by both routes; the env opt-out permits them; the rejection message names the env var; no raw fetch error text reaches the client.
- **Retry delay** — the second attempt happens after the delay, and `send()` still swallows the failure.
- **Type scale** — no hardcoded `fontSize` remains in `ServerSettings.tsx` or `HostsScreen.tsx`.

## Out of scope

- Redesigning the terminal surface, drawer layout, or config screen beyond the host colour rule.
- Migrating all of `styles.ts` to the type scale.
- New fonts, palettes, or motion.
