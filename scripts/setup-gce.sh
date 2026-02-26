#!/usr/bin/env bash
# =============================================================================
# setup-gce.sh — One-time setup cho GCE instance
#
# Chạy một lần duy nhất SAU KHI tạo GCE VM:
#   chmod +x scripts/setup-gce.sh
#   ./scripts/setup-gce.sh
#
# Script này sẽ cài:
#   1. Docker
#   2. Nginx + Certbot
#   3. GitHub Actions self-hosted runner
#   4. Cấu hình Nginx + SSL
# =============================================================================

set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
section() { echo -e "\n${CYAN}══════════════════════════════════════${NC}"; echo -e "${CYAN}  $*${NC}"; echo -e "${CYAN}══════════════════════════════════════${NC}"; }

# ── Input ────────────────────────────────────────────────────────────────────
section "GCE Setup · gce-zero2prod"

read -rp "  Domain name (e.g. app.example.com): " APP_DOMAIN
read -rp "  GCP Project ID: "                     GCP_PROJECT_ID
read -rp "  Artifact Registry region (e.g. asia-southeast1): " GAR_LOCATION
read -rp "  GitHub repo (owner/repo): "           GITHUB_REPO
read -rp "  GitHub runner registration token: "   RUNNER_TOKEN

echo ""
info "Domain      : $APP_DOMAIN"
info "Project     : $GCP_PROJECT_ID"
info "GAR region  : $GAR_LOCATION"
info "GitHub repo : $GITHUB_REPO"
echo ""
read -rp "Continue? [y/N] " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# ─────────────────────────────────────────────────────────────────────────────
section "1. System update"
# ─────────────────────────────────────────────────────────────────────────────
sudo apt-get update -y
sudo apt-get install -y curl wget gnupg lsb-release ca-certificates
success "System updated"

# ─────────────────────────────────────────────────────────────────────────────
section "2. Docker"
# ─────────────────────────────────────────────────────────────────────────────
if command -v docker &>/dev/null; then
  warn "Docker already installed: $(docker --version)"
else
  # Official Docker install
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/debian $(lsb_release -cs) stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io
fi

sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
success "Docker ready"

# ─────────────────────────────────────────────────────────────────────────────
section "3. Nginx + Certbot"
# ─────────────────────────────────────────────────────────────────────────────
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx
success "Nginx ready"

# ─────────────────────────────────────────────────────────────────────────────
section "4. Deploy Nginx config"
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NGINX_CONF="$SCRIPT_DIR/../nginx/app.conf"

if [[ ! -f "$NGINX_CONF" ]]; then
  error "nginx/app.conf not found at $NGINX_CONF"
fi

# Copy & substitute domain
sudo cp "$NGINX_CONF" /etc/nginx/sites-available/gce-zero2prod
sudo sed -i "s/YOUR_DOMAIN/${APP_DOMAIN}/g" /etc/nginx/sites-available/gce-zero2prod

# Enable site
sudo ln -sf /etc/nginx/sites-available/gce-zero2prod /etc/nginx/sites-enabled/gce-zero2prod
sudo rm -f /etc/nginx/sites-enabled/default

# Tạm thời comment SSL để certbot có thể verify HTTP trước
sudo sed -i 's/ssl_certificate/# ssl_certificate/g' /etc/nginx/sites-enabled/gce-zero2prod
sudo sed -i 's/include.*options-ssl/# include.options-ssl/g' /etc/nginx/sites-enabled/gce-zero2prod
sudo sed -i 's/ssl_dhparam/# ssl_dhparam/g' /etc/nginx/sites-enabled/gce-zero2prod

# Tạm thời bỏ listen 443 (chưa có cert)
sudo sed -i 's/listen 443/# listen 443/g' /etc/nginx/sites-enabled/gce-zero2prod

sudo nginx -t && sudo systemctl reload nginx
success "Nginx config deployed for $APP_DOMAIN"

