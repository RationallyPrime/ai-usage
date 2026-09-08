"""Profile-safe macOS/Linux installation and lawful Claude restoration."""

from __future__ import annotations

import os
import plistlib
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from .config import CollectorConfig
from .errors import CollectorError
from .spool import ObserverInstance
from .util import (
    atomic_write_bytes,
    atomic_write_json,
    private_directory,
    read_json,
    validate_identifier,
)

PACKAGE_ROOT = Path(__file__).resolve().parent
EDGE_ROOT = PACKAGE_ROOT.parent


def _required(name: str, *fallbacks: str) -> str:
    for key in (name, *fallbacks):
        value = os.environ.get(key)
        if value:
            return value
    raise CollectorError(f"{name} is required")


def _profile_home(provider: str) -> Path:
    home = Path.home()
    if provider == "claude":
        return (
            Path(os.environ.get("CLAUDE_CONFIG_DIR", home / ".claude"))
            .expanduser()
            .resolve()
        )
    if provider == "codex":
        return (
            Path(os.environ.get("CODEX_HOME", home / ".codex")).expanduser().resolve()
        )
    return (
        Path(os.environ.get("AI_USAGE_GROK_HOME", os.environ.get("HOME", str(home))))
        .expanduser()
        .resolve()
    )


def profile_paths(provider: str) -> tuple[Path, Path, Path]:
    provider_home = _profile_home(provider)
    root = provider_home / (".grok/ai-usage" if provider == "grok" else "ai-usage")
    return provider_home, root / "config.json", root / "install-manifest.json"


def _provider_command(provider: str) -> str:
    variable = {"claude": "CLAUDE_BIN", "codex": "CODEX_BIN", "grok": "GROK_BIN"}[
        provider
    ]
    configured = os.environ.get("AI_USAGE_PROVIDER_BIN") or os.environ.get(variable)
    resolved = shutil.which(configured or provider)
    if resolved is None:
        raise CollectorError(f"{provider} was not found; set AI_USAGE_PROVIDER_BIN")
    return str(Path(resolved).resolve())


def _raw_config(provider: str, path: Path, manifest_path: Path) -> dict[str, Any]:
    provider_home, _, _ = profile_paths(provider)
    profile_id = _required("AI_USAGE_PROFILE_ID")
    validate_identifier(profile_id, "AI_USAGE_PROFILE_ID")
    pool_default = {
        "claude": "Claude",
        "codex": "Codex · Account",
        "grok": "Grok · Build",
    }[provider]
    root = path.parent
    return {
        "schema": 1,
        "provider": provider,
        "edge_id": _required("AI_USAGE_EDGE_ID"),
        "profile_id": profile_id,
        "profile_label": _required("AI_USAGE_PROFILE_LABEL", "USAGE_LABEL"),
        "pool_label": os.environ.get("AI_USAGE_POOL_LABEL", pool_default),
        "endpoint": _required("AI_USAGE_ENDPOINT", "USAGE_ENDPOINT"),
        "ingest_token": _required("AI_USAGE_TOKEN", "USAGE_TOKEN"),
        "identity_key": _required("AI_USAGE_IDENTITY_KEY"),
        "provider_home": str(provider_home),
        "provider_command": [_provider_command(provider)],
        "state_dir": str(root / "state"),
        "manifest_path": str(manifest_path),
        "heartbeat_seconds": int(os.environ.get("AI_USAGE_HEARTBEAT_SECONDS", "300")),
        "identity_poll_seconds": int(
            os.environ.get("AI_USAGE_IDENTITY_POLL_SECONDS", "900")
        ),
        "sample_poll_seconds": int(
            os.environ.get("AI_USAGE_SAMPLE_POLL_SECONDS", "300")
        ),
        "request_timeout_seconds": int(
            os.environ.get("AI_USAGE_REQUEST_TIMEOUT_SECONDS", "15")
        ),
        "spool_max_count": int(os.environ.get("AI_USAGE_SPOOL_MAX_COUNT", "512")),
        "spool_max_bytes": int(
            os.environ.get("AI_USAGE_SPOOL_MAX_BYTES", str(4 * 1024 * 1024))
        ),
    }


