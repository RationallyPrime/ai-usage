import base64
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from ai_usage.installer import _systemd_quote

EDGE_DIR = Path(__file__).resolve().parent


class InstallerTests(unittest.TestCase):
    def test_systemd_arguments_escape_literal_percent_specifiers(self):
        self.assertEqual(
            _systemd_quote("/tmp/100%/collector"), '"/tmp/100%%/collector"'
        )

    def environment(self, root: Path, provider: str, profile_id: str):
        profile = root / "profiles" / profile_id
        environment = {
            **os.environ,
            "HOME": str(root / "home"),
            "XDG_CONFIG_HOME": str(root / "xdg"),
            "AI_USAGE_INSTALL_ROOT": str(root / "installed"),
            "AI_USAGE_SKIP_SERVICE_START": "1",
            "AI_USAGE_EDGE_ID": "edge-test",
            "AI_USAGE_PROFILE_ID": profile_id,
            "AI_USAGE_PROFILE_LABEL": f"{profile_id} · Test",
            "AI_USAGE_ENDPOINT": "https://collector.example/v3/observations",
            "AI_USAGE_TOKEN": "installer-test-token-not-secret-12345",
            "AI_USAGE_IDENTITY_KEY": base64.b64encode(b"k" * 32).decode("ascii"),
            "AI_USAGE_PROVIDER_BIN": "/usr/bin/true",
            "PYTHON_BIN": sys.executable,
        }
        if provider == "claude":
            environment["CLAUDE_CONFIG_DIR"] = str(profile)
            environment["CLAUDE_SETTINGS_FILE"] = str(profile / "settings.json")
        elif provider == "codex":
            environment["CODEX_HOME"] = str(profile)
        else:
            environment["AI_USAGE_GROK_HOME"] = str(profile)
        return environment

    def run_installer(self, provider: str, environment, *arguments, check=True):
        return subprocess.run(
            [str(EDGE_DIR / f"install-{provider}-collector.sh"), *arguments],
            env=environment,
            text=True,
            capture_output=True,
            check=check,
            timeout=10,
        )

    def test_claude_reinstall_never_nests_and_uninstall_restores_exact_prior_object(
        self,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            environment = self.environment(root, "claude", "desktop-a")
            settings_path = Path(environment["CLAUDE_SETTINGS_FILE"])
            settings_path.parent.mkdir(parents=True)
            prior = {
                "type": "command",
                "command": "old-status --flag 'exact value'",
                "padding": 1,
            }
            settings_path.write_text(
                json.dumps({"theme": "dark", "statusLine": prior}) + "\n"
            )

            self.run_installer("claude", environment)
            first_settings = json.loads(settings_path.read_text())
            config_path = (
                Path(environment["CLAUDE_CONFIG_DIR"]) / "ai-usage" / "config.json"
            )
            manifest_path = config_path.with_name("install-manifest.json")
            manifest = json.loads(manifest_path.read_text())
            self.assertEqual(manifest["prior_status_line"], prior)
            self.assertEqual(
                first_settings["statusLine"], manifest["wrapper_status_line"]
            )
            self.assertEqual(stat.S_IMODE(config_path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(manifest_path.stat().st_mode), 0o600)

            self.run_installer("claude", environment)
            reinstalled = json.loads(manifest_path.read_text())
            self.assertEqual(reinstalled["prior_status_line"], prior)
            self.assertNotIn(
                "ai-usage-v3", json.dumps(reinstalled["prior_status_line"])
            )

            self.run_installer("claude", environment, "--uninstall")
            restored = json.loads(settings_path.read_text())
            self.assertEqual(restored["statusLine"], prior)
            self.assertEqual(restored["theme"], "dark")
            self.assertTrue(
                config_path.exists(), "private config is retained for recoverability"
            )

    def test_uninstall_refuses_to_overwrite_status_line_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            environment = self.environment(root, "claude", "desktop-a")
            settings_path = Path(environment["CLAUDE_SETTINGS_FILE"])
            settings_path.parent.mkdir(parents=True)
            settings_path.write_text("{}\n")
            self.run_installer("claude", environment)
            settings_path.write_text(
                json.dumps(
                    {
                        "statusLine": {
                            "type": "command",
                            "command": "changed-after-install",
                        }
                    }
                )
            )
            completed = self.run_installer(
                "claude", environment, "--uninstall", check=False
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("refusing to overwrite", completed.stderr)
            self.assertEqual(
                json.loads(settings_path.read_text())["statusLine"]["command"],
                "changed-after-install",
            )

    def test_reinstall_recognizes_owned_wrapper_after_root_or_interpreter_change(self):
        for change in ("install-root", "interpreter"):
            with (
                self.subTest(change=change),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                environment = self.environment(root, "claude", "fable-linux")
                settings_path = Path(environment["CLAUDE_SETTINGS_FILE"])
                settings_path.parent.mkdir(parents=True)
                prior = {
                    "type": "command",
                    "command": "original-status --exact 'prior value'",
                    "padding": 2,
                }
                settings_path.write_text(json.dumps({"statusLine": prior}) + "\n")
                self.run_installer("claude", environment)

                config_path = (
                    Path(environment["CLAUDE_CONFIG_DIR"]) / "ai-usage" / "config.json"
                )
                manifest_path = config_path.with_name("install-manifest.json")
                first_manifest = json.loads(manifest_path.read_text())
                old_wrapper = first_manifest["wrapper_status_line"]

                changed = dict(environment)
                if change == "install-root":
                    changed["AI_USAGE_INSTALL_ROOT"] = str(root / "installed-two")
                else:
                    alternate_python = root / "python-alternate"
                    alternate_python.symlink_to(sys.executable)
                    changed["PYTHON_BIN"] = str(alternate_python)

                self.run_installer("claude", changed)
                second_manifest = json.loads(manifest_path.read_text())
                second_settings = json.loads(settings_path.read_text())
                self.assertNotEqual(second_manifest["wrapper_status_line"], old_wrapper)
                self.assertEqual(second_manifest["prior_status_line"], prior)
                self.assertEqual(
                    second_settings["statusLine"],
                    second_manifest["wrapper_status_line"],
                )
                self.assertNotEqual(second_manifest["prior_status_line"], old_wrapper)

                # A further reinstall at the moved command is also idempotent.
                self.run_installer("claude", changed)
                third_manifest = json.loads(manifest_path.read_text())
                self.assertEqual(third_manifest["prior_status_line"], prior)

    def test_two_claude_profiles_have_distinct_private_config_spool_and_manifests(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = []
            for profile_id in ("desktop-a", "desktop-b"):
                environment = self.environment(root, "claude", profile_id)
                settings = Path(environment["CLAUDE_SETTINGS_FILE"])
                settings.parent.mkdir(parents=True)
                settings.write_text("{}\n")
                self.run_installer("claude", environment)
                config = (
                    Path(environment["CLAUDE_CONFIG_DIR"]) / "ai-usage" / "config.json"
                )
                paths.append(config)
            self.assertNotEqual(paths[0], paths[1])
            first, second = (json.loads(path.read_text()) for path in paths)
            self.assertNotEqual(first["profile_id"], second["profile_id"])
            self.assertNotEqual(first["state_dir"], second["state_dir"])

    def test_codex_and_grok_installers_pin_exact_provider_homes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for provider in ("codex", "grok"):
                with self.subTest(provider=provider):
                    environment = self.environment(
                        root, provider, f"{provider}-profile"
                    )
                    self.run_installer(provider, environment)
                    if provider == "codex":
                        profile_home = Path(environment["CODEX_HOME"])
                        config_path = profile_home / "ai-usage" / "config.json"
                    else:
                        profile_home = Path(environment["AI_USAGE_GROK_HOME"])
                        config_path = (
                            profile_home / ".grok" / "ai-usage" / "config.json"
                        )
                    config = json.loads(config_path.read_text())
                    self.assertEqual(
                        config["provider_home"], str(profile_home.resolve())
                    )
                    self.assertEqual(stat.S_IMODE(config_path.stat().st_mode), 0o600)

    def test_reinstall_rejects_profile_id_drift_before_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            environment = self.environment(root, "codex", "codex-old")
            self.run_installer("codex", environment)
            config_path = Path(environment["CODEX_HOME"]) / "ai-usage" / "config.json"
            manifest_path = config_path.with_name("install-manifest.json")
            before_config = config_path.read_bytes()
            before_manifest = manifest_path.read_bytes()

            changed = dict(environment)
            changed["AI_USAGE_PROFILE_ID"] = "codex-new"
            result = self.run_installer("codex", changed, check=False)

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("does not own this provider profile", result.stderr)
            self.assertEqual(config_path.read_bytes(), before_config)
            self.assertEqual(manifest_path.read_bytes(), before_manifest)


@unittest.skipIf(sys.platform == "darwin", "systemd units are written on Linux only")
class SystemdTimerTests(unittest.TestCase):
    """The unit the 2026-09-06 pop-os outage was fought over has had no test.

    Both defective shapes it went through are inert-directive bugs that read as
    fixes, so these assert the contract systemd.timer(5) actually gives, not the
    bytes: a schedule that exists, and catch-up that is defined rather than
    silently ignored.
    """

    def timer_unit(self, profile_id: str) -> str:
        with tempfile.TemporaryDirectory() as temporary:
            installer_tests = InstallerTests()
            environment = installer_tests.environment(
                Path(temporary), "grok", profile_id
            )
            installer_tests.run_installer("grok", environment)
            return (
                Path(environment["XDG_CONFIG_HOME"])
                / "systemd"
                / "user"
                / f"is.sokrates.ai-usage.grok.{profile_id}.timer"
            ).read_text()

    def test_the_collector_timer_schedules_and_catches_up(self):
        content = self.timer_unit("grok-timer")
        directives = dict(
            line.split("=", 1)
            for line in content.splitlines()
            if "=" in line and not line.startswith("#")
        )

        self.assertEqual(directives.get("OnCalendar"), "*:*:00")
        self.assertEqual(directives.get("WantedBy"), "timers.target")
        # Persistent= is documented to have an effect on OnCalendar= timers
        # only. Set beside a purely monotonic schedule it is inert, which is
        # what made the pre-reboot unit look like it would recover and not.
        if "Persistent" in directives:
            self.assertIn(
                "OnCalendar",
                directives,
                "Persistent= without OnCalendar= is silently ignored by systemd",
            )

    def test_the_collector_timer_carries_no_dominated_trigger(self):
        content = self.timer_unit("grok-dominated")
        # OnStartupSec= (user-manager start + 15s) is never earlier than
        # OnBootSec= (boot + 15s), and systemd triggers on the earliest of the
        # configured expressions, so it cannot change when this timer fires.
        # That pairing was the round-1 P1 on this unit.
        self.assertNotIn("OnStartupSec", content)


if __name__ == "__main__":
    unittest.main()
