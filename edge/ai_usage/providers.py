"""Provider adapters for Claude, Codex, and Grok Build.

Codex and Grok are credential-free: quota and identity arrive through the
provider's own CLI in a supported request sequence. Claude has no headless
usage command — quota windows reach an interactive session's status line and
nowhere else — so its sample lane polls the OAuth usage endpoint with the
access token the CLI already stores in the profile. That is the one deliberate
exception to credential-freedom: read-only, same seat, sent only to the API
that issued it, and the refresh token is never touched (refreshing behind the
CLI's back would race its rotation and could log the seat out).
"""

from __future__ import annotations

import json
import math
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .config import CollectorConfig
from .contract import COLLECTOR_VERSION, QuotaWindow
from .errors import AuthenticationRequired, CollectorError, ProviderError
from .identity import IdentityHint, claude_identity, codex_identity, grok_identity
from .rpc import JsonLineProcess
from .util import display_text, epoch_timestamp, isoformat, parse_timestamp


def duration_label(minutes: int | None) -> str:
    if minutes is None:
        return "Limit"
    if minutes == 10_080:
        return "7d"
    if minutes % 1_440 == 0:
        return f"{minutes // 1_440}d"
    if minutes % 60 == 0:
        return f"{minutes // 60}h"
    return f"{minutes}m"


