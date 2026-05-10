#!/bin/bash
# Chat System 安装脚本（Debian 11/12/13, Ubuntu 20/22）
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

INSTALL_DIR="/opt/chat-system"
CONFIG_DIR="/etc/chat-system"
CONFIG_FILE="$CONFIG_DIR/config.env"
SERVICE_NAME="chat-system"
GITHUB_REPO="https://github.com/lisi-123/Simplechat-system"

require_root() {
    if [[ $EUID -ne 0 ]]; then
        echo -e "${RED}请以 root 用户运行：sudo bash install.sh${NC}"
        exit 1
    fi
}

install_deps() {
    echo -e "${YELLOW}>> 检查依赖...${NC}"
    apt-get update -qq
    for pkg in git cron curl; do
        if ! command -v $pkg &>/dev/null; then
            apt-get install -y $pkg
        fi
    done

    if ! command -v node &>/dev/null; then
        echo "安装 Node.js 20.x..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
    fi

    if ! command -v redis-server &>/dev/null; then
        echo "安装 Redis..."
        apt-get install -y redis-server
        systemctl enable redis-server
        systemctl start redis-server
    fi
    echo -e "${GREEN}✓ 依赖就绪${NC}"
}

clone_or_update() {
    mkdir -p "$INSTALL_DIR"
    if [[ -d "$INSTALL_DIR/.git" ]]; then
        echo "更新已有代码..."
        cd "$INSTALL_DIR"
        git fetch origin
        git reset --hard origin/main
    else
        [[ "$(ls -A $INSTALL_DIR 2>/dev/null)" ]] && mv "$INSTALL_DIR" "${INSTALL_DIR}_bak_$(date +%Y%m%d%H%M%S)"
        git clone "$GITHUB_REPO" "$INSTALL_DIR"
    fi
}

get_user_config() {
    echo ""
    echo -e "${CYAN}请输入配置（直接回车使用默认值）：${NC}"
    read -p "Bot Token: " BOT_TOKEN
    while [[ -z "$BOT_TOKEN" ]]; do read -p "Bot Token 不能为空: " BOT_TOKEN; done

    read -p "Chat ID (群组ID): " CHAT_ID
    while [[ -z "$CHAT_ID" ]]; do read -p "Chat ID 不能为空: " CHAT_ID; done

    read -p "端口 [3000]: " PORT; PORT=${PORT:-3000}
    read -p "最大文件大小(MB) [50]: " MAX_FILE_SIZE_MB; MAX_FILE_SIZE_MB=${MAX_FILE_SIZE_MB:-50}
    read -p "用户过期天数 [30]: " EXPIRE_DAYS; EXPIRE_DAYS=${EXPIRE_DAYS:-30}
    read -p "防刷阈值(条/分) [20]: " RATE_LIMIT_COUNT; RATE_LIMIT_COUNT=${RATE_LIMIT_COUNT:-20}
    read -p "拉黑时长(小时) [48]: " RATE_LIMIT_BAN_HOURS; RATE_LIMIT_BAN_HOURS=${RATE_LIMIT_BAN_HOURS:-48}
}

generate_webhook_secret() {
    WEBHOOK_SECRET=$(openssl rand -hex 16)
    echo -e "${GREEN}Webhook 密钥已生成${NC}"
}

# 直接修改 config.js 文件，不再依赖环境变量
patch_config_js() {
    echo -e "${YELLOW}>> 写入配置到 config.js...${NC}"
    cd "$INSTALL_DIR"
    sed -i "s|\"YOUR_BOT_TOKEN\"|\"$BOT_TOKEN\"|" config.js
    sed -i "s|\"YOUR_CHAT_ID\"|\"$CHAT_ID\"|" config.js
    sed -i "s|EXPIRE_DAYS: 30|EXPIRE_DAYS: $EXPIRE_DAYS|" config.js
    sed -i "s|PORT: 3000|PORT: $PORT|" config.js
    sed -i "s|MAX_FILE_SIZE: 50 \* 1024 \* 1024|MAX_FILE_SIZE: ${MAX_FILE_SIZE_MB} * 1024 * 1024|" config.js
    sed -i "s|RATE_LIMIT_COUNT: 20|RATE_LIMIT_COUNT: $RATE_LIMIT_COUNT|" config.js
    sed -i "s|RATE_LIMIT_BAN_HOURS: 48|RATE_LIMIT_BAN_HOURS: $RATE_LIMIT_BAN_HOURS|" config.js
    sed -i "s|\"YOUR_MONITOR_TOPIC_ID\"|\"$TOPIC_ID\"|" config.js
    sed -i "s|\"YOUR_WEBHOOK_SECRET\"|\"$WEBHOOK_SECRET\"|" config.js
    # DOMAIN 初始为空，之后由 setup_webhook 或管理面板填入
    echo -e "${GREEN}✓ config.js 已更新${NC}"
}

