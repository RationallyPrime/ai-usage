# AI Usage

AI Usage is a native iPhone/macOS app and WidgetKit extension for trustworthy
Claude, Codex, and Grok Build quota telemetry. The presenter has exactly five
manually configured seats: Fable, Gnomon, Theoros, Ariadne, and Talos.

`UsageKit/Sources/UsageKit/UsageRoster.swift` is the presentation topology:
Fable has a dedicated Personal Max 20x on the Pop!_OS laptop; Gnomon and
Theoros share another Personal Max 20x on cx53, observed by Gnomon's collector;
Ariadne uses the Codex cloud profile on cx53; Talos uses SuperGrok Heavy on
cx43. Four subscription readings supply five seat entries. Changes to this
topology are manual code/config updates, never account-discovery guesses.
Retire superseded collector timers and their ingest allow-list entries when
changing the deployment. Keep only Fable, Gnomon, cloud Ariadne, and Talos
enrolled as quota collectors; Theoros displays Gnomon's shared reading.

The Xcode project retains the historical `ClaudeSwifties` product name. The
user-facing app and widget are both named **AI Usage**.

## What schema 3 models

- **Pool:** one quota-bearing provider subject. A shared pool can supply more
  than one named seat entry.
- **Observer profile:** a named local Claude, Codex, or Grok profile that may
  bind to a different pool after a login switch.
- **Edge:** the machine and collector installation delivering observations.
- **Session observation:** one immutable provider reading with its true sample
  time and identity evidence.
- **Binding:** the currently observed profile-to-pool relationship. Several
  profiles may legitimately share one pool.

A pool retains its last good values when no profile is current. Older samples,
out-of-order retries and duplicate delivery cannot replace newer pool truth.
Claude/Codex quota regressions and invalid resets remain guarded. Grok's fresh
credit balance can decrease within a billing period and replaces the older
balance. Contradictory Claude
identity evidence is retained and displayed as a conflict instead of being
used to destructively relabel a pool.

## Architecture

```text
Claude status-line JSON ──▶ local atomic spool ─┐
                                                │
Codex app-server RPC ─────▶ local atomic spool ─┼─▶ profile supervisor
                                                │        │
Grok Build ACP ───────────▶ local atomic spool ─┘        │ per-edge HTTPS
                                                         ▼
                                                schema-3 aggregator
                                                SQLite/WAL projection
                                                         │ read-only HTTPS
                                                         ▼
                                                iOS/macOS app + widget
```

The Claude status-line path performs no network request. A profile-scoped
supervisor drains complete observations oldest-first, retries with bounded
exponential backoff and jitter, and deletes a file only after a 2xx response
acknowledges that exact observation ID. A heartbeat runs at least every five
minutes so the server can distinguish current, recent, and stale profiles.

Provider reads are scoped to the configured profile:

- Claude usage comes from status-line JSON and the OAuth usage endpoint, using
  the profile's CLI-managed access token without refreshing it;
  `claude auth status --json` supplies advisory identity evidence.
- Codex uses `account/read` followed by `account/rateLimits/read` through its
  app-server.
- Grok uses `grok agent --no-leader stdio`, then `initialize`,
  `_x.ai/auth/info`, and `_x.ai/billing` (the x.ai extension methods are
  underscore-prefixed on the wire). It creates no session, sends no prompt,
  invokes no tool, and never calls the bearer-token method.

No collector reads a browser cookie, exports an OAuth/provider bearer, or
calls a private browser endpoint. Provider identifiers are normalized and
HMACed locally with the fleet identity key; raw email/account metadata is not
sent to the aggregator.

## Schema-3 read contract

`GET /v3/usage` returns only the enrolled collectors' latest bound pools.
Historical observations remain in storage but do not add presenter entries:

