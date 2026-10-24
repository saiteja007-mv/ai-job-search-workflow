#!/usr/bin/env python3
"""Tiny dry-run tests for bin/run-job (no real hermes send)."""
import subprocess
import sys
import unittest
from pathlib import Path

RUN_JOB = Path(__file__).resolve().parent.parent / "bin" / "run-job"


def run_job(*args, env_extra=None):
    env = {"PATH": "/usr/bin:/bin", "RUN_JOB_DRY_RUN": "1"}
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [str(RUN_JOB), *args], capture_output=True, text=True, timeout=30, env=env,
    )


class TestRunJobDryRun(unittest.TestCase):
    def test_success_with_output_sends_stdout(self):
        p = run_job("demo-job", "slack:CTEST", "--", "printf", "hello world\n")
        self.assertEqual(p.returncode, 0)
        self.assertIn("DRY RUN: would send to slack:CTEST", p.stdout)
        self.assertIn("hello world", p.stdout)

    def test_success_empty_stdout_sends_nothing(self):
        p = run_job("demo-job", "slack:CTEST", "--", "true")
        self.assertEqual(p.returncode, 0)
        self.assertNotIn("DRY RUN: would send", p.stdout)

    def test_failure_sends_subject_and_last_25_lines_only(self):
        # 40 numbered lines then a non-zero exit.
        cmd = "for i in $(seq 1 40); do echo line-$i; done; exit 3"
        p = run_job("demo-job", "slack:CTEST", "--", "bash", "-c", cmd)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("❌ demo-job failed (exit 3) on <HOME_SERVER>", p.stdout)
        self.assertNotIn("line-1\n", p.stdout.split("--- body", 1)[1])
        self.assertIn("line-40", p.stdout)
        # exactly the last 25 of the 40 lines should be in the dry-run body
        body = p.stdout.split("--- body (last 25 lines) ---", 1)[1]
        self.assertIn("line-16", body)
        self.assertNotIn("line-15\n", body)

    def test_usage_error_on_missing_separator(self):
        p = run_job("demo-job", "slack:CTEST", "echo", "hi")
        self.assertEqual(p.returncode, 2)

    def test_failure_body_redacts_common_secret_patterns(self):
        # A failing subprocess's own stderr can contain leaked credentials
        # (e.g. a wrapped API client dumping its request headers on error).
        # These must never reach the failure body posted to Slack.
        cmd = (
            'echo "Authorization: Bearer\x20live-abcdef1234567890" >&2; '
            'echo "token=zzz-super-secret-999" >&2; '
            'echo "X-API-KEY: my-very-secret-key" >&2; '
            "exit 1"
        )
        p = run_job("demo-job", "slack:CTEST", "--", "bash", "-c", cmd)
        self.assertNotEqual(p.returncode, 0)
        body = p.stdout.split("--- body (last 25 lines) ---", 1)[1]
        for secret in ("live-abcdef1234567890", "zzz-super-secret-999", "my-very-secret-key"):
            self.assertNotIn(secret, body)
        self.assertIn("[REDACTED]", body)


if __name__ == "__main__":
    unittest.main()
