"""
Tests for the power button's state machine.

Stdlib unittest and fakes only — no Qt, no Docker, no network — so this runs anywhere, including
the CI box, which is the point: the failure modes worth testing here are the ones that only show up
on somebody else's machine at the worst moment.

    python3 ops/desktop/test_raci_service.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from raci_service import (  # noqa: E402
    APP_PROBE_URL,
    KEYCLOAK_PROBE_URL,
    AppService,
    Log,
    Probe,
    Runner,
    StartFailed,
    Started,
    State,
    proc_starttime,
)


class Clock:
    """Fake time, so a 420-second timeout costs nothing to test."""

    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += seconds


class FakeRunner(Runner):
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.terminated: list[int] = []
        self.rules: list[tuple[str, tuple[int, str]]] = []
        self.alive_pids: set[int] = set()
        self.next_pid = 4242

    def rule(self, needle: str, rc: int = 0, out: str = "") -> None:
        self.rules.append((needle, (rc, out)))

    def run(self, argv, *, cwd, timeout, env=None):  # type: ignore[override]
        line = " ".join(argv)
        self.calls.append(line)
        for needle, result in self.rules:
            if needle in line:
                return result
        return (0, "")

    def spawn(self, argv, *, cwd, log_path, env=None):  # type: ignore[override]
        self.calls.append("SPAWN " + " ".join(argv))
        started = Started(pid=self.next_pid, starttime="777")
        self.alive_pids.add(started.pid)
        return started

    def alive(self, started):  # type: ignore[override]
        return started.pid in self.alive_pids

    def terminate(self, started, *, grace=12.0):  # type: ignore[override]
        self.terminated.append(started.pid)
        self.alive_pids.discard(started.pid)


class FakeProbe(Probe):
    def __init__(self, statuses: dict[str, object] | None = None) -> None:
        self.statuses = statuses or {}

    def http_status(self, url, timeout=3.0):  # type: ignore[override]
        value = self.statuses.get(url)
        return value() if callable(value) else value


def service(tmp: Path, runner: FakeRunner, probe: FakeProbe) -> tuple[AppService, Clock]:
    clock = Clock()
    svc = AppService(
        repo=tmp / "repo",
        runner=runner,
        probe=probe,
        log=Log(tmp / "state" / "app.log"),
        state_home=tmp / "state",
        sleep=clock.sleep,
        now=clock.now,
    )
    return svc, clock


class TempCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        (self.tmp / "repo").mkdir()
        self.addCleanup(self._tmp.cleanup)


class ProcessIdentity(TempCase):
    """A pid on its own is not an identity. This is the part that must not kill the wrong process."""

    def test_starttime_survives_a_process_name_with_spaces_and_parens(self) -> None:
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.addCleanup(proc.kill)
        self.assertIsNotNone(proc_starttime(proc.pid))
        self.assertTrue(proc_starttime(proc.pid).isdigit())

    def test_starttime_of_a_dead_process_is_none(self) -> None:
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        proc.wait()
        # Reaped, so /proc is gone. (A zombie would still have a stat file, which is why the real
        # Runner also holds the Popen for its own children.)
        self.assertIsNone(proc_starttime(999_999_999))

    def test_stat_parsing_is_not_confused_by_the_comm_field(self) -> None:
        # Every field carries its own number as its value, so an off-by-one is impossible to miss.
        # The process name deliberately contains both a space and a ')': a naive split() of the
        # whole line, or a partition on the FIRST ')', lands several fields adrift.
        fields = " ".join(str(n) for n in range(3, 41))
        line = f"1234 (some ) proc) {fields}"

        tail = line.rpartition(")")[2].split()

        self.assertEqual(tail[0], "3", "the first value after the comm field is field 3, the state")
        self.assertEqual(tail[19], "22", "starttime is field 22")

    def test_alive_rejects_a_recycled_pid(self) -> None:
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.addCleanup(proc.kill)
        real = Runner()
        self.assertTrue(real.alive(Started(pid=proc.pid, starttime=proc_starttime(proc.pid))))
        self.assertFalse(real.alive(Started(pid=proc.pid, starttime="1")))


class Adoption(TempCase):
    def test_a_running_server_is_picked_back_up_after_the_tray_restarts(self) -> None:
        runner, probe = FakeRunner(), FakeProbe({APP_PROBE_URL: 200})
        runner.alive_pids.add(4242)
        svc, _ = service(self.tmp, runner, probe)
        svc.pid_file.parent.mkdir(parents=True, exist_ok=True)
        svc.pid_file.write_text("4242 777\n")

        self.assertEqual(svc.state(), State.RUNNING)

    def test_a_stale_pid_file_is_cleared_rather_than_trusted(self) -> None:
        runner, probe = FakeRunner(), FakeProbe({APP_PROBE_URL: None})
        svc, _ = service(self.tmp, runner, probe)
        svc.pid_file.parent.mkdir(parents=True, exist_ok=True)
        svc.pid_file.write_text("4242 777\n")  # not in runner.alive_pids

        self.assertEqual(svc.state(), State.STOPPED)
        self.assertFalse(svc.pid_file.exists())

    def test_a_corrupt_pid_file_does_not_crash_the_tray(self) -> None:
        runner, probe = FakeRunner(), FakeProbe({APP_PROBE_URL: None})
        svc, _ = service(self.tmp, runner, probe)
        svc.pid_file.parent.mkdir(parents=True, exist_ok=True)
        svc.pid_file.write_text("not-a-pid\n")

        self.assertEqual(svc.state(), State.STOPPED)


class Status(TempCase):
    def test_port_answered_by_someone_else_is_reported_as_foreign(self) -> None:
        runner, probe = FakeRunner(), FakeProbe({APP_PROBE_URL: 200})
        svc, _ = service(self.tmp, runner, probe)
        self.assertEqual(svc.state(), State.FOREIGN)

    def test_our_process_alive_but_not_serving_yet_is_starting(self) -> None:
        runner, probe = FakeRunner(), FakeProbe({APP_PROBE_URL: None})
        runner.alive_pids.add(4242)
        svc, _ = service(self.tmp, runner, probe)
        svc.pid_file.parent.mkdir(parents=True, exist_ok=True)
        svc.pid_file.write_text("4242 777\n")
        self.assertEqual(svc.state(), State.STARTING)

    def test_a_503_from_health_still_counts_as_up(self) -> None:
        # /api/health answers 503 while the identity provider is still booting. Treating that as
        # 'down' would make the button spin forever against a perfectly good web server.
        runner, probe = FakeRunner(), FakeProbe({APP_PROBE_URL: 503})
        svc, _ = service(self.tmp, runner, probe)
        self.assertEqual(svc.state(), State.FOREIGN)


class DockerInvocation(TempCase):
    def test_plain_docker_is_used_when_the_group_is_already_active(self) -> None:
        runner, probe = FakeRunner(), FakeProbe()
        svc, _ = service(self.tmp, runner, probe)
        svc.docker(["compose", "up", "-d"], timeout=10)
        self.assertIn("docker compose up -d", runner.calls)
        self.assertFalse(any(call.startswith("sg ") for call in runner.calls))

    def test_sg_is_used_when_the_docker_group_is_not_in_this_session_yet(self) -> None:
        # The case right after setup: usermod has run, but the desktop session predates it.
        runner, probe = FakeRunner(), FakeProbe()
        runner.rule("docker info", rc=1, out="permission denied")
        svc, _ = service(self.tmp, runner, probe)
        svc.docker(["compose", "up", "-d"], timeout=10)
        self.assertIn("sg docker -c docker compose up -d", runner.calls)

    def test_arguments_that_need_quoting_survive_the_sg_shell(self) -> None:
        runner, probe = FakeRunner(), FakeProbe()
        runner.rule("docker info", rc=1)
        svc, _ = service(self.tmp, runner, probe)
        svc.docker(["compose", "exec", "-T", "postgres", "psql", "-tAc", "select 1"], timeout=10)
        # Without quoting, `select 1` arrives as two arguments and psql runs `select`.
        self.assertTrue(any("'select 1'" in call for call in runner.calls), runner.calls)


class Starting(TempCase):
    def _happy(self) -> tuple[FakeRunner, FakeProbe]:
        runner = FakeRunner()
        app_seen = {"n": 0}

        def app_status():
            app_seen["n"] += 1
            return None if app_seen["n"] <= 2 else 200  # answers on the third poll

        return runner, FakeProbe({APP_PROBE_URL: app_status, KEYCLOAK_PROBE_URL: 200})

    def test_the_stack_comes_up_in_the_order_that_makes_it_work(self) -> None:
        runner, probe = self._happy()
        svc, _ = service(self.tmp, runner, probe)
        svc.start()

        order = [
            next(i for i, c in enumerate(runner.calls) if "compose up -d" in c),
            next(i for i, c in enumerate(runner.calls) if "psql" in c),
            next(i for i, c in enumerate(runner.calls) if "db:migrate" in c),
            next(i for i, c in enumerate(runner.calls) if c.startswith("SPAWN")),
        ]
        self.assertEqual(order, sorted(order), runner.calls)

    def test_only_the_services_the_app_needs_are_started(self) -> None:
        # The compose file also carries an OpenLDAP for directory-adapter work. Bringing it up here
        # would make the power button fail on a box that cannot pull an image it never uses.
        runner, probe = self._happy()
        svc, _ = service(self.tmp, runner, probe)
        svc.start()
        up = next(c for c in runner.calls if "compose up -d" in c)
        self.assertIn("postgres", up)
        self.assertIn("keycloak", up)
        self.assertNotIn("openldap", up)

    def test_readiness_is_a_real_query_not_pg_isready(self) -> None:
        runner, probe = self._happy()
        svc, _ = service(self.tmp, runner, probe)
        svc.start()
        psql = [c for c in runner.calls if "psql" in c]
        self.assertTrue(psql)
        self.assertTrue(all("select 1" in c for c in psql))
        self.assertFalse(any("pg_isready" in c for c in runner.calls))

    def test_the_dev_server_is_recorded_so_it_can_be_switched_off_again(self) -> None:
        runner, probe = self._happy()
        svc, _ = service(self.tmp, runner, probe)
        svc.start()
        self.assertEqual(svc.pid_file.read_text().split(), ["4242", "777"])
        self.assertEqual(svc.state(), State.RUNNING)

    def test_a_second_press_while_running_does_nothing(self) -> None:
        runner, probe = self._happy()
        svc, _ = service(self.tmp, runner, probe)
        svc.start()
        spawns = len([c for c in runner.calls if c.startswith("SPAWN")])
        svc.start()
        self.assertEqual(len([c for c in runner.calls if c.startswith("SPAWN")]), spawns)

    def test_it_refuses_to_start_over_someone_elses_server(self) -> None:
        runner = FakeRunner()
        probe = FakeProbe({APP_PROBE_URL: 200})
        svc, _ = service(self.tmp, runner, probe)
        with self.assertRaises(StartFailed) as caught:
            svc.start()
        self.assertIn("port 3000", str(caught.exception))
        self.assertFalse(any(c.startswith("SPAWN") for c in runner.calls))

    def test_docker_failing_says_so_before_anything_else_is_attempted(self) -> None:
        runner = FakeRunner()
        runner.rule("compose up -d", rc=1, out="Cannot connect to the Docker daemon")
        probe = FakeProbe({APP_PROBE_URL: None})
        svc, _ = service(self.tmp, runner, probe)
        with self.assertRaises(StartFailed) as caught:
            svc.start()
        self.assertIn("Docker", str(caught.exception))
        self.assertFalse(any("db:migrate" in c for c in runner.calls))

    def test_a_database_that_never_comes_up_does_not_leave_a_server_behind(self) -> None:
        runner = FakeRunner()
        runner.rule("psql", rc=1, out="could not connect")
        probe = FakeProbe({APP_PROBE_URL: None})
        svc, _ = service(self.tmp, runner, probe)
        with self.assertRaises(StartFailed) as caught:
            svc.start()
        self.assertIn("database", str(caught.exception).lower())
        self.assertFalse(any(c.startswith("SPAWN") for c in runner.calls))

    def test_a_failed_migration_stops_before_starting_the_app(self) -> None:
        runner = FakeRunner()
        runner.rule("db:migrate", rc=1, out="relation already exists")
        probe = FakeProbe({APP_PROBE_URL: None})
        svc, _ = service(self.tmp, runner, probe)
        with self.assertRaises(StartFailed):
            svc.start()
        self.assertFalse(any(c.startswith("SPAWN") for c in runner.calls))

    def test_a_web_server_that_never_answers_is_cleaned_up(self) -> None:
        runner = FakeRunner()
        probe = FakeProbe({APP_PROBE_URL: None, KEYCLOAK_PROBE_URL: 200})
        svc, _ = service(self.tmp, runner, probe)
        with self.assertRaises(StartFailed):
            svc.start()
        # Otherwise the next press finds a half-dead server on the port and refuses forever.
        self.assertEqual(runner.terminated, [4242])
        self.assertFalse(svc.pid_file.exists())

    def test_a_slow_sign_in_server_does_not_fail_the_start(self) -> None:
        runner, probe = self._happy()
        probe.statuses[KEYCLOAK_PROBE_URL] = None
        svc, _ = service(self.tmp, runner, probe)
        steps: list[str] = []
        svc.start(on_step=steps.append)
        self.assertEqual(steps[-1], "Ready")
        self.assertTrue(any("slow to start" in s for s in steps), steps)

    def test_cancelling_stops_the_wait(self) -> None:
        runner = FakeRunner()
        runner.rule("psql", rc=1)
        probe = FakeProbe({APP_PROBE_URL: None})
        svc, clock = service(self.tmp, runner, probe)
        with self.assertRaises(StartFailed):
            svc.start(cancelled=lambda: clock.t > 10)
        self.assertLess(clock.t, 180)


class Stopping(TempCase):
    def test_stopping_kills_the_server_then_the_containers(self) -> None:
        runner = FakeRunner()
        runner.alive_pids.add(4242)
        probe = FakeProbe({APP_PROBE_URL: None})
        svc, _ = service(self.tmp, runner, probe)
        svc.pid_file.parent.mkdir(parents=True, exist_ok=True)
        svc.pid_file.write_text("4242 777\n")

        svc.stop()

        self.assertEqual(runner.terminated, [4242])
        self.assertTrue(any("compose stop" in c for c in runner.calls))
        # `down` would discard the Postgres volume's warm state and the imported Keycloak realm,
        # turning every power-on into a two-minute wait.
        self.assertFalse(any("compose down" in c for c in runner.calls))
        self.assertFalse(svc.pid_file.exists())

    def test_stopping_when_nothing_is_running_is_harmless(self) -> None:
        runner = FakeRunner()
        probe = FakeProbe({APP_PROBE_URL: None})
        svc, _ = service(self.tmp, runner, probe)
        svc.stop()
        self.assertEqual(runner.terminated, [])

    def test_restart_leaves_the_containers_alone(self) -> None:
        runner = FakeRunner()
        runner.alive_pids.add(4242)
        seen = {"n": 0}

        def app_status():
            seen["n"] += 1
            return None if seen["n"] <= 3 else 200

        probe = FakeProbe({APP_PROBE_URL: app_status, KEYCLOAK_PROBE_URL: 200})
        svc, _ = service(self.tmp, runner, probe)
        svc.pid_file.parent.mkdir(parents=True, exist_ok=True)
        svc.pid_file.write_text("4242 777\n")

        svc.restart()

        self.assertFalse(any("compose stop" in c for c in runner.calls))
        self.assertTrue(any(c.startswith("SPAWN") for c in runner.calls))


class Updating(TempCase):
    def test_no_new_commits_means_no_reinstall(self) -> None:
        runner = FakeRunner()
        runner.rule("git pull", rc=0, out="Already up to date.\n")
        svc, _ = service(self.tmp, runner, FakeProbe())
        self.assertEqual(svc.update(), "Already up to date.")
        self.assertFalse(any("pnpm install" in c for c in runner.calls))

    def test_a_pull_that_would_clobber_local_work_is_reported_not_forced(self) -> None:
        runner = FakeRunner()
        runner.rule("git pull", rc=1, out="fatal: Not possible to fast-forward, aborting.")
        svc, _ = service(self.tmp, runner, FakeProbe())
        self.assertIn("Could not update", svc.update())

    def test_a_real_update_reinstalls_dependencies(self) -> None:
        runner = FakeRunner()
        runner.rule("git pull", rc=0, out="Updating d7b6111..3237519\n 4 files changed\n")
        svc, _ = service(self.tmp, runner, FakeProbe())
        self.assertIn("Updated", svc.update())
        self.assertTrue(any("pnpm install --frozen-lockfile" in c for c in runner.calls))


class Environment(TempCase):
    def test_corepack_is_told_not_to_ask_permission_to_download_pnpm(self) -> None:
        # Nothing is attached to a tray app's stdin, so that prompt is an unexplained hang.
        svc, _ = service(self.tmp, FakeRunner(), FakeProbe())
        self.assertEqual(svc._env()["COREPACK_ENABLE_DOWNLOAD_PROMPT"], "0")

    def test_the_path_always_contains_the_usual_places_a_desktop_launch_forgets(self) -> None:
        svc, _ = service(self.tmp, FakeRunner(), FakeProbe())
        old = os.environ.get("PATH")
        try:
            os.environ["PATH"] = "/nonsense"
            self.assertIn("/usr/bin", svc._env()["PATH"].split(":"))
        finally:
            if old is not None:
                os.environ["PATH"] = old


class RealProbe(TempCase):
    """The one part of Probe worth testing for real: that it ignores the proxy settings."""

    def test_localhost_is_probed_directly_even_behind_a_proxy(self) -> None:
        import http.server
        import threading

        class Quiet(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 — the handler API
                self.send_response(503)  # what /api/health says while the IdP is still starting
                self.end_headers()

            def log_message(self, *_args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Quiet)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        port = server.server_address[1]

        old = {k: os.environ.get(k) for k in ("http_proxy", "HTTP_PROXY")}
        try:
            # Port 9 is discard: anything actually routed through this proxy hangs or fails.
            os.environ["http_proxy"] = os.environ["HTTP_PROXY"] = "http://127.0.0.1:9"
            status = Probe().http_status(f"http://127.0.0.1:{port}/api/health", timeout=5)
        finally:
            for key, value in old.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

        self.assertEqual(status, 503)


if __name__ == "__main__":
    unittest.main(verbosity=2)
