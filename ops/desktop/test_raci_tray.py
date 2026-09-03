"""
Tests for the tray icon itself.

Skipped where Qt for Python is not installed — CI has no Qt and does not need one, but the Kubuntu
box setup just ran on does, and these are the checks that catch a PyQt5/PyQt6 difference before the
person clicking the button does.

    QT_QPA_PLATFORM=offscreen python3 ops/desktop/test_raci_tray.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Must be set before the first QApplication, and there is no display in CI or over ssh.
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

# The reason is kept and reported: "not installed" and "installed but missing libEGL" look
# identical as a bare skip, and only one of them means the tray will fail to start on this box.
WHY_NOT = ""
try:
    from PyQt6 import QtWidgets  # noqa: F401

    HAVE_QT = True
except ImportError as first:  # pragma: no cover — whichever one is installed is the one that runs
    try:
        from PyQt5 import QtWidgets  # noqa: F401

        HAVE_QT = True
    except ImportError as second:
        HAVE_QT = False
        WHY_NOT = f"no working Qt for Python (PyQt6: {first}) (PyQt5: {second})"

# A suite that skips itself is a suite nobody notices has stopped running. CI sets this so a
# missing Qt is a build failure there, while a contributor without one still gets a clean skip.
if not HAVE_QT and os.environ.get("RACI_REQUIRE_QT") == "1":
    raise SystemExit(f"RACI_REQUIRE_QT=1 but {WHY_NOT}")

from raci_service import State  # noqa: E402

APP = None
tray_module = None


def setUpModule() -> None:
    global APP, tray_module
    if not HAVE_QT:
        return
    import raci_tray

    tray_module = raci_tray
    # One application per process, before anything paints: QPixmap needs it to exist.
    APP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


class FakeService:
    """Just enough of AppService for the icon to draw itself."""

    def __init__(self, tmp: Path) -> None:
        self.reported = State.STOPPED
        self.server_log = tmp / "server.log"
        self.calls: list[str] = []

        class _Log:
            path = tmp / "app.log"

            def __call__(self, message: str) -> None:
                pass

        self.log = _Log()

    def state(self) -> State:
        return self.reported

    def start(self, **_: object) -> None:
        self.calls.append("start")

    def stop(self, **_: object) -> None:
        self.calls.append("stop")


@unittest.skipUnless(HAVE_QT, WHY_NOT)
class Shims(unittest.TestCase):
    """The Qt 5 / Qt 6 differences, each one a silent AttributeError at click time if wrong."""

    def test_qaction_resolved(self) -> None:
        self.assertTrue(callable(tray_module.QAction))

    def test_every_enum_resolved_to_something_real(self) -> None:
        for name in ("ANTIALIAS", "ROUND_CAP", "TRIGGER", "MSG_INFO", "MSG_WARN",
                     "DESTRUCTIVE_ROLE", "ACCEPT_ROLE", "CANCEL_BUTTON"):
            value = getattr(tray_module, name)
            self.assertIsNotNone(value, name)
            # A missed shim leaves a bound method or a type here rather than an enum member.
            self.assertFalse(callable(value), f"{name} resolved to {value!r}")

    def test_the_exec_shim_finds_a_blocking_call(self) -> None:
        class Old:
            def exec_(self):
                return 5

        class New:
            def exec(self):
                return 7

        self.assertEqual(tray_module.qt_exec(Old()), 5)
        self.assertEqual(tray_module.qt_exec(New()), 7)


@unittest.skipUnless(HAVE_QT, WHY_NOT)
class Icon(unittest.TestCase):
    def test_an_icon_is_painted_for_every_state(self) -> None:
        for state in State:
            icon = tray_module.power_icon(tray_module.COLOURS[state])
            self.assertFalse(icon.isNull(), state)
            self.assertFalse(icon.pixmap(64, 64).isNull(), state)

    def test_the_same_colour_is_only_painted_once(self) -> None:
        # refresh() runs every four seconds; repainting on each tick would be pure waste.
        first = tray_module.power_icon("#123456")
        self.assertIs(tray_module.power_icon("#123456"), first)

    def test_every_state_has_a_colour_and_a_word_for_it(self) -> None:
        for state in State:
            self.assertIn(state, tray_module.COLOURS)
            self.assertIn(state, tray_module.WORDS)


@unittest.skipUnless(HAVE_QT, WHY_NOT)
class Menu(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.service = FakeService(Path(self._tmp.name))
        self.tray = tray_module.Tray(APP, self.service)
        self.addCleanup(self.tray.icon.hide)

    def test_off_offers_to_turn_on_and_nothing_else(self) -> None:
        self.assertEqual(self.tray.toggle_action.text(), "Turn on")
        self.assertTrue(self.tray.toggle_action.isEnabled())
        self.assertFalse(self.tray.open_action.isEnabled())
        self.assertFalse(self.tray.restart_action.isEnabled())

    def test_on_offers_to_turn_off_and_open_the_browser(self) -> None:
        self.service.reported = State.RUNNING
        self.tray.refresh()
        self.assertEqual(self.tray.toggle_action.text(), "Turn off")
        self.assertTrue(self.tray.open_action.isEnabled())
        self.assertTrue(self.tray.restart_action.isEnabled())
        self.assertTrue(self.tray.signin_action.isVisible())

    def test_a_server_we_did_not_start_cannot_be_switched_off_from_here(self) -> None:
        self.service.reported = State.FOREIGN
        self.tray.refresh()
        self.assertFalse(self.tray.toggle_action.isEnabled())
        self.assertTrue(self.tray.open_action.isEnabled())

        self.tray.toggle()  # a click on the icon

        self.assertEqual(self.service.calls, [], "must not try to kill somebody else's process")

    def test_the_state_is_spelled_out_in_the_menu_not_just_the_colour(self) -> None:
        for state in (State.STOPPED, State.RUNNING, State.FOREIGN):
            self.service.reported = state
            self.tray.refresh()
            self.assertIn(tray_module.WORDS[state], self.tray.status_action.text())

    def test_the_current_step_appears_while_it_is_working(self) -> None:
        self.tray.set_step("Waiting for the database…")
        self.assertTrue(self.tray.step_action.isVisible())
        self.assertIn("database", self.tray.step_action.text())
        self.tray.set_step("")
        self.assertFalse(self.tray.step_action.isVisible())


if __name__ == "__main__":
    unittest.main(verbosity=2)
