"""
The power button in the KDE system tray.

A deliberately thin skin over `raci_service.py`: everything with a decision in it lives there, where
it can be tested without a screen. What is left here is a painted icon, a menu, and the rule that
nothing slow ever runs on the thread that draws them.

Works against PyQt6 (Kubuntu 24.04 and later) and PyQt5 (22.04), which differ in where QAction lives
and whether enums are scoped — see the shims at the top.
"""

from __future__ import annotations

import fcntl
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from raci_service import APP_URL, AppService, Log, StartFailed, State, state_dir  # noqa: E402

try:
    from PyQt6 import QtCore, QtGui, QtWidgets

    QT_MAJOR = 6
except ImportError:  # pragma: no cover — whichever one is installed is the one that runs
    try:
        from PyQt5 import QtCore, QtGui, QtWidgets

        QT_MAJOR = 5
    except ImportError:
        sys.stderr.write(
            "The tray icon needs Qt for Python.\n"
            "  sudo apt install python3-pyqt6   (or python3-pyqt5 on older Kubuntu)\n"
        )
        raise SystemExit(1)


def enum(owner: object, scope: str, name: str) -> object:
    """Qt 6 scopes its enums (`QPainter.RenderHint.Antialiasing`); Qt 5 mostly does not."""
    scoped = getattr(owner, scope, None)
    if scoped is not None and hasattr(scoped, name):
        return getattr(scoped, name)
    return getattr(owner, name)


QAction = getattr(QtGui, "QAction", None) or QtWidgets.QAction  # QtGui in Qt6, QtWidgets in Qt5
ANTIALIAS = enum(QtGui.QPainter, "RenderHint", "Antialiasing")
ROUND_CAP = enum(QtCore.Qt, "PenCapStyle", "RoundCap")
TRIGGER = enum(QtWidgets.QSystemTrayIcon, "ActivationReason", "Trigger")
MSG_INFO = enum(QtWidgets.QSystemTrayIcon, "MessageIcon", "Information")
MSG_WARN = enum(QtWidgets.QSystemTrayIcon, "MessageIcon", "Warning")
DESTRUCTIVE_ROLE = enum(QtWidgets.QMessageBox, "ButtonRole", "DestructiveRole")
ACCEPT_ROLE = enum(QtWidgets.QMessageBox, "ButtonRole", "AcceptRole")
CANCEL_BUTTON = enum(QtWidgets.QMessageBox, "StandardButton", "Cancel")


def qt_exec(target: object) -> int:
    """Qt 6 renamed the blocking `exec_()` back to `exec()`. Used for both the app and dialogs."""
    return (target.exec if hasattr(target, "exec") else target.exec_)()

COLOURS = {
    State.STOPPED: "#8b949e",
    State.STARTING: "#e3b341",
    State.STOPPING: "#e3b341",
    State.RUNNING: "#3fb950",
    State.FOREIGN: "#58a6ff",
    State.ERROR: "#f85149",
}

WORDS = {
    State.STOPPED: "Off",
    State.STARTING: "Starting…",
    State.STOPPING: "Stopping…",
    State.RUNNING: "On",
    State.FOREIGN: "On — started outside this button",
    State.ERROR: "Something went wrong",
}


_ICON_CACHE: dict[str, QtGui.QIcon] = {}


def power_icon(colour: str) -> QtGui.QIcon:
    """The universal power glyph, drawn rather than shipped.

    Painting it means one file fewer to install, and it stays crisp at whatever size the panel asks
    for instead of being a bitmap someone picked a size for years ago.
    """
    if colour in _ICON_CACHE:
        return _ICON_CACHE[colour]

    size = 128
    pixmap = QtGui.QPixmap(size, size)
    pixmap.fill(QtGui.QColor(0, 0, 0, 0))

    painter = QtGui.QPainter(pixmap)
    painter.setRenderHint(ANTIALIAS, True)
    pen = QtGui.QPen(QtGui.QColor(colour))
    pen.setWidth(13)
    pen.setCapStyle(ROUND_CAP)
    painter.setPen(pen)

    # Qt measures from 3 o'clock, counter-clockwise, in sixteenths of a degree. Starting at 120°
    # and sweeping 300° leaves a 60° gap centred on 12 o'clock, where the stroke goes.
    inset = 24
    painter.drawArc(QtCore.QRectF(inset, inset, size - 2 * inset, size - 2 * inset), 120 * 16, 300 * 16)
    painter.drawLine(QtCore.QPointF(size / 2, 16), QtCore.QPointF(size / 2, size / 2 - 4))
    painter.end()

    _ICON_CACHE[colour] = QtGui.QIcon(pixmap)
    return _ICON_CACHE[colour]


