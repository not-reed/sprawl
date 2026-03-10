#!/usr/bin/env bash
set -euo pipefail

# Setup script for Construct on a fresh server.
# Supports two modes:
#   ./setup.sh docker   — Docker Compose (recommended)
#   ./setup.sh systemd  — Bare metal with systemd

MODE="${1:-docker}"
REPO_URL="https://github.com/0xreed/nullclaw-ts.git"
INSTALL_DIR="/opt/construct"

# --- Helpers ---

info()  { printf '\033[1;34m=>\033[0m %s\n' "$*"; }
error() { printf '\033[1;31m=>\033[0m %s\n' "$*" >&2; exit 1; }

check_root() {
  [[ $EUID -eq 0 ]] || error "Run this script as root (or with sudo)"
}

# --- Shared ---

clone_repo() {
  if [[ -d "$INSTALL_DIR" ]]; then
    info "Repo already exists at $INSTALL_DIR, pulling latest"
    git -C "$INSTALL_DIR" pull --ff-only
  else
    info "Cloning repository to $INSTALL_DIR"
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
}

create_env_template() {
  local dest="$1"
  if [[ -f "$dest" ]]; then
    info ".env already exists at $dest, skipping"
    return
  fi
  info "Creating .env template at $dest"
  cat > "$dest" <<'EOF'
# Required
OPENROUTER_API_KEY=
TELEGRAM_BOT_TOKEN=

# Optional
# OPENROUTER_MODEL=google/gemini-3-flash-preview
# ALLOWED_TELEGRAM_IDS=
# TAVILY_API_KEY=
# TIMEZONE=UTC
# EMBEDDING_MODEL=qwen/qwen3-embedding-4b
# MEMORY_WORKER_MODEL=
EOF
  chmod 600 "$dest"
}

install_backup_cron() {
  local backup_dir="/backups/construct"
  local cron_file="/etc/cron.daily/construct-backup"

  mkdir -p "$backup_dir"

  if [[ -f "$cron_file" ]]; then
    info "Backup cron already exists"
    return
  fi

  info "Installing daily SQLite backup cron"
  cat > "$cron_file" <<'CRON'
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/backups/construct"
DATE=$(date +%F)

# Docker mode
DB="/opt/construct/deploy/data/construct.db"
[[ -f "$DB" ]] && sqlite3 "$DB" ".backup $BACKUP_DIR/docker-${DATE}.db"

# Systemd mode
DB="/home/construct/.construct/construct.db"
[[ -f "$DB" ]] && sqlite3 "$DB" ".backup $BACKUP_DIR/systemd-${DATE}.db"

# Prune backups older than 7 days
find "$BACKUP_DIR" -name '*.db' -mtime +7 -delete
CRON
  chmod +x "$cron_file"
}

# --- Docker mode ---

setup_docker() {
  info "Setting up Docker deployment"

  if ! command -v docker &>/dev/null; then
    info "Installing Docker"
    curl -fsSL https://get.docker.com | sh
  fi

  clone_repo

  local deploy_dir="$INSTALL_DIR/deploy"
  mkdir -p "$deploy_dir/data"

  create_env_template "$deploy_dir/.env"
  install_backup_cron

  info ""
  info "Docker setup complete!"
  info ""
  info "Next steps:"
  info "  1. Edit $deploy_dir/.env with your API keys"
  info "  2. cd $deploy_dir && docker compose up -d --build"
  info ""
  info "Useful commands:"
  info "  docker compose -f $deploy_dir/docker-compose.yml logs -f"
  info "  docker compose -f $deploy_dir/docker-compose.yml restart"
}

# --- Systemd mode ---

setup_systemd() {
  info "Setting up systemd deployment"

  local SERVICE_USER="construct"
  local DATA_DIR="/home/$SERVICE_USER/.construct"

  if id "$SERVICE_USER" &>/dev/null; then
    info "User '$SERVICE_USER' already exists"
  else
    info "Creating user '$SERVICE_USER'"
    useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi

  clone_repo
  chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

  info "Installing dependencies"
  cd "$INSTALL_DIR"
  sudo -u "$SERVICE_USER" corepack enable pnpm
  sudo -u "$SERVICE_USER" pnpm install

  sudo -u "$SERVICE_USER" mkdir -p \
    "$DATA_DIR" \
    "$DATA_DIR/extensions/skills" \
    "$DATA_DIR/extensions/tools"

  create_env_template "$DATA_DIR/.env"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

  info "Installing systemd service"
  cp "$INSTALL_DIR/deploy/construct.service" /etc/systemd/system/construct.service
  systemctl daemon-reload

  local sudoers_file="/etc/sudoers.d/construct"
  if [[ ! -f "$sudoers_file" ]]; then
    info "Adding sudoers rules"
    cat > "$sudoers_file" <<EOF
${SERVICE_USER} ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart construct, /usr/bin/systemctl is-active construct
EOF
    chmod 440 "$sudoers_file"
  fi

  install_backup_cron

  info ""
  info "Systemd setup complete!"
  info ""
  info "Next steps:"
  info "  1. Edit $DATA_DIR/.env with your API keys"
  info "  2. sudo systemctl enable --now construct"
  info ""
  info "Useful commands:"
  info "  journalctl -u construct -f"
  info "  sudo systemctl status construct"
}

# --- Main ---

main() {
  check_root

  case "$MODE" in
    docker)  setup_docker ;;
    systemd) setup_systemd ;;
    *)       error "Usage: $0 [docker|systemd]" ;;
  esac
}

main "$@"
