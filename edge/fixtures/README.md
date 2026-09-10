# Sanitized provider fixtures

The Codex fixtures preserve the response structure captured from
`codex app-server` 0.147.0 on 2026-08-15 and agree with its locally generated
`GetAccountResponse` and `GetAccountRateLimitsResponse` schemas. The Claude
auth fixture preserves the keys captured from `claude auth status --json`
2.1.220 on the same date; its status-line fixture is the repository's sanitized
contract specimen. Grok fixtures preserve the `_x.ai/auth/info` and
`_x.ai/billing` shapes, verified against Talos's Grok 1.0.13 and the 1.0.25 candidate on 2026-09-10 and
the upstream source at `37949780c144e37df692e3d669051a21fec24f20`.
The billing config uses camelCase; the top-level tier is `subscription_tier`.
Proto3 `Cent {}` means zero; percentages above 100 are clamped like the CLI.
The default Grok process budget is 30 seconds because billing's own upstream
HTTP timeout is 15 seconds, in addition to CLI startup and authentication.

Identifying strings, balances, percentages, and timestamps are synthetic. The
files contain no provider credential or live account identifier. Real provider
smoke tests remain an explicit terminal gate rather than a claim made by these
fixtures.
