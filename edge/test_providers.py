import json
import sys
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path

from ai_usage.errors import AuthenticationRequired, ProviderError
from ai_usage.providers import (
    CLAUDE_USAGE_BETA_HEADER,
    CLAUDE_USAGE_ENDPOINT,
    claude_usage_windows,
    grok_reading,
    load_claude_access_token,
    poll_claude_identity,
    read_claude,
    read_codex,
    read_grok,
)
from test_support import make_config, write_executable

FIXTURES = Path(__file__).with_name("fixtures")

CODEX_SERVER = r"""#!/usr/bin/env python3
import json, pathlib, sys
log = pathlib.Path(%r)
account_fixture = pathlib.Path(%r)
limits_fixture = pathlib.Path(%r)
for line in sys.stdin:
    message = json.loads(line)
    with log.open("a") as handle:
        handle.write(message["method"] + "\n")
    if "id" not in message:
        continue
    if message["method"] == "initialize":
        result = {}
    elif message["method"] == "account/read" and message.get("params") == {}:
        result = json.loads(account_fixture.read_text())
    elif message["method"] == "account/rateLimits/read" and message.get("params") == {}:
        result = json.loads(limits_fixture.read_text())
    else:
        print(json.dumps({"id": message["id"], "error": {"code": -32602, "message": "invalid params"}}), flush=True)
        continue
    print(json.dumps({"id": message["id"], "result": result}), flush=True)
"""


GROK_SERVER = r"""#!/usr/bin/env python3
import json, pathlib, sys
log = pathlib.Path(%r)
auth_fixture = pathlib.Path(%r)
billing_fixture = pathlib.Path(%r)
for line in sys.stdin:
    message = json.loads(line)
    with log.open("a") as handle:
        handle.write(message["method"] + "\n")
    method = message["method"]
    if method == "initialize":
        result = {"agentInfo": {"version": "0.2.0"}}
    elif method == "_x.ai/auth/info":
        result = json.loads(auth_fixture.read_text())
    elif method == "_x.ai/billing":
        result = json.loads(billing_fixture.read_text())
    else:
        print(json.dumps({"id": message["id"], "error": {"code": -32601, "message": "forbidden"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
"""


