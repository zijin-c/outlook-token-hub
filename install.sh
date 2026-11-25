#!/usr/bin/env bash
set -e

REPO_URL="https://github.com/zijin-c/outlook-token-hub.git"
INSTALL_DIR="/opt/outlook-token-hub"
SERVICE_NAME="outlook-token-hub"
PORT="${PORT:-18742}"

echo "=========================================="
echo "  Outlook Hub 一键安装 / 更新脚本"
echo "=========================================="

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 用户或 sudo 运行此脚本"
  exit 1
fi

# 1. Install curl & git if needed
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y curl git ca-certificates gnupg
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y curl git ca-certificates
elif command -v yum >/dev/null 2>&1; then
  yum install -y curl git ca-certificates
fi

# 2. Install Node.js 22 if missing or < 18
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 18 ]; then
    NEED_NODE=0
    echo "[OK] 检测到 Node.js $(node -v)"
  fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
  echo "[*] 正在安装 Node.js 22 LTS..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    (dnf install -y nodejs || yum install -y nodejs)
  else
    echo "不支持的包管理器，请手动安装 Node.js 18+"
    exit 1
  fi
  echo "[OK] Node.js $(node -v) 安装完成"
fi

# 3. Clone or update repository
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "[*] 检测到已安装，正在拉取最新代码（保留 data 数据）..."
  cd "$INSTALL_DIR"
  git pull --ff-only origin main
else
  echo "[*] 正在克隆仓库到 $INSTALL_DIR ..."
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# 4. Install dependencies
echo "[*] 正在安装依赖..."
npm install --omit=dev --no-audit --no-fund
mkdir -p "$INSTALL_DIR/data"

# 5. Create systemd service
echo "[*] 正在配置 systemd 后台服务..."
NODE_BIN=$(command -v node)

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Outlook Token Hub (OAuth2 Mail Fetcher & Auto Keep-Alive)
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=TZ=Asia/Shanghai

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

# 6. Open firewall port if active
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

SERVER_IP=$(curl -fsSL --max-time 4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo "=========================================="
echo "  Outlook Hub 部署成功！"
echo "  访问地址: http://${SERVER_IP}:${PORT}"
echo "  数据目录: ${INSTALL_DIR}/data/db.json"
echo "------------------------------------------"
echo "  常用命令:"
echo "    查看状态: systemctl status ${SERVICE_NAME}"
echo "    查看日志: journalctl -u ${SERVICE_NAME} -f"
echo "    重启服务: systemctl restart ${SERVICE_NAME}"
echo "    更新版本: 重新运行本一键脚本即可（数据不丢失）"
echo "=========================================="