```json
{
  "schema": 3,
  "generated_at": "2026-08-15T15:31:00Z",
  "pools": [
    {
      "id": "claude-opaque-pool-id",
      "provider": "claude",
      "label": "Claude · Max 20x",
      "identity_state": "verified",
      "status": "ok",
      "sampled_at": "2026-08-15T15:29:58Z",
      "received_at": "2026-08-15T15:30:03Z",
      "windows": [
        {
          "id": "five-hour",
          "label": "5h",
          "duration_minutes": 300,
          "utilization": 0.58,
          "resets_at": "2026-08-15T18:00:00Z"
        }
      ],
      "profiles": [
        {
          "id": "desktop-a",
          "label": "Desktop A",
          "source_host": "workstation",
          "last_seen_at": "2026-08-15T15:30:00Z",
          "state": "current",
          "binding_confidence": "subject"
        }
      ]
    }
  ]
}
```

`utilization` is used capacity from `0...1`. Missing windows or reset times are
absence, never zero. Passing a reset timestamp does not fabricate a zero; the
last sampled number remains visible with its honest age until a valid new
generation arrives.

## Repository layout

| Path | Purpose |
| --- | --- |
| `UsageKit/Sources/UsageKit` | Schema-3 models, freshness, ephemeral HTTP transport, Keychain and App Group storage |
| `UsageKit/Sources/UsageUI` | Pool/profile SwiftUI shared by the app and widget |
| `App/` | Multiplatform host app and per-platform entitlements |
| `Widget/` | Multiplatform WidgetKit extension and per-platform entitlements |
| `edge/ai_usage/` | Python-standard-library contract, providers, spool, supervisor, transport, installer, and doctor |
| `edge/statusline-usage.sh` | Tiny local-only Claude sensor entry point |
| `edge/install-*-collector.sh` | Profile-aware Claude, Codex, and Grok installers/uninstallers |
| `aggregator/` | Bun HTTP service, strict schema, SQLite projection, migration, and generic deployment material |

## Run the aggregator locally

The server requires a separate read bearer plus one token digest and
edge/profile allow-list per collector installation. Keep raw tokens outside the
repository. Derive each ingest digest through stdin so the bearer is not passed
to an external command in argv:

```sh
printf %s "$USAGE_EDGE_TOKEN" | shasum -a 256
```

Then provide the resulting lowercase digest in `EDGE_CREDENTIALS_JSON`:

```sh
cd aggregator
bun install --frozen-lockfile
READ_TOKEN=replace-with-private-read-bearer \
EDGE_CREDENTIALS_JSON='[{"token_sha256":"0000000000000000000000000000000000000000000000000000000000000000","edge_id":"edge-dev","profile_ids":["claude-dev"]}]' \
DATA_DIR=./.data PORT=8099 \
bun run src/index.ts
```

The service exposes public liveness at `/health`; authenticated readiness at
`/ready`; authenticated conflict/readiness diagnostics at `/doctor`;
per-edge ingest at `/v3/observations`; and the read projection at `/v3/usage`.
See [aggregator/README.md](aggregator/README.md) for the full contract and
[aggregator/DEPLOY.md](aggregator/DEPLOY.md) for generic cutover guidance.

## Install a collector profile

All providers share the same private configuration inputs:

- `AI_USAGE_EDGE_ID`: the machine/installation ID allowed by the server;
- `AI_USAGE_PROFILE_ID`: a fleet-unique, stable profile ID;
- `AI_USAGE_PROFILE_LABEL`: the human profile label shown in the UI;
- `AI_USAGE_ENDPOINT`: the HTTPS aggregator origin or exact
  `/v3/observations` URL;
- `AI_USAGE_TOKEN`: this edge's raw ingest bearer;
- `AI_USAGE_IDENTITY_KEY`: the same private base64 HMAC key on every observer
  that must recognize a shared provider subject.

Set the provider profile root as appropriate, then run its installer:

```sh
CLAUDE_CONFIG_DIR=/absolute/path/to/claude-profile \
edge/install-claude-collector.sh
```

