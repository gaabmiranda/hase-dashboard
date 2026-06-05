#!/bin/bash
# ============================================================
#  Deploy Dashboard HASE — VPS Hostinger
#  Não interfere com Chatwoot nem n8n
# ============================================================

set -e

# ┌─────────────────────────────────────────────────────────┐
# │  CONFIGURE AQUI ANTES DE RODAR                          │
# └─────────────────────────────────────────────────────────┘
DOMAIN="dash.haseengenharia.com.br"   # subdomínio desejado
EMAIL="contato@haseengenharia.com.br" # e-mail para o SSL
PORT=3099                              # porta interna (não conflita com nada)
APP_DIR="/opt/hase-dash"
SERVICE="hase-dash"
# ──────────────────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "${GREEN}  ✔ $1${NC}"; }
info() { echo -e "${YELLOW}  → $1${NC}"; }
err()  { echo -e "${RED}  ✖ $1${NC}"; exit 1; }

echo ""
echo "======================================================"
echo "   Dashboard HASE — Deploy no VPS"
echo "   Domínio : $DOMAIN"
echo "   Porta   : $PORT (interna, não exposta)"
echo "   Pasta   : $APP_DIR"
echo "======================================================"
echo ""

# ── Verifica se está rodando como root ─────────────────────
[ "$EUID" -ne 0 ] && err "Execute como root: sudo bash deploy.sh"

# ── Verifica se o domínio foi preenchido ───────────────────
[ "$DOMAIN" = "dash.haseengenharia.com.br" ] || [ -z "$DOMAIN" ] && {
  info "Domínio atual: $DOMAIN"
  read -p "  Confirma esse domínio? (s/n) " confirm
  [ "$confirm" != "s" ] && err "Edite a variável DOMAIN no início do script e rode novamente."
}

# ── 1. Verifica porta livre ────────────────────────────────
echo "[1/7] Verificando porta $PORT..."
if lsof -i :$PORT &>/dev/null; then
  err "Porta $PORT já está em uso! Mude a variável PORT no script."
fi
ok "Porta $PORT disponível"

# ── 2. Node.js ────────────────────────────────────────────
echo ""
echo "[2/7] Verificando Node.js..."
if ! command -v node &>/dev/null; then
  info "Instalando Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs -q
  ok "Node.js instalado: $(node --version)"
else
  ok "Node.js já presente: $(node --version)"
fi

# ── 3. PM2 ────────────────────────────────────────────────
echo ""
echo "[3/7] Verificando PM2..."
if ! command -v pm2 &>/dev/null; then
  info "Instalando PM2..."
  npm install -g pm2 -q
  ok "PM2 instalado"
else
  ok "PM2 já presente: $(pm2 --version)"
fi

# ── 4. Arquivos do dashboard ───────────────────────────────
echo ""
echo "[4/7] Copiando arquivos..."
mkdir -p "$APP_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ ! -f "$SCRIPT_DIR/dashboard.html" ] && err "dashboard.html não encontrado em $SCRIPT_DIR"
[ ! -f "$SCRIPT_DIR/server.js" ]      && err "server.js não encontrado em $SCRIPT_DIR"

cp "$SCRIPT_DIR/dashboard.html" "$APP_DIR/"
cp "$SCRIPT_DIR/server.js"      "$APP_DIR/"

# Ajusta a porta no server.js
sed -i "s/const PORT = 8080/const PORT = $PORT/" "$APP_DIR/server.js"
sed -i "s/const PORT = 3099/const PORT = $PORT/" "$APP_DIR/server.js"

ok "Arquivos copiados para $APP_DIR"

# ── 5. PM2 — inicia o serviço ─────────────────────────────
echo ""
echo "[5/7] Iniciando serviço com PM2..."

# Para o serviço se já existir (sem afetar outros)
pm2 describe "$SERVICE" &>/dev/null && {
  info "Serviço já existe — reiniciando..."
  pm2 delete "$SERVICE"
}

cd "$APP_DIR"
pm2 start server.js --name "$SERVICE"
pm2 save
ok "Serviço '$SERVICE' rodando na porta $PORT"
info "Para ver logs: pm2 logs $SERVICE"

# ── 6. Nginx ──────────────────────────────────────────────
echo ""
echo "[6/7] Configurando Nginx (novo bloco, não toca nos existentes)..."

NGINX_CONF="/etc/nginx/sites-available/$SERVICE"

cat > "$NGINX_CONF" << NGINXEOF
# Dashboard HASE — gerado automaticamente
# Não edite manualmente — use o deploy.sh para atualizar

server {
    listen 80;
    server_name $DOMAIN;

    # Segurança
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Logs separados (não mistura com outros apps)
    access_log /var/log/nginx/${SERVICE}-access.log;
    error_log  /var/log/nginx/${SERVICE}-error.log;

    location / {
        proxy_pass         http://localhost:$PORT;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 120s;
    }
}
NGINXEOF

# Ativa apenas este site
ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/$SERVICE"

# Testa sem restartar (não derruba outros sites)
nginx -t && systemctl reload nginx
ok "Nginx configurado — outros sites não foram afetados"

# ── 7. SSL ────────────────────────────────────────────────
echo ""
echo "[7/7] Configurando SSL gratuito (Let's Encrypt)..."

if ! command -v certbot &>/dev/null; then
  info "Instalando Certbot..."
  apt-get install -y certbot python3-certbot-nginx -q
fi

# Só pega certificado para ESTE domínio
certbot --nginx \
  -d "$DOMAIN" \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  --redirect

ok "SSL configurado — HTTPS ativo"

# ── Resumo ────────────────────────────────────────────────
echo ""
echo "======================================================"
echo -e "${GREEN}   ✅ Deploy concluído com sucesso!${NC}"
echo "======================================================"
echo ""
echo "   🌐 Acesse:  https://$DOMAIN"
echo "   📁 Pasta:   $APP_DIR"
echo "   🔌 Porta:   $PORT (interna)"
echo ""
echo "   Comandos úteis:"
echo "   pm2 status              → ver se está rodando"
echo "   pm2 logs $SERVICE       → ver logs em tempo real"
echo "   pm2 restart $SERVICE    → reiniciar"
echo ""
echo "   PRÓXIMO PASSO:"
echo "   Acesse https://$DOMAIN e configure o token Meta"
echo "   (botão ⚙ Token no canto superior direito)"
echo ""
