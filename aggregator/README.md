# usage-aggregator

The schema-3 aggregator stores provider observations durably and projects them
into quota pools and their current observer profiles. A pool is the
quota-bearing provider subject; an edge, profile, session, and pool are never
treated as interchangeable identities.

There is intentionally no permanent schema-1/2 HTTP compatibility surface.
The only old-format path is a one-time `usage.json` import at cutover.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Process liveness only |
| `GET` | `/ready` | read bearer | Commit and roll back a SQLite write probe |
| `GET` | `/doctor` | read bearer | Readiness plus the identity-conflict count |
| `POST` | `/v3/observations` | per-edge bearer | Validate, reconcile, persist, and acknowledge one observation |
| `GET` | `/v3/usage` | read bearer | Return the pool-oriented schema-3 snapshot |

Every response carries `Cache-Control: no-store`. `/health` deliberately says
nothing about credentials, storage, or data readiness. Do not expose `/ready`
as an unauthenticated load-balancer probe.

## Observation contract

Collectors send a strict JSON object. Unknown fields at the top level or in a
window are rejected, so an accidentally added credential or raw provider
response fails closed instead of being stored.

```json
{
  "schema": 3,
  "observation_id": "018f47f0-167a-7cc4-a3d1-d6f5eb04c4f3",
  "sequence": 41,
  "provider": "claude",
  "edge_id": "edge-linux",
  "profile_id": "desktop-a",
  "profile_label": "Desktop A",
  "pool_label": "Claude · Max 20x",
  "session_id": "session-1",
  "source_host": "workstation",
  "collector_version": "3.0.0",
  "provider_client_version": "2.1.0",
  "observed_at": "2026-08-15T15:30:00Z",
  "sampled_at": "2026-08-15T15:29:58Z",
  "sample_time_quality": "transcript_mtime",
  "status": "ok",
  "provider_subject": "<opaque fleet-HMAC digest>",
  "identity_evidence": "org_email",
  "windows": [
    {
      "id": "five-hour",
      "label": "5h",
      "duration_minutes": 300,
      "utilization": 0.58,
      "resets_at": "2026-08-15T18:00:00Z"
    }
  ]
}
```

The success acknowledgement always names the durable observation:

```json
{
  "ok": true,
  "observation_id": "018f47f0-167a-7cc4-a3d1-d6f5eb04c4f3",
  "outcome": "accepted",
  "clock_skewed": false
}
```

`outcome` is `accepted`, `duplicate`, `ignored`, or `conflict`. Every one is a
successful at-least-once delivery acknowledgement; a supervisor may delete the
spooled file only after a 2xx response whose `observation_id` exactly matches.

## Authentication configuration

`READ_TOKEN` is the separate app/widget credential. Ingest uses one credential
per edge. The server stores only SHA-256 token digests in its configuration and
binds each digest to exactly one edge ID plus an allow-list of profile IDs:

```json
[
  {
    "token_sha256": "<64 lowercase hex characters>",
    "edge_id": "edge-linux",
    "profile_ids": ["desktop-a", "build-station-b"]
  },
  {
    "token_sha256": "<another digest>",
    "edge_id": "edge-mac",
    "profile_ids": ["laptop-c"]
  }
]
```

Pass that JSON as `EDGE_CREDENTIALS_JSON`. To derive a digest without placing
the bearer in process arguments:

```sh
printf %s "$USAGE_EDGE_TOKEN" | shasum -a 256 | awk '{print $1}'
```

The service refuses malformed or duplicate digests, empty profile allow-lists,
unsafe IDs, a short read token, and any read token whose digest equals an edge
token digest. Wrong credentials receive one fixed 401 body and are rate
limited by bounded source/role/presented-digest buckets; a shared proxy address
cannot let one invalid token lock out a different valid credential.

## Reconciliation and persistence

`DATA_DIR/usage-v3.sqlite` uses Bun SQLite in WAL mode. Observation acceptance,
the latest per-profile/session record, sequence advancement, pool projection,
bindings, and conflict evidence commit in one `BEGIN IMMEDIATE` transaction.
The database, WAL, and shared-memory
files are created under a `0077` umask and narrowed to mode `0600`; the data
directory is mode `0700`.

The store enforces:

- unique observation IDs and monotonic per-profile sequences;
- older-sample acknowledgement without replacement;
- a default `0.005` same-generation utilization regression tolerance;
- lower values only after a valid reset generation boundary; a newer, account-bound Codex reading may establish an early quota renewal with a later reset boundary before the old window expires;
- five-minute future-clock clamping with an explicit ACK marker;
- exact Claude window-continuity reconciliation when identity evidence is
  stale, with provisional pools rather than destructive guessing;
- current/recent/stale profile states at 15 minutes and 24 hours;
- explicit `billing_unavailable` status while retaining the last good windows.

The schema-3 projection orders Claude, Codex, and Grok pools explicitly and
retains creation order within each provider. It never lexically sorts opaque
pool IDs into presentation order.

## One-time legacy import

When `usage.json` exists beside the database, startup validates and imports its
accounts into provisional schema-3 pools, commits a migration marker, and then
deletes `usage.json`. Corrupt input fails startup visibly.

Set `REQUIRE_LEGACY_IMPORT=true` on the cutover candidate. Startup then fails if
`usage.json` is missing and no completed marker exists. Fresh installations may
leave the flag false. After a successful import, the marker permits ordinary
restarts even though the importer input has been removed.

## Runtime configuration

| Variable | Default | Bound |
| --- | ---: | --- |
| `PORT` | `8080` | integer `1..65535` |
| `DATA_DIR` | `/data` | non-empty control-free path |
| `MAX_POOLS` | `64` | integer `1..1000` |
| `MAX_FUTURE_SKEW_SECONDS` | `300` | number `0..3600` |
| `RESET_SKEW_SECONDS` | `300` | number `0..3600` |
| `UTILIZATION_REGRESSION_TOLERANCE` | `0.005` | number `0..0.1` |
| `INVALID_AUTH_MAX_ATTEMPTS` | `20` | integer `1..1000` |
| `INVALID_AUTH_WINDOW_SECONDS` | `60` | integer `1..3600` |
| `REQUIRE_LEGACY_IMPORT` | `false` | `true/false/1/0` |

`READ_TOKEN` and `EDGE_CREDENTIALS_JSON` are mandatory.

## HTTP boundary

Ingest requires `Content-Type: application/json`, rejects compressed bodies,
and reads request streams incrementally. The reader cancels once actual UTF-8
bytes exceed 8 KiB; it does not use `String.length` or buffer an unbounded
chunked request. Identifiers, labels, hosts, and versions are bounded and
control characters are rejected before anything reaches logs or storage.

## Local verification

```sh
bun install --frozen-lockfile
bun test
bun run check
```

For a local process, set a test read token and `EDGE_CREDENTIALS_JSON` with the
SHA-256 digest of a separate test ingest token. Never commit either bearer.