# ─────────────────────────────────────────────────────────────────────────────
section "5. Certbot SSL"
# ─────────────────────────────────────────────────────────────────────────────
# Tạo thư mục webroot cho ACME challenge
sudo mkdir -p /var/www/certbot

info "Requesting SSL certificate for $APP_DOMAIN ..."
sudo certbot certonly \
  --nginx \
  --non-interactive \
  --agree-tos \
  --email "admin@${APP_DOMAIN}" \
  -d "$APP_DOMAIN"

# Bây giờ restore full SSL config
sudo cp "$NGINX_CONF" /etc/nginx/sites-available/gce-zero2prod
sudo sed -i "s/YOUR_DOMAIN/${APP_DOMAIN}/g" /etc/nginx/sites-available/gce-zero2prod
sudo ln -sf /etc/nginx/sites-available/gce-zero2prod /etc/nginx/sites-enabled/gce-zero2prod

sudo nginx -t && sudo systemctl reload nginx
success "SSL certificate installed for $APP_DOMAIN"

# Auto-renewal
sudo systemctl enable --now certbot.timer 2>/dev/null \
  || (echo "0 0,12 * * * root certbot renew --quiet" | sudo tee /etc/cron.d/certbot-renew)
success "Certbot auto-renewal configured"

# ─────────────────────────────────────────────────────────────────────────────
section "6. gcloud Docker auth for Artifact Registry"
# ─────────────────────────────────────────────────────────────────────────────
gcloud auth configure-docker "${GAR_LOCATION}-docker.pkg.dev" --quiet
success "Docker configured for Artifact Registry ($GAR_LOCATION)"

# ─────────────────────────────────────────────────────────────────────────────
section "7. GitHub Actions self-hosted runner"
# ─────────────────────────────────────────────────────────────────────────────
RUNNER_DIR="$HOME/actions-runner"
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

# Lấy phiên bản runner mới nhất
RUNNER_VERSION=$(curl -s https://api.github.com/repos/actions/runner/releases/latest \
  | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/')

info "Installing GitHub Actions runner v${RUNNER_VERSION} ..."

RUNNER_ARCHIVE="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
curl -fsSL -o "$RUNNER_ARCHIVE" \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_ARCHIVE}"
tar xzf "$RUNNER_ARCHIVE"
rm -f   "$RUNNER_ARCHIVE"

# Configure runner (labels: self-hosted,linux,x64,gce)
./config.sh \
  --url "https://github.com/${GITHUB_REPO}" \
  --token "$RUNNER_TOKEN" \
  --name "gce-runner-$(hostname)" \
  --labels "self-hosted,linux,x64,gce" \
  --work "_work" \
  --unattended

# Cài như service systemd
sudo ./svc.sh install
sudo ./svc.sh start

success "GitHub Actions runner installed and started"

# ─────────────────────────────────────────────────────────────────────────────
section "Setup complete!"
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}✓${NC} Docker      : $(docker --version)"
echo -e "  ${GREEN}✓${NC} Nginx       : $(nginx -v 2>&1)"
echo -e "  ${GREEN}✓${NC} Certbot     : $(certbot --version)"
echo -e "  ${GREEN}✓${NC} Runner      : $RUNNER_DIR (service: svc.sh)"
echo ""
echo -e "  ${YELLOW}NOTE:${NC} Log out và log in lại để docker group có hiệu lực"
echo -e "  ${YELLOW}NOTE:${NC} Đảm bảo GCE VM có IAM role:"
echo -e "         roles/artifactregistry.writer  (để push/pull)"
echo ""
echo -e "  ${CYAN}Next steps:${NC}"
echo -e "  1. Vào GitHub → Settings → Actions → Runners → verify runner online"
echo -e "  2. Set Repository Variables:"
echo -e "     GCP_PROJECT_ID = $GCP_PROJECT_ID"
echo -e "     GAR_LOCATION   = $GAR_LOCATION"
echo -e "     GAR_REPOSITORY = gce-zero2prod"
echo -e "  3. Push code → watch Actions run!"
echo ""