def _install_code(install_root: Path) -> None:
    private_directory(install_root)
    atomic_write_bytes(
        install_root / "ai_usage.py",
        (EDGE_ROOT / "ai_usage.py").read_bytes(),
        mode=0o700,
    )
    atomic_write_bytes(
        install_root / "statusline-usage.sh",
        (EDGE_ROOT / "statusline-usage.sh").read_bytes(),
        mode=0o700,
    )
    destination_package = private_directory(install_root / "ai_usage")
    for source in PACKAGE_ROOT.glob("*.py"):
        atomic_write_bytes(
            destination_package / source.name, source.read_bytes(), mode=0o600
        )


def _load_settings(path: Path) -> tuple[dict[str, Any], int]:
    try:
        raw = read_json(path, maximum_bytes=1024 * 1024)
        mode = path.stat().st_mode & 0o777
    except FileNotFoundError:
        return {}, 0o600
    if not isinstance(raw, dict):
        raise CollectorError("Claude settings must contain a JSON object")
    return raw, mode or 0o600


def _load_manifest(path: Path) -> dict[str, Any] | None:
    try:
        raw = read_json(path, maximum_bytes=64 * 1024)
    except FileNotFoundError:
        return None
    if not isinstance(raw, dict) or raw.get("schema") != 1:
        raise CollectorError("collector install manifest is invalid")
    return raw


def _service_name(config: CollectorConfig) -> str:
    return f"is.sokrates.ai-usage.{config.provider}.{config.profile_id}"


def _systemd_quote(value: str) -> str:
    return (
        '"' + value.replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"') + '"'
    )


