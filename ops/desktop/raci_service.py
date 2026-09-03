"""
Turning the RACI Tool on and off.

Everything here is deliberately free of Qt so it can be tested without a display: the tray icon in
`raci_tray.py` is a thin skin over this module, and the interesting bugs — a half-started stack, a
recycled pid, Postgres reporting ready before it really is — all live down here where a test can
reach them.

The unit of work is the whole stack, because that is what the person clicking the button means by
"on": Postgres, Keycloak, the schema migration and the web server. Bringing up four things one at a
time and calling it started when the first one answers is how you get a power button that lies.
"""

from __future__ import annotations

import os
import shlex
import signal
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable, Sequence

APP_URL = "http://localhost:3000"
APP_PROBE_URL = f"{APP_URL}/api/health"
# Discovery is the honest readiness signal for Keycloak: it is only served once the realm has been
# imported, which is the slow part and the part sign-in actually needs.
KEYCLOAK_PROBE_URL = "http://localhost:8080/realms/raci/.well-known/openid-configuration"

#: What the app itself needs. docker-compose.yml also defines an OpenLDAP standing in for Active
#: Directory, which exists for developing the directory adapter — starting it here would make the
#: power button depend on pulling an image nothing in a desktop install ever talks to.
STACK_SERVICES = ("postgres", "keycloak")


class State(str, Enum):
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    #: Something is already serving port 3000 that this app did not start, so it is not ours to kill.
    FOREIGN = "foreign"
    ERROR = "error"


def state_dir() -> Path:
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(Path.home(), ".local", "state")
    return Path(base) / "raci-tool"


# --------------------------------------------------------------------------------------------
# The two things a test needs to replace: running processes, and reaching the network.
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Started:
    """A process we launched, identified strongly enough to survive this app being restarted."""

    pid: int
    #: Field 22 of /proc/<pid>/stat. Pins the identity: a recycled pid has a different start time,
    #: so an adopted pid can never turn out to be somebody else's browser.
    starttime: str


class Runner:
    """Runs processes. Replaced wholesale in tests."""

    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        timeout: float,
        env: dict[str, str] | None = None,
    ) -> tuple[int, str]:
        try:
            done = subprocess.run(
                list(argv),
                cwd=str(cwd),
                env=env,
                timeout=timeout,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                errors="replace",
            )
            return done.returncode, done.stdout or ""
        except subprocess.TimeoutExpired:
            return 124, f"timed out after {timeout:.0f}s: {shlex.join(argv)}"
        except FileNotFoundError as err:
            return 127, str(err)

    def spawn(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        log_path: Path,
        env: dict[str, str] | None = None,
    ) -> Started:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(log_path, "ab", buffering=0)  # noqa: SIM115 — owned by the child, not us
        try:
            proc = subprocess.Popen(
                list(argv),
                cwd=str(cwd),
                env=env,
                stdout=handle,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                # Its own session, so the whole Nuxt process tree can be signalled at once. Nuxt
                # forks; terminating only the parent leaves a child holding port 3000 and the next
                # power-on fails with EADDRINUSE.
                start_new_session=True,
            )
        finally:
            handle.close()
        return Started(pid=proc.pid, starttime=proc_starttime(proc.pid) or "")

    def alive(self, started: Started) -> bool:
        if started.pid <= 0:
            return False
        now = proc_starttime(started.pid)
        if now is None:
            return False
        # An empty recorded starttime means we could not read /proc when we spawned; fall back to
        # bare existence rather than refusing to manage a process we really did start.
        return not started.starttime or now == started.starttime

    def terminate(self, started: Started, *, grace: float = 12.0) -> None:
        if not self.alive(started):
            return
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(started.pid, sig)
            except ProcessLookupError:
                return
            except PermissionError:
                return
            deadline = time.monotonic() + (grace if sig == signal.SIGTERM else 5.0)
            while time.monotonic() < deadline:
                if not self.alive(started):
                    return
                time.sleep(0.2)


class Probe:
    """Reaches the network. Replaced in tests."""

    #: Everything probed here is on this machine, so the opener is built with proxies switched off.
    #: urllib reads http_proxy from the environment by default, and on a workstation configured for
    #: a corporate proxy that turns "is the app up?" into a question asked of a server in another
    #: building — which answers no, forever.
    _opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def http_status(self, url: str, timeout: float = 3.0) -> int | None:
        """The status code, or None if nothing answered.

        A code — any code — means a server is listening and routing. /api/health answers 503 while
        the identity provider is still starting, and that is still 'the web app is up'.
        """
        try:
            with self._opener.open(url, timeout=timeout) as resp:  # noqa: S310 — localhost only
                return resp.status
        except urllib.error.HTTPError as err:
            return err.code
        except Exception:
            return None


def proc_starttime(pid: int) -> str | None:
    """Field 22 of /proc/<pid>/stat, or None if there is no such process.

    Read after the last ')' because a process name may itself contain spaces and parentheses, which
    is exactly the case that breaks a naive split.
    """
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    tail = raw.rpartition(")")[2].split()
    # tail[0] is field 3 (state), so field 22 sits at index 19.
    return tail[19] if len(tail) > 19 else None