def poll_claude_identity(config: CollectorConfig) -> IdentityHint:
    command = [*config.provider_command, "auth", "status", "--json"]
    try:
        completed = subprocess.run(
            command,
            env=config.provider_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=config.request_timeout_seconds,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ProviderError("Claude auth status could not be executed") from error
    if completed.returncode != 0:
        raise AuthenticationRequired("Claude auth status requires authentication")
    if len(completed.stdout) > 64 * 1024:
        raise ProviderError("Claude auth status returned oversized JSON")
    try:
        raw = json.loads(completed.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProviderError("Claude auth status returned malformed JSON") from error
    if not isinstance(raw, dict):
        raise ProviderError("Claude auth status returned no object")
    if raw.get("loggedIn") is False or raw.get("authenticated") is False:
        raise AuthenticationRequired("Claude profile is not authenticated")
    return claude_identity(raw, config.identity_key)


CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_USAGE_BETA_HEADER = "oauth-2025-04-20"
_CLAUDE_USAGE_LIMIT_BYTES = 256 * 1024


def load_claude_access_token(config: CollectorConfig) -> str:
    """Read the profile's stored OAuth access token, refusing expired ones.

    Only ``claudeAiOauth.accessToken`` is read. An expired token is
    ``AuthenticationRequired`` rather than a refresh attempt: the CLI owns the
    refresh token and its rotation, and the token becomes fresh again the next
    time the seat runs.
    """
    path = config.provider_home / ".credentials.json"
    try:
        if path.stat().st_size > 64 * 1024:
            raise ProviderError("Claude credentials file is oversized")
        raw = json.loads(path.read_text())
    except FileNotFoundError as error:
        raise AuthenticationRequired("Claude profile holds no credentials") from error
    except OSError as error:
        raise ProviderError("Claude credentials could not be read") from error
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProviderError("Claude credentials are malformed") from error
    oauth = raw.get("claudeAiOauth") if isinstance(raw, dict) else None
    token = oauth.get("accessToken") if isinstance(oauth, dict) else None
    if not isinstance(token, str) or not token.strip():
        raise AuthenticationRequired("Claude profile holds no access token")
    expires_at = oauth.get("expiresAt")
    if (
        not isinstance(expires_at, bool)
        and isinstance(expires_at, (int, float))
        and expires_at <= time.time() * 1000
    ):
        raise AuthenticationRequired("Claude access token is expired")
    return token


def claude_usage_windows(payload: dict[str, Any]) -> list[QuotaWindow]:
    windows: list[QuotaWindow] = []
    for key, identifier, label, duration in (
        ("five_hour", "five-hour", "5h", 300),
        ("seven_day", "seven-day", "7d", 10_080),
    ):
        raw = payload.get(key)
        if raw is None:
            continue
        if not isinstance(raw, dict):
            raise ProviderError(f"Claude {key} window is malformed")
        used = raw.get("utilization")
        if (
            isinstance(used, bool)
            or not isinstance(used, (int, float))
            or not math.isfinite(float(used))
            or not 0 <= used <= 100
        ):
            raise ProviderError(f"Claude {key} utilization is invalid")
        resets = raw.get("resets_at")
        reset_at = (
            isoformat(parse_timestamp(resets, f"Claude {key}.resets_at"))
            if resets is not None
            else None
        )
        windows.append(
            QuotaWindow(identifier, label, duration, float(used) / 100, reset_at)
        )
    return windows


def read_claude(
    config: CollectorConfig,
    *,
    opener: Callable[[urllib.request.Request, float], Any] | None = None,
) -> ProviderReading:
    identity = poll_claude_identity(config)
    token = load_claude_access_token(config)
    request = urllib.request.Request(  # noqa: S310 — scheme is pinned https
        CLAUDE_USAGE_ENDPOINT,
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": CLAUDE_USAGE_BETA_HEADER,
            "User-Agent": f"ai-usage-collector/{COLLECTOR_VERSION}",
        },
        method="GET",
    )
    open_request = opener or (
        lambda req, timeout: urllib.request.urlopen(req, timeout=timeout)  # noqa: S310
    )
    try:
        with open_request(request, config.request_timeout_seconds) as response:
            body = response.read(_CLAUDE_USAGE_LIMIT_BYTES + 1)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise AuthenticationRequired(
                "Claude usage endpoint refused the access token"
            ) from error
        raise ProviderError(
            f"Claude usage endpoint returned HTTP {error.code}"
        ) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ProviderError("Claude usage endpoint is unreachable") from error
    if len(body) > _CLAUDE_USAGE_LIMIT_BYTES:
        raise ProviderError("Claude usage endpoint returned an oversized document")
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProviderError("Claude usage endpoint returned malformed JSON") from error
    if not isinstance(payload, dict):
        raise ProviderError("Claude usage endpoint returned no object")
    windows = claude_usage_windows(payload)
    return ProviderReading(
        identity,
        windows,
        "ok" if windows else "billing_unavailable",
        config.pool_label,
    )


def select_codex_snapshot(result: dict[str, Any]) -> dict[str, Any]:
    buckets = result.get("rateLimitsByLimitId")
    if isinstance(buckets, dict):
        direct = buckets.get("codex")
        if isinstance(direct, dict):
            return direct
        for value in buckets.values():
            if isinstance(value, dict) and value.get("limitId") == "codex":
                return value
    fallback = result.get("rateLimits")
    if isinstance(fallback, dict) and fallback.get("limitId") in (None, "codex"):
        return fallback
    raise ProviderError("Codex returned no general rate-limit bucket")


def codex_windows(snapshot: dict[str, Any]) -> list[QuotaWindow]:
    windows: list[QuotaWindow] = []
    for slot in ("primary", "secondary"):
        raw = snapshot.get(slot)
        if raw is None:
            continue
        if not isinstance(raw, dict):
            raise ProviderError(f"Codex {slot} window is malformed")
        used = raw.get("usedPercent")
        if (
            isinstance(used, bool)
            or not isinstance(used, (int, float))
            or not math.isfinite(float(used))
            or not 0 <= used <= 100
        ):
            raise ProviderError(f"Codex {slot} utilization is invalid")
        duration = raw.get("windowDurationMins")
        if duration is not None and (
            isinstance(duration, bool) or not isinstance(duration, int) or duration < 1
        ):
            raise ProviderError(f"Codex {slot} duration is invalid")
        reset_at = epoch_timestamp(raw.get("resetsAt"), f"Codex {slot}.resetsAt")
        identifier = (
            "five-hour"
            if duration == 300
            else "seven-day"
            if duration == 10_080
            else f"{slot}-{duration or 'unknown'}"
        )
        windows.append(
            QuotaWindow(
                identifier,
                duration_label(duration),
                duration,
                float(used) / 100,
                reset_at,
            )
        )
    return windows


@dataclass(frozen=True)
class ProviderReading:
    identity: IdentityHint
    windows: list[QuotaWindow]
    status: str
    pool_label: str
    provider_client_version: str | None = None


def read_codex(config: CollectorConfig) -> ProviderReading:
    command = [*config.provider_command, "app-server", "--stdio"]
    with JsonLineProcess(
        command,
        environment=config.provider_environment(),
        timeout=config.request_timeout_seconds,
        jsonrpc=False,
    ) as process:
        process.request(
            "initialize",
            {
                "clientInfo": {
                    "name": "ai-usage-collector",
                    "version": COLLECTOR_VERSION,
                },
                "capabilities": {},
            },
        )
        process.notify("initialized")
        # The current account/read schema requires an explicit empty params
        # object. Send the same schema-shaped object to both account methods.
        account = process.request("account/read", {})
        limits = process.request("account/rateLimits/read", {})
    identity = codex_identity(account, config.identity_key)
    snapshot = select_codex_snapshot(limits)
    windows = codex_windows(snapshot)
    plan = snapshot.get("planType")
    if not isinstance(plan, str):
        account_value = (
            account.get("account")
            if isinstance(account.get("account"), dict)
            else account
        )
        plan = (
            account_value.get("planType")
            if isinstance(account_value.get("planType"), str)
            else None
        )
    suffix = (
        display_text(plan.replace("_", " ").title(), "Account", 50)
        if plan
        else "Account"
    )
    return ProviderReading(
        identity, windows, "ok" if windows else "error", f"Codex · {suffix}"
    )


def _cent_value(value: Any) -> float | None:
    if isinstance(value, dict):
        # Grok's proto3 Cent omits a zero-valued scalar ({} means zero).
        value = value.get("val", 0)
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(float(value))
    ):
        return None
    return float(value)