def _service_install(config: CollectorConfig, install_root: Path) -> tuple[str, Path]:
    service_name = _service_name(config)
    arguments = [
        sys.executable,
        str(install_root / "ai_usage.py"),
        "supervise",
        "--config",
        str(config.path),
    ]
    skip_start = os.environ.get("AI_USAGE_SKIP_SERVICE_START") == "1"
    if sys.platform == "darwin":
        destination = Path.home() / "Library" / "LaunchAgents" / f"{service_name}.plist"
        payload = {
            "Label": service_name,
            "ProgramArguments": arguments,
            "RunAtLoad": True,
            "StartInterval": 60,
            "ProcessType": "Background",
            "StandardOutPath": "/dev/null",
            "StandardErrorPath": "/dev/null",
        }
        atomic_write_bytes(
            destination,
            plistlib.dumps(payload, fmt=plistlib.FMT_XML, sort_keys=True),
            mode=0o600,
        )
        if not skip_start:
            domain = f"gui/{os.getuid()}"
            subprocess.run(
                ["launchctl", "bootout", f"{domain}/{service_name}"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            subprocess.run(
                ["launchctl", "bootstrap", domain, str(destination)], check=True
            )
            subprocess.run(
                ["launchctl", "kickstart", "-k", f"{domain}/{service_name}"], check=True
            )
        return "launchd", destination

    unit_root = (
        Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
        / "systemd"
        / "user"
    )
    destination = unit_root / f"{service_name}.service"
    timer = unit_root / f"{service_name}.timer"

    service_content = "\n".join(
        [
            "[Unit]",
            f"Description=AI Usage {config.provider} collector for {config.profile_id}",
            "",
            "[Service]",
            "Type=oneshot",
            "ExecStart=" + " ".join(_systemd_quote(part) for part in arguments),
            "StandardOutput=null",
            "StandardError=null",
            "UMask=0077",
            "",
        ]
    ).encode("utf-8")
    timer_content = "\n".join(
        [
            "[Unit]",
            f"Description=Run AI Usage {config.provider} collector every minute",
            "",
            "[Timer]",
            # One wall-clock elapse point per minute, not a pair of monotonic
            # ones. The monotonic shape (OnBootSec + OnUnitActiveSec) went
            # silent for 34h across the pop-os reboot of 2026-09-06 with the
            # timer ACTIVE and its OnBootSec deadline already in the past, so
            # no further monotonic directive repairs it. A calendar timer has a
            # next elapse point by construction, computed from the wall clock
            # with no boot-relative base and no dependence on the last-trigger
            # stamp; and Persistent= is only defined for OnCalendar= timers
            # (systemd.timer(5)), so here it finally means what it says —
            # catch up one missed run after a suspend or a reboot.
            "OnCalendar=*:*:00",
            "AccuracySec=5s",
            "Persistent=true",
            f"Unit={service_name}.service",
            "",
            "[Install]",
            "WantedBy=timers.target",
            "",
        ]
    ).encode("utf-8")
    atomic_write_bytes(destination, service_content, mode=0o600)
    atomic_write_bytes(timer, timer_content, mode=0o600)
    if not skip_start:
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(
            ["systemctl", "--user", "enable", "--now", f"{service_name}.timer"],
            check=True,
        )
    return "systemd", destination


def _service_uninstall(config: CollectorConfig, manifest: dict[str, Any]) -> None:
    service_name = _service_name(config)
    kind = manifest.get("service_kind")
    service_file_raw = manifest.get("service_file")
    service_file = Path(service_file_raw) if isinstance(service_file_raw, str) else None
    skip_start = os.environ.get("AI_USAGE_SKIP_SERVICE_START") == "1"
    if kind == "launchd":
        if not skip_start:
            subprocess.run(
                ["launchctl", "bootout", f"gui/{os.getuid()}/{service_name}"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        if service_file:
            service_file.unlink(missing_ok=True)
    elif kind == "systemd":
        if not skip_start:
            subprocess.run(
                ["systemctl", "--user", "disable", "--now", f"{service_name}.timer"],
                check=False,
            )
        if service_file:
            service_file.unlink(missing_ok=True)
            service_file.with_suffix(".timer").unlink(missing_ok=True)
        if not skip_start:
            subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)


def install(provider: str) -> dict[str, Any]:
    if provider not in {"claude", "codex", "grok"}:
        raise CollectorError("unsupported provider")
    provider_home, config_path, manifest_path = profile_paths(provider)
    install_root = (
        Path(
            os.environ.get(
                "AI_USAGE_INSTALL_ROOT", Path.home() / ".local/libexec/ai-usage-v3"
            )
        )
        .expanduser()
        .resolve()
    )

    # Validate every input and the existing Claude settings/manifest before
    # the first mutation.
    raw_config = _raw_config(provider, config_path, manifest_path)
    config = CollectorConfig.from_mapping(config_path, raw_config)
    settings = None
    settings_mode = 0o600
    settings_path = None
    prior_present = False
    prior_status_line = None
    wrapper_status_line = None
    existing_manifest = _load_manifest(manifest_path)
    if existing_manifest is not None and (
        existing_manifest.get("provider") != provider
        or existing_manifest.get("config_path") != str(config_path)
        or existing_manifest.get("profile_id") != config.profile_id
    ):
        raise CollectorError(
            "collector install manifest does not own this provider profile"
        )
    if provider == "claude":
        settings_path = (
            Path(
                os.environ.get("CLAUDE_SETTINGS_FILE", provider_home / "settings.json")
            )
            .expanduser()
            .resolve()
        )
        settings, settings_mode = _load_settings(settings_path)
        # Claude launches this on every status render. Invoking the Python
        # entry point directly avoids a second process launch on the path to
        # the 50 ms p95 target; the portable shell entry point remains
        # installed for manual use.
        wrapper_command = f"{shlex.quote(sys.executable)} {shlex.quote(str(install_root / 'ai_usage.py'))} statusline --config {shlex.quote(str(config_path))}"
        wrapper_status_line = {"type": "command", "command": wrapper_command}
        live_status_line = settings.get("statusLine")
        manifest_wrapper = (
            existing_manifest.get("wrapper_status_line")
            if existing_manifest is not None
            else None
        )
        live_is_owned = live_status_line == wrapper_status_line or (
            isinstance(manifest_wrapper, dict) and live_status_line == manifest_wrapper
        )
        if live_is_owned:
            if existing_manifest is None:
                raise CollectorError(
                    "Claude settings point at this wrapper but its restoration manifest is missing or inconsistent"
                )
            prior_present = existing_manifest.get("prior_status_line_present") is True
            prior_status_line = existing_manifest.get("prior_status_line")
        else:
            prior_present = "statusLine" in settings
            prior_status_line = live_status_line

    _install_code(install_root)
    atomic_write_json(config_path, raw_config, mode=0o600)
    # One immutable installation generation per state dir. A reinstall that
    # preserved its state keeps the same instance; a fresh state dir mints a
    # new one, which is what lets the server accept its restarted sequence.
    observer_instance_id = ObserverInstance(config).read_or_create()
    service_kind, service_file = _service_install(config, install_root)
    manifest: dict[str, Any] = {
        "schema": 1,
        "provider": provider,
        "profile_id": config.profile_id,
        "config_path": str(config_path),
        "install_root": str(install_root),
        "service_kind": service_kind,
        "service_file": str(service_file),
    }
    if provider == "claude":
        assert (
            settings is not None
            and settings_path is not None
            and wrapper_status_line is not None
        )
        manifest.update(
            {
                "settings_file": str(settings_path),
                "wrapper_status_line": wrapper_status_line,
                "prior_status_line_present": prior_present,
                "prior_status_line": prior_status_line,
            }
        )
    atomic_write_json(manifest_path, manifest, mode=0o600)
    if provider == "claude":
        settings["statusLine"] = wrapper_status_line
        atomic_write_json(settings_path, settings, mode=settings_mode)
    return {
        "provider": provider,
        "profile_id": config.profile_id,
        "observer_instance_id": observer_instance_id,
        "config": str(config_path),
        "manifest": str(manifest_path),
        "service": str(service_file),
    }


def uninstall(provider: str) -> dict[str, Any]:
    _, config_path, manifest_path = profile_paths(provider)
    config = CollectorConfig.load(config_path)
    manifest = _load_manifest(manifest_path)
    if (
        manifest is None
        or manifest.get("provider") != provider
        or manifest.get("config_path") != str(config_path)
    ):
        raise CollectorError(
            "collector install manifest is missing or does not own this profile"
        )

    settings = None
    settings_path = None
    settings_mode = 0o600
    if provider == "claude":
        raw_settings_path = manifest.get("settings_file")
        if not isinstance(raw_settings_path, str):
            raise CollectorError("Claude restoration manifest has no settings path")
        settings_path = Path(raw_settings_path)
        settings, settings_mode = _load_settings(settings_path)
        expected = manifest.get("wrapper_status_line")
        if settings.get("statusLine") != expected:
            raise CollectorError(
                "Claude statusLine changed after installation; refusing to overwrite it. Restore manually or reinstall to adopt the live value."
            )

    _service_uninstall(config, manifest)
    if provider == "claude":
        assert settings is not None and settings_path is not None
        if manifest.get("prior_status_line_present") is True:
            settings["statusLine"] = manifest.get("prior_status_line")
        else:
            settings.pop("statusLine", None)
        atomic_write_json(settings_path, settings, mode=settings_mode)
    return {
        "provider": provider,
        "profile_id": config.profile_id,
        "restored_status_line": provider == "claude",
        "kept_config": str(config_path),
        "kept_state": str(config.state_dir),
    }
