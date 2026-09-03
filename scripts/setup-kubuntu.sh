#!/usr/bin/env bash
#
# Set up the ASIC RACI Tool on a Kubuntu machine, from a fresh clone to a power button in the tray.
#
#   ./scripts/setup-kubuntu.sh
#
# Written for someone who has never opened a terminal on purpose. Every step says what it is doing
# and why; nothing happens without being announced; running it twice is safe and skips whatever is
# already done. The full transcript lands in ~/.local/state/raci-tool/setup.log, which is the first
# thing to look at when something goes wrong.
#
#   --yes            do not stop to confirm
#   --no-seed        skip loading the demo workspace
#   --no-autostart   do not start the power button when you log in
#   --no-launch      do not start the power button at the end of setup
#   --uninstall      remove the power button and shut the stack down (keeps Docker and Node)
#
set -Eeuo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}/raci-tool"
LOG="$STATE_HOME/setup.log"
DESKTOP_ID="raci-tool"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"

ASSUME_YES=0
DO_SEED=1
DO_AUTOSTART=1
DO_LAUNCH=1
DO_UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y)       ASSUME_YES=1 ;;
    --no-seed)      DO_SEED=0 ;;
    --no-autostart) DO_AUTOSTART=0 ;;
    --no-launch)    DO_LAUNCH=0 ;;
    --uninstall)    DO_UNINSTALL=1 ;;
    # The header comment above IS the help text, so the two can never drift apart. Printed up to
    # the first line that is not a comment, rather than a line range that goes stale on every edit.
    -h|--help)      awk 'NR==1{next} /^#/{sub(/^# ?/, ""); print; next} {exit}' "$0"; exit 0 ;;
    *)              echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# ---- talking to a human ----------------------------------------------------------------------

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; OFF=""
fi

STEP_NO=0
step()  { STEP_NO=$((STEP_NO + 1)); printf '\n%s[%d/%d] %s%s\n' "$BOLD" "$STEP_NO" "$STEP_TOTAL" "$1" "$OFF"; }
say()   { printf '      %s\n' "$1"; }
ok()    { printf '      %s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
skip()  { printf '      %s· %s%s\n' "$DIM" "$1" "$OFF"; }
warn()  { printf '      %s! %s%s\n' "$YELLOW" "$1" "$OFF"; }

die() {
  printf '\n%s✗ %s%s\n' "$RED" "$1" "$OFF" >&2
  [[ -n "${2:-}" ]] && printf '  %s\n' "$2" >&2
  printf '\n  The full transcript is in %s\n' "$LOG" >&2
  exit 1
}

trap 'die "Setup stopped at line $LINENO." "The last few lines above say what was running."' ERR

mkdir -p "$STATE_HOME"
exec > >(tee -a "$LOG") 2>&1
printf '\n===== %s =====\n' "$(date '+%Y-%m-%d %H:%M:%S')"

# ---- preflight -------------------------------------------------------------------------------

[[ $EUID -ne 0 ]] || die "Do not run this with sudo." \
  "Run it as yourself: ./scripts/setup-kubuntu.sh — it will ask for your password when it needs to."

[[ -f "$REPO/docker-compose.yml" && -f "$REPO/pnpm-workspace.yaml" ]] || die \
  "This does not look like the RACI Tool project folder." "Looked in: $REPO"

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${ID_LIKE:-}" in
    *ubuntu*|*debian*) : ;;
    *) warn "This is written for Kubuntu. ${PRETTY_NAME:-This system} may need different steps." ;;
  esac
fi

STEP_TOTAL=9
[[ $DO_UNINSTALL -eq 1 ]] && STEP_TOTAL=2

# ---- running docker before the group has taken effect -----------------------------------------

# `usermod -aG docker` is real the moment it runs, but no already-running session knows about it —
# including the desktop session you are sitting in. `sg` starts a shell that does, so setup can
# finish without a logout. (raci_service.py does the same thing for the same reason.)
DOCKER_NEEDS_SG=0

shquote() {
  local out=() arg
  for arg in "$@"; do out+=("'${arg//\'/\'\\\'\'}'"); done
  printf '%s' "${out[*]}"
}