class CodexProviderTests(unittest.TestCase):
    def test_account_read_precedes_rate_limits_and_secondary_absence_is_not_zero(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            log = root / "methods.log"
            server = write_executable(
                root / "codex-server.py",
                CODEX_SERVER
                % (
                    str(log),
                    str(FIXTURES / "codex-account-read.sanitized.json"),
                    str(FIXTURES / "codex-rate-limits-read.sanitized.json"),
                ),
            )
            config = make_config(
                root, "codex", provider_command=[sys.executable, str(server)]
            )
            reading = read_codex(config)
            self.assertEqual(
                log.read_text().splitlines(),
                [
                    "initialize",
                    "initialized",
                    "account/read",
                    "account/rateLimits/read",
                ],
            )
            # Current account/read exposes a sanitized chatgpt account with an
            # email fallback, not invented account/workspace ID fields.
            self.assertEqual(reading.identity.evidence, "email")
            self.assertEqual(len(reading.windows), 1)
            self.assertEqual(reading.windows[0].label, "7d")
            self.assertEqual(reading.windows[0].utilization, 0.45)
            self.assertEqual(reading.pool_label, "Codex · Pro")
            self.assertNotIn("profile@example.test", reading.identity.digest)


class ClaudeProviderTests(unittest.TestCase):
    def test_auth_status_runs_in_exact_profile_environment_and_persists_only_digest(
        self,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            captured = root / "profile.txt"
            script = write_executable(
                root / "claude.py",
                "#!/usr/bin/env python3\n"
                "import json, os, pathlib\n"
                f"pathlib.Path({str(captured)!r}).write_text(os.environ.get('CLAUDE_CONFIG_DIR',''))\n"
                f"print(pathlib.Path({str(FIXTURES / 'claude-auth-status.sanitized.json')!r}).read_text())\n",
            )
            config = make_config(
                root, "claude", provider_command=[sys.executable, str(script)]
            )
            identity = poll_claude_identity(config)
            self.assertEqual(captured.read_text(), str(config.provider_home))
            self.assertEqual(identity.evidence, "org_email")
            self.assertNotIn("profile", identity.digest)


class GrokProviderTests(unittest.TestCase):
    def test_fake_acp_proves_initialize_auth_billing_order_and_no_model_turn(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            log = root / "methods.log"
            server = write_executable(
                root / "grok-server.py",
                GROK_SERVER
                % (
                    str(log),
                    str(FIXTURES / "grok-auth-info.sanitized.json"),
                    str(FIXTURES / "grok-billing.sanitized.json"),
                ),
            )
            config = make_config(
                root, "grok", provider_command=[sys.executable, str(server)]
            )
            reading = read_grok(config)
            methods = log.read_text().splitlines()
            self.assertEqual(methods, ["initialize", "_x.ai/auth/info", "_x.ai/billing"])
            forbidden = ("getBearerToken", "session", "prompt", "tool")
            self.assertFalse(
                any(any(word in method for word in forbidden) for method in methods)
            )
            self.assertEqual(reading.identity.evidence, "principal_id")
            self.assertEqual(reading.status, "ok")
            self.assertEqual(reading.windows[0].id, "weekly")
            self.assertEqual(reading.windows[0].duration_minutes, 10080)
            self.assertEqual(reading.windows[0].utilization, 0.375)
            self.assertEqual(reading.pool_label, "Grok · SuperGrok Heavy")
            self.assertEqual(reading.provider_client_version, "0.2.0")

    def test_legacy_monthly_fallback_does_not_infer_missing_values_as_zero(self):
        key = b"k" * 32
        legacy = grok_reading(
            {"teamId": "team"},
            {
                "config": {
                    "monthlyLimit": {"val": 10000},
                    "used": {"val": 2500},
                    "billingPeriodStart": "2026-08-01T00:00:00Z",
                    "billingPeriodEnd": "2026-09-01T00:00:00Z",
                }
            },
            key,
        )
        self.assertEqual(legacy.status, "ok")
        self.assertEqual(legacy.windows[0].utilization, 0.25)
        absent = grok_reading(
            {"teamId": "team"}, {"config": {"monthlyLimit": {"val": 10000}}}, key
        )
        self.assertEqual(absent.status, "billing_unavailable")
        self.assertEqual(absent.windows, [])

    def test_grok_proto_zero_and_over_limit_match_upstream_billing_semantics(self):
        zero = grok_reading({"teamId": "team"}, {"config": {
            "monthlyLimit": {"val": 10000}, "used": {}
        }}, b"k" * 32)
        self.assertEqual(zero.status, "ok")
        self.assertEqual(zero.windows[0].utilization, 0)
        over = grok_reading({"teamId": "team"}, {
            "subscription_tier": "SuperGrok Heavy",
            "config": {"creditUsagePercent": 150}
        }, b"k" * 32)
        self.assertEqual(over.windows[0].utilization, 1)
        self.assertEqual(over.pool_label, "Grok · SuperGrok Heavy")

    def test_preferred_monthly_current_period_uses_its_exact_boundaries(self):
        reading = grok_reading(
            {"organizationId": "org"},
            {
                "subscriptionTier": "SuperGrok",
                "config": {
                    "creditUsagePercent": 62,
                    "currentPeriod": {
                        "type": "USAGE_PERIOD_TYPE_MONTHLY",
                        "start": "2026-08-01T00:00:00Z",
                        "end": "2026-09-01T00:00:00Z",
                    },
                },
            },
            b"k" * 32,
        )
        self.assertEqual(reading.windows[0].id, "monthly")
        self.assertEqual(reading.windows[0].duration_minutes, 44_640)
        self.assertEqual(reading.windows[0].resets_at, "2026-09-01T00:00:00Z")
        self.assertEqual(reading.windows[0].utilization, 0.62)

    def test_auth_required_is_explicit_and_process_exits_without_session(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            server = write_executable(
                root / "auth-required.py",
                r"""#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    message = json.loads(line)
    if message["method"] == "initialize": result = {}
    elif message["method"] == "_x.ai/auth/info": result = {"email": "private@example.test"}
    else:
        print(json.dumps({"jsonrpc":"2.0","id":message["id"],"error":{"code":401,"message":"Authentication required; run grok login"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc":"2.0","id":message["id"],"result":result}), flush=True)
""",
            )
            config = make_config(
                root, "grok", provider_command=[sys.executable, str(server)]
            )
            with self.assertRaises(AuthenticationRequired):
                read_grok(config)

    def test_malformed_json_terminalizes_as_provider_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            server = write_executable(
                root / "malformed.py",
                "#!/usr/bin/env python3\nimport sys\nsys.stdin.readline()\nprint('not-json', flush=True)\n",
            )
            config = make_config(
                root, "grok", provider_command=[sys.executable, str(server)]
            )
            with self.assertRaises(ProviderError):
                read_grok(config)

    def test_hard_timeout_terminates_a_stalled_acp_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            server = write_executable(
                root / "stall.py",
                "#!/usr/bin/env python3\nimport sys, time\nsys.stdin.readline()\ntime.sleep(30)\n",
            )
            config = make_config(
                root,
                "grok",
                provider_command=[sys.executable, str(server)],
                request_timeout_seconds=1,
            )
            started = time.monotonic()
            with self.assertRaises(ProviderError):
                read_grok(config)
            self.assertLess(time.monotonic() - started, 4)

    def test_clean_early_process_exit_is_distinct_from_malformed_json(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            server = write_executable(
                root / "exit.py",
                "#!/usr/bin/env python3\nimport sys\nsys.stdin.readline()\nraise SystemExit(0)\n",
            )
            config = make_config(
                root, "grok", provider_command=[sys.executable, str(server)]
            )
            with self.assertRaisesRegex(ProviderError, "exited before responding"):
                read_grok(config)


class _FakeUsageResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self, limit: int = -1) -> bytes:
        return self._body[:limit] if limit and limit > 0 else self._body

    def __enter__(self) -> "_FakeUsageResponse":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


class ClaudeUsageLaneTests(unittest.TestCase):
    """The headless sample lane: OAuth usage poll with the CLI's stored token.

    Claude quota previously reached the collector only through the interactive
    status-line sensor, so wake-driven headless seats never produced a pool
    sample and their pools sat permanently stale on the widget. These pin the
    polling lane that closed that gap.
    """

    USAGE_DOCUMENT = {
        "five_hour": {
            "utilization": 8.0,
            "resets_at": "2026-08-17T00:49:59.739253+00:00",
        },
        "seven_day": {
            "utilization": 34.0,
            "resets_at": "2026-08-22T17:59:59.739273+00:00",
        },
        "seven_day_opus": None,
        "extra_usage": {"is_enabled": False},
    }

    def _auth_command(self, root: Path) -> list[str]:
        script = write_executable(
            root / "claude.py",
            "#!/usr/bin/env python3\n"
            "import pathlib\n"
            f"print(pathlib.Path({str(FIXTURES / 'claude-auth-status.sanitized.json')!r}).read_text())\n",
        )
        return [sys.executable, str(script)]

    def _write_credentials(
        self,
        config,
        *,
        token: str = "sk-test-access-token",
        expires_in_ms: float = 3_600_000,
    ) -> None:
        config.provider_home.mkdir(parents=True, exist_ok=True)
        (config.provider_home / ".credentials.json").write_text(
            json.dumps(
                {
                    "claudeAiOauth": {
                        "accessToken": token,
                        "refreshToken": "sk-test-refresh-token",
                        "expiresAt": time.time() * 1000 + expires_in_ms,
                    }
                }
            )
        )

    def test_missing_or_empty_credentials_are_authentication_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = make_config(root, "claude")
            with self.assertRaisesRegex(AuthenticationRequired, "no credentials"):
                load_claude_access_token(config)
            config.provider_home.mkdir(parents=True, exist_ok=True)
            (config.provider_home / ".credentials.json").write_text(
                json.dumps({"claudeAiOauth": {}})
            )
            with self.assertRaisesRegex(AuthenticationRequired, "no access token"):
                load_claude_access_token(config)

    def test_expired_token_is_refused_not_refreshed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = make_config(root, "claude")
            self._write_credentials(config, expires_in_ms=-1_000)
            with self.assertRaisesRegex(AuthenticationRequired, "expired"):
                load_claude_access_token(config)

    def test_usage_windows_map_percent_to_fraction_and_keep_resets(self):
        windows = claude_usage_windows(self.USAGE_DOCUMENT)
        self.assertEqual(
            [(w.id, w.label, w.duration_minutes) for w in windows],
            [("five-hour", "5h", 300), ("seven-day", "7d", 10_080)],
        )
        self.assertAlmostEqual(windows[0].utilization, 0.08)
        self.assertAlmostEqual(windows[1].utilization, 0.34)
        self.assertEqual(windows[0].resets_at, "2026-08-17T00:49:59Z")

    def test_invalid_utilization_terminalizes_as_provider_error(self):
        for bad in ("high", 150, float("nan"), True):
            with self.assertRaises(ProviderError):
                claude_usage_windows({"five_hour": {"utilization": bad}})

    def test_read_claude_sends_stored_token_and_beta_header(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = make_config(
                root, "claude", provider_command=self._auth_command(root)
            )
            self._write_credentials(config, token="sk-test-access-token")
            seen: dict[str, object] = {}

            def opener(request, timeout):
                seen["url"] = request.full_url
                seen["authorization"] = request.get_header("Authorization")
                seen["beta"] = request.get_header("Anthropic-beta")
                seen["timeout"] = timeout
                return _FakeUsageResponse(json.dumps(self.USAGE_DOCUMENT).encode())

            reading = read_claude(config, opener=opener)
            self.assertEqual(seen["url"], CLAUDE_USAGE_ENDPOINT)
            self.assertEqual(seen["authorization"], "Bearer sk-test-access-token")
            self.assertEqual(seen["beta"], CLAUDE_USAGE_BETA_HEADER)
            self.assertEqual(reading.status, "ok")
            self.assertEqual(len(reading.windows), 2)
            self.assertEqual(reading.pool_label, config.pool_label)

    def test_unauthorized_poll_is_authentication_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = make_config(
                root, "claude", provider_command=self._auth_command(root)
            )
            self._write_credentials(config)

            def opener(request, timeout):
                raise urllib.error.HTTPError(
                    request.full_url, 401, "unauthorized", None, None
                )

            with self.assertRaisesRegex(AuthenticationRequired, "refused"):
                read_claude(config, opener=opener)

    def test_windowless_document_reports_billing_unavailable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = make_config(
                root, "claude", provider_command=self._auth_command(root)
            )
            self._write_credentials(config)

            def opener(request, timeout):
                return _FakeUsageResponse(b'{"extra_usage": {"is_enabled": false}}')

            reading = read_claude(config, opener=opener)
            self.assertEqual(reading.status, "billing_unavailable")
            self.assertEqual(reading.windows, [])


if __name__ == "__main__":
    unittest.main()