```sh
CODEX_HOME=/absolute/path/to/codex-profile \
edge/install-codex-collector.sh
```

```sh
AI_USAGE_GROK_HOME=/absolute/path/to/grok-home \
edge/install-grok-collector.sh
```

The same scripts support `--uninstall`. Claude installation stores the exact
prior `statusLine` object in its private manifest, chains that command with the
same input JSON, avoids recursive wrapping on reinstall, and restores it only
when the live settings still point to this installation. A drifted status line
is never overwritten during uninstall.

The installer prints the private config path. Use it for a redacted local
diagnostic without exposing credentials:

```sh
edge/ai_usage.py doctor --config /absolute/path/to/config.json
```

## Apple secret and presentation behavior

The endpoint and cached snapshot remain in the shared App Group. The read
bearer is stored as a non-synchronizing shared Keychain item using
`AfterFirstUnlockThisDeviceOnly`; the app and widget resolve their access group
from the signed target rather than a hardcoded development-team prefix. On the
first schema-3 launch, a legacy preference token is moved to Keychain and the
preference copy is deleted only after a successful Keychain write/read.

Networking uses an ephemeral URLSession with cookies, URL cache, and shared
credential storage disabled. Token-bearing redirects are accepted only on the
same HTTPS origin. Persisted non-loopback HTTP endpoints are rejected before
the Keychain token is read.

The app and both widget sizes always render the same five roster entries,
including placeholders when a reading is missing. Gnomon and Theoros share
the same quota reading and name each other in their captions. Old pools,
retired hosts, and cached Mac readings cannot create extra rows. Last-good
values, sample age, and reset countdowns remain explicit. The app refreshes
when it becomes active and every minute while open.

## Put it on an iPhone

A native widget must be installed through Xcode/TestFlight/App Store delivery;
hosting an `.app` on a web server is not sufficient.

1. Open `ClaudeSwifties.xcodeproj` and select an Apple development team.
2. Keep the same App Group and Keychain access group capability on the host app
   and widget targets.
3. Select the device, build, and run the `ClaudeSwifties` scheme.
4. In AI Usage, enter the private HTTPS `/v3/usage` URL and read token.
5. Add the **AI usage** medium or large widget.

A compile-only build does not prove cross-process credential access. Before a
production/TestFlight cutover, inspect the signed app and extension
entitlements and prove that both processes can read the same Keychain item.

## Verify

```sh
cd UsageKit && swift test
```

```sh
cd aggregator && bun install --frozen-lockfile && bun test && bun run check
```

```sh
cd edge && python3 -m unittest -v
```

```sh
shellcheck edge/install-*.sh edge/*.sh
```

```sh
xcodebuild -scheme ClaudeSwifties -project ClaudeSwifties.xcodeproj \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

```sh
xcodebuild -scheme ClaudeSwifties -project ClaudeSwifties.xcodeproj \
  -destination 'generic/platform=macOS' CODE_SIGNING_ALLOWED=NO build
```

The commit-pinned GitHub Actions workflow runs those gates, an ad-hoc signed
release-entitlement inspection, and Gitleaks. The separately installed review
loop requests and routes exact-head review feedback; neither green CI nor a
scheduled nudge is itself permission to merge.

## Live deployment verification

Verify four fresh subscription collectors (`fable-linux`, `gnomon-cx53`,
`ariadne-codex-cx53`, and `talos-cx43`) in authenticated feed/doctor readback.
Retire the old Mac, duplicate Linux Grok, and separate Theoros quota timers.
The presenter must show exactly the five roster entries with Gnomon and
Theoros sharing the same values, including on cached/offline snapshots.
Check Grok billing without creating a prompt/session, and install and launch
both the signed app and its embedded widget on the intended iPhone.

Keep live endpoints, hostnames, IP addresses, login targets, deployment paths,
container names, and token-rotation evidence in the private operations corpus,
not this public repository.
