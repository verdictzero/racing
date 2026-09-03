# The power button

A tray icon that turns the whole RACI Tool on and off with one click, for people who should not
have to know what a container is.

```
./scripts/setup-kubuntu.sh
```

That one command installs everything the tool needs, loads the demo workspace, and puts the button
in your system tray. It takes about ten minutes the first time and is safe to run again.

---

## Using it

The button sits at the end of the taskbar, in the system tray.

| | |
|---|---|
| **Grey** | Off |
| **Amber** | Starting — the first start of the day takes a minute |
| **Green** | On |
| **Blue** | Something else is already using port 3000, so this button did not start it and will not stop it |

**Click it once** to turn everything on. Your browser opens by itself when it is ready.
**Click it again** to turn everything off.

Sign in with **`admin.user`**, password **`password`**. There is also `editor.user` with the same
password, who can edit but not administer.

Right-click for the rest: open the browser again, restart, show the log, check for updates, quit.

### Cannot see the button?

KDE hides tray icons it has not seen before. Click the small **^** at the left of the tray to find
it, then right-click the taskbar → **Configure System Tray** → **Entries** → set
**ASIC RACI Tool** to **Shown**.

### It will not turn on

Right-click the button → **Show the log**. The last few lines say what failed. The two usual causes:

- **"Could not start Docker."** Docker is not running: `sudo systemctl start docker`.
- **"Something is already using port 3000."** Another copy of the app — often one started in a
  terminal — is already there. Close it, or just use it; it is the same app.

### Undoing it

```
./scripts/setup-kubuntu.sh --uninstall
```

Removes the button and shuts everything down. Docker, Node and your data are left alone.

---

## What "on" actually means

Four things, in this order, because each one needs the one before it:

1. **Postgres** starts, in a container. Everything you type lives here.
2. **Keycloak** starts, in a container. It is what the sign-in page is.
3. **The database schema** is brought up to date, in case the app was updated since last time.
4. **The web server** starts and the browser is pointed at it.

Turning it off stops the web server first — the whole process tree, not just the parent, or the
next start finds port 3000 still taken — then stops the containers. It stops them rather than
removing them, so the next start skips the slow first-time setup.

The compose file also defines an OpenLDAP, standing in for Active Directory. Nothing in a desktop
install talks to it, so the button does not start it and setup writes `DIRECTORY_PROVIDER=none`
into a fresh `.env`.

---

## For developers

Two modules, split along one line: **anything with a decision in it is in `raci_service.py`, which
does not import Qt.** `raci_tray.py` is icon, menu and threading. The split exists so the failure
modes that matter — a half-started stack, a recycled pid, Postgres claiming to be ready before it
is — can be tested on a machine with no display.

| File | |
|---|---|
| `raci_service.py` | The state machine. Processes and the network go through `Runner` and `Probe`, which tests replace. |
| `raci_tray.py` | The tray icon. PyQt6, falling back to PyQt5 through the shims at the top. |
| `test_raci_service.py` | 34 tests, stdlib `unittest`, no Qt and no Docker. |
| `test_raci_tray.py` | 11 tests against a real Qt, offscreen. Skips — loudly — where Qt is missing. |
| `raci-tray` | What the `.desktop` entry runs. |
| `raci-power.svg` | The application-menu icon. The tray icon is painted at runtime so it can change colour. |

```bash
python3 ops/desktop/test_raci_service.py
QT_QPA_PLATFORM=offscreen python3 ops/desktop/test_raci_tray.py
```

Both run in CI. `RACI_REQUIRE_QT=1` turns the tray tests' skip into a failure, which is how CI stops
them from quietly rotting into a no-op.

Point it at a clone somewhere other than the default with `RACI_REPO=/path/to/racing`.

### Why a tray icon rather than a Plasma applet

A plasmoid would sit in the panel directly instead of behind the tray's chevron, which is genuinely
nicer. It is also QML against an API that changed shape between Plasma 5 and 6, and Kubuntu 24.04
LTS is still on 5 while 25.x is on 6. A `QSystemTrayIcon` is one implementation that works on both,
and the cost is the one-time "set it to Shown" above.