def _grok_period(config: dict[str, Any]) -> tuple[str, str, int | None, str | None]:
    period = config.get("currentPeriod")
    if isinstance(period, dict):
        period_type = period.get("type") if isinstance(period.get("type"), str) else ""
        start_raw = period.get("start")
        end_raw = period.get("end")
    else:
        period_type = "USAGE_PERIOD_TYPE_MONTHLY"
        start_raw = config.get("billingPeriodStart")
        end_raw = config.get("billingPeriodEnd")
    reset_at = None
    start = end = None
    try:
        if isinstance(end_raw, str):
            end = parse_timestamp(end_raw, "Grok currentPeriod.end")
            reset_at = isoformat(end)
        if isinstance(start_raw, str):
            start = parse_timestamp(start_raw, "Grok currentPeriod.start")
    except CollectorError:
        start = end = None
        reset_at = None
    duration = None
    if start is not None and end is not None and end > start:
        duration = max(1, round((end - start).total_seconds() / 60))
    lower = period_type.casefold()
    if "week" in lower:
        return "weekly", "7d", duration or 10_080, reset_at
    if "month" in lower:
        return "monthly", "30d", duration or 43_200, reset_at
    return "billing-period", duration_label(duration), duration, reset_at


def grok_reading(
    auth_info: dict[str, Any], billing: dict[str, Any], identity_key: bytes
) -> ProviderReading:
    identity = grok_identity(auth_info, identity_key)
    raw_config = billing.get("config")
    if not isinstance(raw_config, dict):
        return ProviderReading(identity, [], "billing_unavailable", "Grok · Build")
    percentage = raw_config.get("creditUsagePercent")
    utilization = None
    if (
        isinstance(percentage, (int, float))
        and not isinstance(percentage, bool)
        and math.isfinite(float(percentage))
        and percentage >= 0
    ):
        utilization = min(1.0, float(percentage) / 100)
    elif percentage is None:
        limit = _cent_value(raw_config.get("monthlyLimit"))
        used = _cent_value(raw_config.get("used"))
        if limit is not None and used is not None and limit > 0 and used >= 0:
            utilization = min(1.0, used / limit)
    identifier, label, duration, resets_at = _grok_period(raw_config)
    windows = (
        [QuotaWindow(identifier, label, duration, utilization, resets_at)]
        if utilization is not None
        else []
    )
    tier = billing.get("subscriptionTier")
    if not isinstance(tier, str):
        tier = billing.get("subscription_tier")
    pool_label = (
        f"Grok · {display_text(tier, 'Build', 60)}"
        if isinstance(tier, str) and tier.strip()
        else "Grok · Build"
    )
    return ProviderReading(
        identity, windows, "ok" if windows else "billing_unavailable", pool_label
    )


def read_grok(config: CollectorConfig) -> ProviderReading:
    # This exact sequence intentionally creates no session, sends no prompt,
    # invokes no tool, and never calls the bearer-token method. The x.ai
    # extension methods are underscore-prefixed on the wire (ACP extension
    # convention, verified against grok 1.0.13); the bare names answer
    # JSON-RPC -32601.
    command = [*config.provider_command, "agent", "--no-leader", "stdio"]
    with JsonLineProcess(
        command,
        environment=config.provider_environment(),
        timeout=config.request_timeout_seconds,
        jsonrpc=True,
    ) as process:
        initialized = process.request(
            "initialize", {"protocolVersion": 1, "clientCapabilities": {}}
        )
        auth_info = process.request("_x.ai/auth/info", {})
        try:
            billing = process.request("_x.ai/billing", {})
        except AuthenticationRequired:
            raise
        except ProviderError:
            return ProviderReading(
                grok_identity(auth_info, config.identity_key),
                [],
                "billing_unavailable",
                "Grok · Build",
                provider_client_version=None,
            )
    reading = grok_reading(auth_info, billing, config.identity_key)
    agent_info = initialized.get("agentInfo")
    version = (
        agent_info.get("version")
        if isinstance(agent_info, dict) and isinstance(agent_info.get("version"), str)
        else None
    )
    return ProviderReading(
        reading.identity,
        reading.windows,
        reading.status,
        reading.pool_label,
        provider_client_version=version,
    )


def collect_provider(config: CollectorConfig) -> ProviderReading:
    if config.provider == "codex":
        return read_codex(config)
    if config.provider == "grok":
        return read_grok(config)
    return read_claude(config)