class Worker(QtCore.QThread):
    """One slow job, off the UI thread.

    Qt will not let a widget be touched from here, which is the right constraint: the job reports
    through signals and the main thread decides what that looks like.
    """

    step = QtCore.pyqtSignal(str)
    #: ok, job, title, detail
    done = QtCore.pyqtSignal(bool, str, str, str)

    def __init__(self, job: str, service: AppService) -> None:
        super().__init__()
        self.job = job
        self.service = service
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    def run(self) -> None:
        try:
            if self.job in ("start", "restart"):
                run = self.service.restart if self.job == "restart" else self.service.start
                run(on_step=self.step.emit, cancelled=lambda: self._cancelled)
                self.done.emit(True, "start", "The RACI Tool is on", "")
            elif self.job == "stop":
                self.service.stop(on_step=self.step.emit)
                self.done.emit(True, "stop", "The RACI Tool is off", "")
            elif self.job == "update":
                self.done.emit(True, "update", "Update", self.service.update(on_step=self.step.emit))
        except StartFailed as err:
            self.done.emit(False, self.job, str(err), err.detail)
        except Exception as err:  # pragma: no cover — a crash here must still leave a usable menu
            self.done.emit(False, self.job, "Something went wrong.", f"{type(err).__name__}: {err}")


class Tray(QtCore.QObject):
    def __init__(self, app: QtWidgets.QApplication, service: AppService) -> None:
        super().__init__()
        self.app = app
        self.service = service
        self.worker: Worker | None = None
        self.busy_state: State | None = None
        self.detail = ""

        self.icon = QtWidgets.QSystemTrayIcon()
        self.icon.activated.connect(self._activated)

        self.menu = QtWidgets.QMenu()
        self.status_action = QAction("…", self.menu)
        self.status_action.setEnabled(False)
        self.step_action = QAction("", self.menu)
        self.step_action.setEnabled(False)
        self.step_action.setVisible(False)
        self.toggle_action = QAction("Turn on", self.menu)
        self.toggle_action.triggered.connect(self.toggle)
        self.open_action = QAction("Open in browser", self.menu)
        self.open_action.triggered.connect(self.open_browser)
        self.restart_action = QAction("Restart", self.menu)
        self.restart_action.triggered.connect(lambda: self.run_job("restart"))
        self.signin_action = QAction("Sign in with  admin.user  /  password", self.menu)
        self.signin_action.setEnabled(False)
        self.log_action = QAction("Show the log", self.menu)
        self.log_action.triggered.connect(self.open_log)
        self.update_action = QAction("Check for updates", self.menu)
        self.update_action.triggered.connect(lambda: self.run_job("update"))
        self.quit_action = QAction("Quit", self.menu)
        self.quit_action.triggered.connect(self.quit)

        for action in (self.status_action, self.step_action):
            self.menu.addAction(action)
        self.menu.addSeparator()
        for action in (self.toggle_action, self.open_action, self.restart_action):
            self.menu.addAction(action)
        self.menu.addSeparator()
        self.menu.addAction(self.signin_action)
        self.menu.addSeparator()
        for action in (self.log_action, self.update_action, self.quit_action):
            self.menu.addAction(action)

        self.icon.setContextMenu(self.menu)
        self.refresh()
        self.icon.show()

        # Cheap and local, so polling costs nothing and keeps the icon honest when the server is
        # started or killed from a terminal.
        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self.refresh)
        self.timer.start(4000)

    # ---- display -----------------------------------------------------------------------------

    def current_state(self) -> State:
        return self.busy_state or self.service.state()

    def refresh(self) -> None:
        state = self.current_state()
        self.icon.setIcon(power_icon(COLOURS[state]))
        self.icon.setToolTip(f"ASIC RACI Tool — {WORDS[state]}")
        self.status_action.setText(f"ASIC RACI Tool — {WORDS[state]}")

        busy = self.worker is not None
        self.toggle_action.setText("Turn off" if state is State.RUNNING else "Turn on")
        self.toggle_action.setEnabled(not busy and state is not State.FOREIGN)
        self.open_action.setEnabled(state in (State.RUNNING, State.FOREIGN))
        self.restart_action.setEnabled(not busy and state is State.RUNNING)
        self.update_action.setEnabled(not busy)
        self.signin_action.setVisible(state in (State.RUNNING, State.FOREIGN))

    def set_step(self, text: str) -> None:
        self.step_action.setText(f"   {text}")
        self.step_action.setVisible(bool(text))
        self.icon.setToolTip(f"ASIC RACI Tool — {text}")

    def notify(self, title: str, body: str = "", warning: bool = False) -> None:
        self.icon.showMessage(title, body, MSG_WARN if warning else MSG_INFO, 8000)

    # ---- actions -----------------------------------------------------------------------------

    def _activated(self, reason: object) -> None:
        if reason == TRIGGER:
            self.toggle()

    def toggle(self) -> None:
        if self.worker is not None:
            return
        state = self.current_state()
        if state is State.FOREIGN:
            self.notify(
                "Already running",
                "Something outside this button is serving localhost:3000, so it is not mine to "
                "switch off.",
                warning=True,
            )
            return
        self.run_job("stop" if state is State.RUNNING else "start")

    def run_job(self, job: str) -> None:
        if self.worker is not None:
            return
        self.busy_state = State.STOPPING if job == "stop" else State.STARTING
        self.set_step("Working…")
        self.refresh()

        self.worker = Worker(job, self.service)
        self.worker.step.connect(self.set_step)
        self.worker.done.connect(self.finished)
        self.worker.start()

    def finished(self, ok: bool, job: str, title: str, detail: str) -> None:
        self.worker = None
        self.busy_state = None
        self.set_step("")

        if not ok:
            self.notify(title, detail, warning=True)
        elif job == "start":
            self.notify(title, "Sign in with  admin.user  /  password")
            self.open_browser()
        else:
            self.notify(title, detail)
        self.refresh()

    def open_browser(self) -> None:
        QtGui.QDesktopServices.openUrl(QtCore.QUrl(APP_URL))

    def open_log(self) -> None:
        path = self.service.server_log
        if not path.exists():
            path = self.service.log.path
        if not path.exists():
            self.notify("No log yet", "There will be one once you turn it on.")
            return
        QtGui.QDesktopServices.openUrl(QtCore.QUrl.fromLocalFile(str(path)))

    def quit(self) -> None:
        if self.worker is not None:
            self.notify("Still working", "Give it a moment, then try again.", warning=True)
            return
        if self.current_state() is not State.RUNNING:
            self.app.quit()
            return

        box = QtWidgets.QMessageBox()
        box.setWindowTitle("Quit")
        box.setText("The RACI Tool is still on.")
        box.setInformativeText(
            "Leaving it running is fine — but without this button in the tray there is no easy way "
            "to switch it off again."
        )
        off = box.addButton("Turn it off and quit", DESTRUCTIVE_ROLE)
        leave = box.addButton("Leave it running", ACCEPT_ROLE)
        box.addButton(CANCEL_BUTTON)
        qt_exec(box)

        clicked = box.clickedButton()
        if clicked is off:
            self.service.stop()
            self.app.quit()
        elif clicked is leave:
            self.app.quit()