d() {
  if [[ $DOCKER_NEEDS_SG -eq 1 ]]; then
    sg docker -c "docker $(shquote "$@")"
  else
    docker "$@"
  fi
}

# ---- uninstall --------------------------------------------------------------------------------

if [[ $DO_UNINSTALL -eq 1 ]]; then
  step "Switching everything off"
  # The tray records its own pid in the lock file it holds, so this kills exactly that process
  # rather than pattern-matching command lines and hoping.
  tray_pid="$(cat "$STATE_HOME/tray.lock" 2>/dev/null || true)"
  if [[ -n "$tray_pid" ]] && kill "$tray_pid" 2>/dev/null; then
    ok "Closed the power button"
  else
    skip "The power button was not running"
  fi
  if command -v docker >/dev/null 2>&1; then
    docker info >/dev/null 2>&1 || DOCKER_NEEDS_SG=1
    (cd "$REPO" && d compose stop) && ok "Stopped the database and sign-in server"
  fi

  step "Removing the power button"
  rm -f "$APPS_DIR/$DESKTOP_ID.desktop" "$AUTOSTART_DIR/$DESKTOP_ID.desktop"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" 2>/dev/null || true
  ok "Removed"
  printf '\n%sDone.%s Docker, Node and the project folder were left alone.\n' "$BOLD" "$OFF"
  printf 'Your data is still in the Docker volume; run setup again to pick up where you left off.\n\n'
  exit 0
fi

# ---- consent ----------------------------------------------------------------------------------

cat <<BANNER

  ${BOLD}ASIC RACI Tool — setup${OFF}

  This will install what the tool needs and put a power button in your system tray.
  It takes about ten minutes the first time, mostly downloading.

    · Node 22 and pnpm      — runs the app
    · Docker                — runs the database and the sign-in server
    · PyQt                  — draws the power button
    · The demo workspace    — so there is something to look at

  It will ask for your password, because installing software needs it.
  Nothing leaves this machine. Project folder: ${REPO}

BANNER

if [[ $ASSUME_YES -eq 0 ]]; then
  read -r -p "  Go ahead? [Y/n] " reply < /dev/tty || reply="n"
  case "${reply:-y}" in
    [Yy]*|"") : ;;
    *) echo "  Nothing was changed."; exit 0 ;;
  esac
fi

sudo -v || die "Could not get administrator rights." "Setup cannot install anything without them."
# Keep the sudo timestamp warm; pnpm install can outlast the default five minutes.
( while true; do sudo -n true; sleep 50; kill -0 "$$" 2>/dev/null || exit; done ) 2>/dev/null &
SUDO_KEEPALIVE=$!
trap 'kill "$SUDO_KEEPALIVE" 2>/dev/null || true' EXIT