# --------------------------------------------------------------------------------------------


class Log:
    """Append-only, with a callback so the tray can echo the current step in its menu."""

    def __init__(self, path: Path, on_line: Callable[[str], None] | None = None) -> None:
        self.path = path
        self.on_line = on_line

    def __call__(self, message: str) -> None:
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {message}"
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a") as fh:
                fh.write(line + "\n")
        except OSError:
            pass  # Losing the log is not a reason to fail the click.
        if self.on_line:
            self.on_line(message)


class StartFailed(RuntimeError):
    """Raised with a sentence a non-developer can act on, and the log line that produced it."""

    def __init__(self, message: str, detail: str = "") -> None:
        super().__init__(message)
        self.detail = detail


class AppService:
    """The power button's state machine."""

    def __init__(
        self,
        repo: Path,
        *,
        runner: Runner | None = None,
        probe: Probe | None = None,
        log: Log | None = None,
        state_home: Path | None = None,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self.repo = Path(repo)
        self.runner = runner or Runner()
        self.probe = probe or Probe()
        self.state_home = state_home or state_dir()
        self.log = log or Log(self.state_home / "app.log")
        self._sleep = sleep
        self._now = now
        self._started: Started | None = None
        self._docker_prefix: list[str] | None = None
        self.last_error: str = ""

    # ---- paths -------------------------------------------------------------------------------

    @property
    def pid_file(self) -> Path:
        return self.state_home / "dev-server.pid"

    @property
    def server_log(self) -> Path:
        return self.state_home / "server.log"

    # ---- environment -------------------------------------------------------------------------

    def _env(self) -> dict[str, str]:
        env = dict(os.environ)
        # Corepack asks for confirmation before downloading the pnpm version pinned in
        # package.json. Nothing is watching a tray app's stdin, so that prompt is a silent hang.
        env["COREPACK_ENABLE_DOWNLOAD_PROMPT"] = "0"
        env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
        for extra in ("/usr/local/bin", "/usr/bin"):
            if extra not in env["PATH"].split(":"):
                env["PATH"] = f"{env['PATH']}:{extra}"
        return env

    def docker_prefix(self) -> list[str]:
        """How to invoke docker as this user.

        Right after `usermod -aG docker`, the group is real in /etc/group but absent from every
        already-running session — including the desktop session this tray was launched from. `sg`
        starts a shell that does have it, which means the button works before the first logout
        instead of after it.
        """
        if self._docker_prefix is not None:
            return self._docker_prefix
        rc, _ = self.runner.run(["docker", "info"], cwd=self.repo, timeout=25)
        self._docker_prefix = [] if rc == 0 else ["sg", "docker", "-c"]
        return self._docker_prefix

    def docker(self, args: Sequence[str], *, timeout: float) -> tuple[int, str]:
        prefix = self.docker_prefix()
        if prefix:
            return self.runner.run(
                [*prefix, "docker " + shlex.join(args)], cwd=self.repo, timeout=timeout
            )
        return self.runner.run(["docker", *args], cwd=self.repo, timeout=timeout)

    # ---- state -------------------------------------------------------------------------------

    def _remember(self, started: Started | None) -> None:
        self._started = started
        try:
            self.state_home.mkdir(parents=True, exist_ok=True)
            if started is None:
                self.pid_file.unlink(missing_ok=True)
            else:
                self.pid_file.write_text(f"{started.pid} {started.starttime}\n")
        except OSError:
            pass

    def adopt(self) -> None:
        """Pick up a dev server left running by an earlier run of the tray.

        Without this, logging out and back in — or the tray crashing — leaves a server nobody can
        turn off from the UI, and the button's only honest answer becomes 'something else is
        running'.
        """
        if self._started is not None:
            return
        try:
            parts = self.pid_file.read_text().split()
        except OSError:
            return
        if not parts:
            return
        try:
            candidate = Started(pid=int(parts[0]), starttime=parts[1] if len(parts) > 1 else "")
        except ValueError:
            return
        if self.runner.alive(candidate):
            self._started = candidate
        else:
            self._remember(None)

    def state(self) -> State:
        self.adopt()
        up = self.probe.http_status(APP_PROBE_URL) is not None
        if self._started and self.runner.alive(self._started):
            return State.RUNNING if up else State.STARTING
        if up:
            return State.FOREIGN
        return State.STOPPED

    # ---- waiting -----------------------------------------------------------------------------

    def _wait(
        self,
        label: str,
        check: Callable[[], bool],
        *,
        seconds: float,
        cancelled: Callable[[], bool] | None = None,
    ) -> bool:
        deadline = self._now() + seconds
        while self._now() < deadline:
            if cancelled and cancelled():
                return False
            if check():
                self.log(f"{label}: ready")
                return True
            self._sleep(2.0)
        self.log(f"{label}: still not ready after {seconds:.0f}s")
        return False

    def _postgres_ready(self) -> bool:
        """`select 1` against the application database, not pg_isready.

        pg_isready answers yes partway through initdb, while `database "raci" does not exist` is
        still the truth — and the migration that runs next is what discovers it.
        """
        rc, _ = self.docker(
            ["compose", "exec", "-T", "postgres", "psql", "-U", "raci", "-d", "raci", "-tAc", "select 1"],
            timeout=20,
        )
        return rc == 0

    # ---- the button --------------------------------------------------------------------------

    def start(
        self,
        *,
        on_step: Callable[[str], None] | None = None,
        cancelled: Callable[[], bool] | None = None,
    ) -> None:
        """Bring the whole stack up. Raises StartFailed with something a person can act on."""

        def step(message: str) -> None:
            self.log(message)
            if on_step:
                on_step(message)

        self.last_error = ""
        self.adopt()
        if self._started and self.runner.alive(self._started):
            step("Already running")
            return

        if self.probe.http_status(APP_PROBE_URL) is not None:
            raise StartFailed(
                "Something is already using port 3000.",
                "Close whatever is serving http://localhost:3000 and try again.",
            )

        step("Starting the database and sign-in server…")
        rc, out = self.docker(["compose", "up", "-d", *STACK_SERVICES], timeout=300)
        if rc != 0:
            raise StartFailed("Could not start Docker. Is the Docker service running?", out.strip())

        step("Waiting for the database…")
        if not self._wait("postgres", self._postgres_ready, seconds=180, cancelled=cancelled):
            raise StartFailed(
                "The database did not come up.",
                "Run `docker compose logs postgres` in the project folder to see why.",
            )

        step("Updating the database schema…")
        rc, out = self.runner.run(
            ["pnpm", "db:migrate"], cwd=self.repo, timeout=300, env=self._env()
        )
        if rc != 0:
            raise StartFailed("The database schema update failed.", out.strip()[-2000:])

        step("Starting the app…")
        started = self.runner.spawn(
            ["pnpm", "dev"], cwd=self.repo, log_path=self.server_log, env=self._env()
        )
        self._remember(started)

        # The first start of the day compiles the whole app, so this is generous on purpose.
        if not self._wait(
            "web server",
            lambda: self.probe.http_status(APP_PROBE_URL) is not None,
            seconds=420,
            cancelled=cancelled,
        ):
            self.runner.terminate(started)
            self._remember(None)
            raise StartFailed(
                "The app did not finish starting.",
                f"The last lines of {self.server_log} will say why.",
            )

        step("Waiting for sign-in to be ready…")
        if not self._wait(
            "keycloak",
            lambda: self.probe.http_status(KEYCLOAK_PROBE_URL) == 200,
            seconds=240,
            cancelled=cancelled,
        ):
            # Not fatal: everything except signing in works, and failing the whole start here would
            # throw away a web server that came up perfectly well.
            step("Sign-in server is slow to start — the app is up; try signing in again in a minute.")

        step("Ready")

    def stop(self, *, on_step: Callable[[str], None] | None = None, containers: bool = True) -> None:
        def step(message: str) -> None:
            self.log(message)
            if on_step:
                on_step(message)

        self.adopt()
        if self._started:
            step("Stopping the app…")
            self.runner.terminate(self._started)
            self._remember(None)

        if containers:
            step("Stopping the database and sign-in server…")
            # `stop`, not `down`: keeping the containers means the next power-on skips initdb and
            # the Keycloak realm import, which is the difference between 20 seconds and two minutes.
            rc, out = self.docker(["compose", "stop"], timeout=180)
            if rc != 0:
                self.log(f"docker compose stop failed: {out.strip()}")

        step("Off")

    def restart(
        self,
        *,
        on_step: Callable[[str], None] | None = None,
        cancelled: Callable[[], bool] | None = None,
    ) -> None:
        # The containers stay up across a restart: nothing about them is what you are restarting,
        # and stopping them would add a minute of Keycloak boot to every retry.
        self.stop(on_step=on_step, containers=False)
        self.start(on_step=on_step, cancelled=cancelled)

    # ---- housekeeping ------------------------------------------------------------------------

    def update(self, *, on_step: Callable[[str], None] | None = None) -> str:
        """Pull the latest code and reinstall. Returns a one-line summary."""

        def step(message: str) -> None:
            self.log(message)
            if on_step:
                on_step(message)

        step("Checking for updates…")
        rc, out = self.runner.run(["git", "pull", "--ff-only"], cwd=self.repo, timeout=180)
        if rc != 0:
            return f"Could not update: {out.strip().splitlines()[-1] if out.strip() else 'git failed'}"
        if "Already up to date" in out:
            return "Already up to date."
        step("Installing the update…")
        rc, out = self.runner.run(
            ["pnpm", "install", "--frozen-lockfile"], cwd=self.repo, timeout=900, env=self._env()
        )
        if rc != 0:
            return "Downloaded the update, but installing it failed. See the log."
        return "Updated. Turn it off and on again to use the new version."