# 仍然保存一份 config.env 给 monitor.sh 和 deploy.sh 自己用
save_config_env() {
    echo -e "${YELLOW}>> 保存 shell 配置...${NC}"
    mkdir -p "$CONFIG_DIR"
    cat > "$CONFIG_FILE" << EOF
BOT_TOKEN="$BOT_TOKEN"
CHAT_ID="$CHAT_ID"
EXPIRE_DAYS=$EXPIRE_DAYS
PORT=$PORT
MAX_FILE_SIZE_MB=$MAX_FILE_SIZE_MB
RATE_LIMIT_COUNT=${RATE_LIMIT_COUNT}
RATE_LIMIT_BAN_HOURS=${RATE_LIMIT_BAN_HOURS}
MONITOR_TOPIC_ID="$TOPIC_ID"
WEBHOOK_SECRET="$WEBHOOK_SECRET"
DOMAIN=""
EOF
    echo -e "${GREEN}✓ config.env 已保存${NC}"
}

install_npm() {
    echo -e "${YELLOW}>> 安装 npm 依赖...${NC}"
    cd "$INSTALL_DIR"
    npm install
    npm install geoip-lite --save
    echo -e "${GREEN}✓ npm 依赖就绪${NC}"
}

setup_systemd() {
    cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=Chat System Service
After=network.target redis-server.service
Wants=redis-server.service

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable ${SERVICE_NAME}
    systemctl start ${SERVICE_NAME}
    sleep 2
    if systemctl is-active --quiet ${SERVICE_NAME}; then
        echo -e "${GREEN}✓ 服务已启动${NC}"
    else
        echo -e "${RED}✗ 服务启动失败，请检查日志：journalctl -u ${SERVICE_NAME} -n 20${NC}"
    fi
}

setup_webhook() {
    echo ""
    read -p "请输入你的域名（例如chat.example.com，必填）： " DOMAIN
    if [[ -z "$DOMAIN" ]]; then
        echo -e "${YELLOW}跳过 Webhook 设置，稍后可手动配置${NC}"
        return
    fi
    WEBHOOK_URL="https://${DOMAIN}/telegram-webhook"
    echo -e "${CYAN}正在设置 Webhook（含密钥验证）...${NC}"
    RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
        -d "url=${WEBHOOK_URL}" \
        -d "secret_token=${WEBHOOK_SECRET}")
    if echo "$RESPONSE" | grep -q '"ok":true'; then
        echo -e "${GREEN}✓ Webhook 设置成功: ${WEBHOOK_URL}${NC}"
        # 更新 config.js 中的 WEBHOOK_URL
        sed -i "s|DOMAIN: \".*\"|DOMAIN: \"${DOMAIN}\"|" "$INSTALL_DIR/config.js"
        # 同时更新 config.env
        sed -i "s|^DOMAIN=.*|DOMAIN=\"${DOMAIN}\"|" "$CONFIG_FILE"
    else
        echo -e "${RED}✗ Webhook 设置失败：$RESPONSE${NC}"
    fi
    echo -e "${YELLOW}请到 Cloudflare 将域名回源到本机 ${PORT} 端口${NC}"
}

install_chat_cmd() {
    cat > /usr/local/bin/chat << 'EOF'
#!/bin/bash
[[ ! -f /opt/chat-system/deploy.sh ]] && echo "Chat System 未安装，请先运行安装脚本" && exit 1
[[ $EUID -ne 0 ]] && exec sudo bash /opt/chat-system/deploy.sh "$@"
exec bash /opt/chat-system/deploy.sh "$@"
EOF
    chmod +x /usr/local/bin/chat
    echo -e "${GREEN}✓ 快捷命令 'chat' 已就绪${NC}"
}

setup_monitor() {
    # 通过菜单启用监控
    echo -e "11\n1\n0" | sudo chat
}

show_finish() {
    echo ""
    echo -e "${GREEN}================================${NC}"
    echo -e "${GREEN}  Chat System 安装成功！${NC}"
    echo -e "${GREEN}================================${NC}"
    echo -e "管理面板：${CYAN}chat${NC}"
    echo -e "服务状态：${CYAN}systemctl status ${SERVICE_NAME}${NC}"
    echo -e "上传目录：${CYAN}${INSTALL_DIR}/public/uploads${NC}"
    echo -e "Webhook 密钥：${CYAN}${WEBHOOK_SECRET}${NC} （请勿泄露）"
    echo -e "${GREEN}================================${NC}"
}

# ---------- 主流程 ----------
require_root
install_deps
clone_or_update
get_user_config
generate_webhook_secret
patch_config_js
save_config_env
install_npm
setup_systemd
setup_webhook
install_chat_cmd
setup_monitor
show_finish