apt_install() { sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" >/dev/null; }

# ---- 1. base packages --------------------------------------------------------------------------

step "Refreshing the software list"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
apt_install ca-certificates curl gnupg git
ok "Ready to install"

# ---- 2. node -----------------------------------------------------------------------------------

step "Node 22"
node_major() {
  if command -v node >/dev/null 2>&1; then node -v 2>/dev/null | sed 's/^v//; s/\..*//'; else echo 0; fi
}
if [[ "$(node_major)" -ge 22 ]]; then
  skip "Already have Node $(node -v)"
else
  say "Adding the official Node repository…"
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    sudo gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg
  sudo chmod a+r /etc/apt/keyrings/nodesource.gpg
  # 'nodistro' is NodeSource's own suite: one repository for every Ubuntu release, so this does not
  # break the week a new Kubuntu comes out.
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" |
    sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  apt_install nodejs
  [[ "$(node_major)" -ge 22 ]] || die "Node 22 did not install." "Check the transcript for apt errors."
  ok "Installed Node $(node -v)"
fi

# ---- 3. pnpm -----------------------------------------------------------------------------------

step "pnpm"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if command -v corepack >/dev/null 2>&1; then
  sudo corepack enable >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || true
fi
if (cd "$REPO" && pnpm --version >/dev/null 2>&1); then
  ok "pnpm $(cd "$REPO" && pnpm --version)"
else
  say "Installing pnpm directly…"
  sudo npm install -g pnpm@9 >/dev/null
  (cd "$REPO" && pnpm --version >/dev/null 2>&1) || die "pnpm did not install."
  ok "pnpm $(cd "$REPO" && pnpm --version)"
fi

# ---- 4. docker ---------------------------------------------------------------------------------

step "Docker"
if docker compose version >/dev/null 2>&1 || sg docker -c 'docker compose version' >/dev/null 2>&1; then
  skip "Already have Docker with compose"
elif apt-cache show docker-compose-v2 >/dev/null 2>&1; then
  # Kubuntu 24.04 and later carry both, and its own packages are the least surprising thing to
  # install on someone's machine.
  say "Installing Docker from the Kubuntu archive…"
  apt_install docker.io docker-compose-v2
  ok "Installed"
else
  say "Installing Docker from Docker's own repository…"
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
    sudo gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $codename stable" |
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  apt_install docker-ce docker-ce-cli containerd.io docker-compose-plugin
  ok "Installed"
fi

sudo systemctl enable --now docker >/dev/null 2>&1 || true

if ! id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
  say "Letting you run Docker without sudo…"
  sudo usermod -aG docker "$USER"
  ok "Added you to the docker group"
fi
docker info >/dev/null 2>&1 || DOCKER_NEEDS_SG=1
[[ $DOCKER_NEEDS_SG -eq 1 ]] && say "Using the new group for the rest of this run; it applies to everything after your next login."
d compose version >/dev/null 2>&1 || die "Docker is installed but will not run." \
  "Try: sudo systemctl status docker"

# ---- 5. the power button's toolkit --------------------------------------------------------------

step "The power button's toolkit"
# `from PyQtN import QtWidgets`, not `import PyQtN`: the outer package imports fine with none of the
# graphics libraries present, and the failure then arrives later, as a tray icon that never appears.
have_qt() {
  python3 -c 'from PyQt6 import QtWidgets' 2>/dev/null ||
    python3 -c 'from PyQt5 import QtWidgets' 2>/dev/null
}
if have_qt; then
  skip "Already have Qt for Python"
elif apt-cache show python3-pyqt6 >/dev/null 2>&1; then
  apt_install python3-pyqt6
  ok "Installed PyQt6"
else
  apt_install python3-pyqt5
  ok "Installed PyQt5"
fi
if ! have_qt; then
  # Not fatal: everything except the tray icon still works, and the app can be started by hand.
  warn "Qt installed but will not load — the power button will not appear."
  warn "Everything else is set up; you can start the app with:  cd $REPO && pnpm dev"
fi

# ---- 6. settings ---------------------------------------------------------------------------------

step "Settings"
FRESH_ENV=0
if [[ ! -f "$REPO/.env" ]]; then
  cp "$REPO/.env.example" "$REPO/.env"
  FRESH_ENV=1
  ok "Created .env from the example"
else
  skip ".env already exists — leaving your settings alone"
fi

# Done in python rather than sed on two counts: a base64 secret is full of / and + characters, and
# an existing .env must only ever have the insecure placeholder replaced, never its real settings.
python3 - "$REPO/.env" "$FRESH_ENV" <<'SETTINGS'
import base64, os, re, sys

path, fresh = sys.argv[1], sys.argv[2] == "1"
placeholder = "dev-only-session-secret-change-me-in-every-real-deployment"
text = open(path).read()
notes = []

if placeholder in text:
    text = text.replace(placeholder, base64.b64encode(os.urandom(32)).decode())
    notes.append(("ok", "Generated a session secret for this machine"))
else:
    notes.append(("skip", "Session secret already set"))

if fresh:
    # The example points at the OpenLDAP in the dev stack, which is there for building the directory
    # adapter. On a desktop install nothing talks to it, so leaving it on means a health check that
    # reports failure forever and a nightly sync against a server that was never started.
    text = re.sub(r"^DIRECTORY_PROVIDER=.*$", "DIRECTORY_PROVIDER=none", text, flags=re.M)
    text = re.sub(r"^DIRECTORY_SYNC_CRON=.*$", "DIRECTORY_SYNC_CRON=", text, flags=re.M)
    notes.append(("ok", "Turned off directory sync (nothing to sync with on a desktop)"))

open(path, "w").write(text)
GREEN, DIM, OFF = "\033[32m", "\033[2m", "\033[0m"
for kind, message in notes:
    print(f"      {GREEN}✓{OFF} {message}" if kind == "ok" else f"      {DIM}· {message}{OFF}")
SETTINGS

# ---- 7. the app ------------------------------------------------------------------------------------

step "Building the app"
say "Downloading dependencies — this is the slow part…"
(cd "$REPO" && pnpm install --frozen-lockfile)
(cd "$REPO" && pnpm build)
ok "Built"

# ---- 8. the database ---------------------------------------------------------------------------

step "Starting the database and sign-in server"
(cd "$REPO" && d compose up -d postgres keycloak)

say "Waiting for the database to finish setting itself up…"
# `select 1` against the real database, not pg_isready: pg_isready answers yes partway through
# initdb, while the raci database still does not exist and the migration is about to discover it.
ready=0
for _ in $(seq 1 90); do
  if (cd "$REPO" && d compose exec -T postgres psql -U raci -d raci -tAc 'select 1') >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 2
done
[[ $ready -eq 1 ]] || die "The database did not come up." "Try: cd $REPO && docker compose logs postgres"
ok "Database is up"

(cd "$REPO" && pnpm db:migrate >/dev/null)
ok "Database schema is current"

if [[ $DO_SEED -eq 1 ]]; then
  (cd "$REPO" && node apps/web/scripts/seed-demo.mjs) || warn "Could not load the demo workspace — the app still works, it will just be empty."
fi

# ---- 9. the power button -------------------------------------------------------------------------

step "The power button"
mkdir -p "$APPS_DIR"
write_desktop_entry() {
  cat > "$1" <<ENTRY
[Desktop Entry]
Type=Application
Version=1.0
Name=ASIC RACI Tool
GenericName=RACI charts
Comment=Turn the RACI Tool on and off
Exec="$REPO/ops/desktop/raci-tray"
Icon=$REPO/ops/desktop/raci-power.svg
Terminal=false
Categories=Office;ProjectManagement;
Keywords=RACI;chart;ASIC;
StartupNotify=false
X-GNOME-Autostart-enabled=true
ENTRY
}
write_desktop_entry "$APPS_DIR/$DESKTOP_ID.desktop"
chmod +x "$APPS_DIR/$DESKTOP_ID.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" 2>/dev/null || true
ok "Added to your application menu"

if [[ $DO_AUTOSTART -eq 1 ]]; then
  mkdir -p "$AUTOSTART_DIR"
  write_desktop_entry "$AUTOSTART_DIR/$DESKTOP_ID.desktop"
  ok "It will be there every time you log in"
else
  skip "Not adding it to login (--no-autostart)"
fi

if [[ $DO_LAUNCH -eq 1 && -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
  setsid "$REPO/ops/desktop/raci-tray" >/dev/null 2>&1 < /dev/null &
  ok "Started it — look in the system tray"
fi

# ---- what now -------------------------------------------------------------------------------------

cat <<DONE

  ${BOLD}${GREEN}Done.${OFF}

  There is now a ${BOLD}power button${OFF} in your system tray, at the end of the taskbar.

    1. Click it once.  It turns everything on and opens your browser. First time takes a minute.
    2. Sign in with    ${BOLD}admin.user${OFF}   password: ${BOLD}password${OFF}
    3. Click it again when you are finished, to switch everything off.

  ${DIM}Grey = off · amber = starting · green = on${OFF}

  ${BOLD}Cannot see it?${OFF}  KDE hides new tray icons until you say otherwise.
    Click the small ${BOLD}^${OFF} arrow at the left of the tray to find it, then:
    right-click the taskbar → Configure System Tray → Entries → set
    "ASIC RACI Tool" to ${BOLD}Shown${OFF}.

  ${DIM}Log: $LOG
  Undo all of this: ./scripts/setup-kubuntu.sh --uninstall${OFF}

DONE
