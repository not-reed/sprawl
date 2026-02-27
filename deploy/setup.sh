#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/construct"
SERVICE_USER="construct"
DATA_DIR="/home/${SERVICE_USER}/.construct"

# --- Helpers ---

info()  { printf '\033[1;34m=>\033[0m %s\n' "$*"; }
error() { printf '\033[1;31m=>\033[0m %s\n' "$*" >&2; exit 1; }

check_root() {
  [[ $EUID -eq 0 ]] || error "Run this script as root (or with sudo)"
}

# --- Steps ---

create_user() {
  if id "$SERVICE_USER" &>/dev/null; then
    info "User '$SERVICE_USER' already exists"
  else
    info "Creating user '$SERVICE_USER'"
    useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
}

setup_install_dir() {
  if [[ -d "$INSTALL_DIR" ]]; then
    info "Install directory already exists at $INSTALL_DIR"
  else
    info "Cloning repository to $INSTALL_DIR"
    git clone https://github.com/0xreed/construct.git "$INSTALL_DIR"
  fi

  chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
}

install_deps() {
  info "Installing dependencies"
  cd "$INSTALL_DIR"
  sudo -u "$SERVICE_USER" npm install --production=false
}

setup_data_dir() {
  info "Setting up data directory at $DATA_DIR"
  sudo -u "$SERVICE_USER" mkdir -p \
    "$DATA_DIR" \
    "$DATA_DIR/extensions/skills" \
    "$DATA_DIR/extensions/tools"

  if [[ ! -f "$DATA_DIR/.env" ]]; then
    info "Creating .env template"
    cat > "$DATA_DIR/.env" <<'EOF'
# Required
OPENROUTER_API_KEY=
TELEGRAM_BOT_TOKEN=

# Optional
# OPENROUTER_MODEL=google/gemini-3-flash-preview
# ALLOWED_TELEGRAM_IDS=
# TAVILY_API_KEY=
# TIMEZONE=UTC
EOF
    chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR/.env"
    chmod 600 "$DATA_DIR/.env"
  else
    info ".env already exists, skipping"
  fi
}

install_service() {
  info "Installing systemd service"
  cp "$INSTALL_DIR/deploy/construct.service" /etc/systemd/system/construct.service
  systemctl daemon-reload
}

setup_sudoers() {
  local sudoers_file="/etc/sudoers.d/construct"
  if [[ -f "$sudoers_file" ]]; then
    info "Sudoers rule already exists"
  else
    info "Adding sudoers rule for systemctl restart/is-active"
    cat > "$sudoers_file" <<EOF
${SERVICE_USER} ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart construct, /usr/bin/systemctl is-active construct
EOF
    chmod 440 "$sudoers_file"
  fi
}

run_migrations() {
  info "Running database migrations"
  cd "$INSTALL_DIR"
  sudo -u "$SERVICE_USER" node --env-file="$DATA_DIR/.env" --import=tsx src/db/migrate.ts
}

enable_service() {
  info "Enabling and starting service"
  systemctl enable construct
  systemctl start construct
}

# --- Main ---

main() {
  check_root
  create_user
  setup_install_dir
  install_deps
  setup_data_dir
  install_service
  setup_sudoers
  run_migrations
  enable_service

  echo
  info "Setup complete!"
  info "Edit $DATA_DIR/.env with your API keys, then:"
  info "  sudo systemctl restart construct"
  echo
  info "Useful commands:"
  info "  sudo systemctl status construct"
  info "  sudo journalctl -u construct -f"
  info "  tail -f $DATA_DIR/construct.log"
}

main "$@"