def only_one_copy(path: Path):
    """Hold a lock for the life of the process, so autostart plus a menu click is still one icon."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "w")  # noqa: SIM115 — the lock lives as long as the process does
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return None
    handle.write(f"{os.getpid()}\n")
    handle.flush()
    return handle


def repo_root() -> Path:
    override = os.environ.get("RACI_REPO")
    if override:
        return Path(override).expanduser().resolve()
    return Path(__file__).resolve().parent.parent.parent


def main() -> int:
    app = QtWidgets.QApplication(sys.argv)
    app.setApplicationName("raci-tool")
    app.setApplicationDisplayName("ASIC RACI Tool")
    app.setDesktopFileName("raci-tool")
    # Closing the "still running?" dialog must not take the tray icon with it.
    app.setQuitOnLastWindowClosed(False)

    lock = only_one_copy(state_dir() / "tray.lock")
    if lock is None:
        sys.stderr.write("The RACI Tool power button is already running.\n")
        return 0

    if not QtWidgets.QSystemTrayIcon.isSystemTrayAvailable():
        QtWidgets.QMessageBox.critical(
            None,
            "No system tray",
            "This desktop has no system tray, so the power button has nowhere to live.\n\n"
            "You can still start the tool from a terminal with:  pnpm dev",
        )
        return 1

    repo = repo_root()
    if not (repo / "docker-compose.yml").exists():
        QtWidgets.QMessageBox.critical(
            None,
            "Cannot find the project",
            f"Expected the RACI Tool project at:\n\n{repo}\n\n"
            "If you moved the folder, run scripts/setup-kubuntu.sh again from its new home.",
        )
        return 1

    service = AppService(repo, log=Log(state_dir() / "app.log"))
    # Recorded because the first question about a misbehaving tray icon is always which Qt it found.
    service.log(f"tray started · PyQt{QT_MAJOR} · repo {repo}")
    tray = Tray(app, service)
    tray.refresh()

    return qt_exec(app)


if __name__ == "__main__":
    raise SystemExit(main())
