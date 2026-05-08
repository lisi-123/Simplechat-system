#!/bin/bash
# Chat System 管理面板（适配硬编码 config.js）
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

INSTALL_DIR="/opt/chat-system"
CONFIG_FILE="/etc/chat-system/config.env"
SERVICE_NAME="chat-system"
GITHUB_REPO="https://github.com/lisi-123/Simplechat-system"

# 加载 shell 配置（供脚本自身用）
if [[ -f "$CONFIG_FILE" ]]; then
    source "$CONFIG_FILE"
else
    echo -e "${RED}配置文件不存在，请先运行安装脚本${NC}"
    exit 1
fi

# ---------- 工具函数 ----------
print_banner() {
    clear
    echo -e "${CYAN}"
    echo "╔══════════════════════════════════════╗"
    echo "║       Chat System 管理面板          ║"
    echo "╚══════════════════════════════════════╝"
    echo -e "${NC}"
}

success_msg() { echo -e "${GREEN}✓ $1${NC}"; }
error_msg()   { echo -e "${RED}✗ $1${NC}"; }
info_msg()    { echo -e "${CYAN}ℹ $1${NC}"; }
press_enter() { echo ""; read -p "按 Enter 返回..."; }

validate_number() {
    local val="$1"
    local field="$2"
    if [[ ! "$val" =~ ^[0-9]+$ ]] || [[ $val -eq 0 ]]; then
        error_msg "$field 必须为正整数"
        return 1
    fi
    return 0
}

# ---------- 服务控制 ----------
start_svc()   { systemctl start $SERVICE_NAME && success_msg "服务已启动" || error_msg "启动失败"; }
stop_svc()    { systemctl stop $SERVICE_NAME && success_msg "服务已停止"; }
restart_svc() { systemctl restart $SERVICE_NAME && success_msg "服务已重启" || error_msg "重启失败"; }

svc_status() {
    clear
    echo -e "${CYAN}服务状态:${NC}"
    systemctl status $SERVICE_NAME --no-pager -l | head -20
    press_enter
}

# ---------- 配置修改（直接修改 config.js 和 config.env） ----------
edit_config() {
    print_banner
    # 从 config.js 中提取当前值（通过 grep 和 sed）
    CURRENT_BOT_TOKEN=$(grep -oP 'BOT_TOKEN: "\K[^"]+' "$INSTALL_DIR/config.js")
    CURRENT_CHAT_ID=$(grep -oP 'CHAT_ID: "\K[^"]+' "$INSTALL_DIR/config.js")
    CURRENT_PORT=$(grep -oP 'PORT: \K\d+' "$INSTALL_DIR/config.js")
    CURRENT_MAX_FILE_SIZE_MB=$(( $(grep -oP 'MAX_FILE_SIZE: \K\d+' "$INSTALL_DIR/config.js") / 1024 / 1024 ))
    CURRENT_EXPIRE_DAYS=$(grep -oP 'EXPIRE_DAYS: \K\d+' "$INSTALL_DIR/config.js")
    CURRENT_RATE_LIMIT_COUNT=$(grep -oP 'RATE_LIMIT_COUNT: \K\d+' "$INSTALL_DIR/config.js")
    CURRENT_RATE_LIMIT_BAN_HOURS=$(grep -oP 'RATE_LIMIT_BAN_HOURS: \K\d+' "$INSTALL_DIR/config.js")

    echo -e "${CYAN}当前配置:${NC}"
    echo "1) Bot Token      : ${CURRENT_BOT_TOKEN:0:12}..."
    echo "2) Chat ID        : $CURRENT_CHAT_ID"
    echo "3) 端口           : $CURRENT_PORT"
    echo "4) 最大文件(MB)   : $CURRENT_MAX_FILE_SIZE_MB"
    echo "5) 过期天数       : $CURRENT_EXPIRE_DAYS"
    echo "6) 防刷阈值(条/分): $CURRENT_RATE_LIMIT_COUNT"
    echo "7) 拉黑时长(小时) : $CURRENT_RATE_LIMIT_BAN_HOURS"
    echo "8) 返回"
    read -p "选择要修改的项 [1-8]: " opt
    case $opt in
        1) read -p "新的 Bot Token: " BOT_TOKEN ;;
        2) read -p "新的 Chat ID: " CHAT_ID ;;
        3) read -p "端口: " PORT
           if ! validate_number "$PORT" "端口"; then press_enter; return; fi ;;
        4) read -p "最大文件大小(MB): " MAX_FILE_SIZE_MB
           if ! validate_number "$MAX_FILE_SIZE_MB" "文件大小"; then press_enter; return; fi ;;
        5) read -p "过期天数: " EXPIRE_DAYS
           if ! validate_number "$EXPIRE_DAYS" "过期天数"; then press_enter; return; fi ;;
        6) read -p "每分钟最大消息数: " RATE_LIMIT_COUNT
           if ! validate_number "$RATE_LIMIT_COUNT" "防刷阈值"; then press_enter; return; fi ;;
        7) read -p "拉黑时长(小时): " RATE_LIMIT_BAN_HOURS
           if ! validate_number "$RATE_LIMIT_BAN_HOURS" "拉黑时长"; then press_enter; return; fi ;;
        8) return ;;
        *) error_msg "无效选项"; press_enter; return ;;
    esac

    # 更新 config.js
    if [[ -n "$BOT_TOKEN" ]]; then
        sed -i "s|BOT_TOKEN: \"$CURRENT_BOT_TOKEN\"|BOT_TOKEN: \"$BOT_TOKEN\"|" "$INSTALL_DIR/config.js"
    fi
    if [[ -n "$CHAT_ID" ]]; then
        sed -i "s|CHAT_ID: \"$CURRENT_CHAT_ID\"|CHAT_ID: \"$CHAT_ID\"|" "$INSTALL_DIR/config.js"
    fi
    if [[ -n "$PORT" ]]; then
        sed -i "s|PORT: $CURRENT_PORT|PORT: $PORT|" "$INSTALL_DIR/config.js"
    fi
    if [[ -n "$MAX_FILE_SIZE_MB" ]]; then
        sed -i "s|MAX_FILE_SIZE: ${CURRENT_MAX_FILE_SIZE_MB} \* 1024 \* 1024|MAX_FILE_SIZE: ${MAX_FILE_SIZE_MB} * 1024 * 1024|" "$INSTALL_DIR/config.js"
    fi
    if [[ -n "$EXPIRE_DAYS" ]]; then
        sed -i "s|EXPIRE_DAYS: $CURRENT_EXPIRE_DAYS|EXPIRE_DAYS: $EXPIRE_DAYS|" "$INSTALL_DIR/config.js"
    fi
    if [[ -n "$RATE_LIMIT_COUNT" ]]; then
        sed -i "s|RATE_LIMIT_COUNT: $CURRENT_RATE_LIMIT_COUNT|RATE_LIMIT_COUNT: $RATE_LIMIT_COUNT|" "$INSTALL_DIR/config.js"
    fi
    if [[ -n "$RATE_LIMIT_BAN_HOURS" ]]; then
        sed -i "s|RATE_LIMIT_BAN_HOURS: $CURRENT_RATE_LIMIT_BAN_HOURS|RATE_LIMIT_BAN_HOURS: $RATE_LIMIT_BAN_HOURS|" "$INSTALL_DIR/config.js"
    fi

    # 同步更新 config.env（保持脚本自身读取正确）
    # 仅更新有变化的项
    [[ -n "$BOT_TOKEN" ]] && sed -i "s|^BOT_TOKEN=.*|BOT_TOKEN=\"$BOT_TOKEN\"|" "$CONFIG_FILE"
    [[ -n "$CHAT_ID" ]] && sed -i "s|^CHAT_ID=.*|CHAT_ID=\"$CHAT_ID\"|" "$CONFIG_FILE"
    [[ -n "$PORT" ]] && sed -i "s|^PORT=.*|PORT=$PORT|" "$CONFIG_FILE"
    [[ -n "$MAX_FILE_SIZE_MB" ]] && sed -i "s|^MAX_FILE_SIZE_MB=.*|MAX_FILE_SIZE_MB=$MAX_FILE_SIZE_MB|" "$CONFIG_FILE"
    [[ -n "$EXPIRE_DAYS" ]] && sed -i "s|^EXPIRE_DAYS=.*|EXPIRE_DAYS=$EXPIRE_DAYS|" "$CONFIG_FILE"
    [[ -n "$RATE_LIMIT_COUNT" ]] && sed -i "s|^RATE_LIMIT_COUNT=.*|RATE_LIMIT_COUNT=$RATE_LIMIT_COUNT|" "$CONFIG_FILE"
    [[ -n "$RATE_LIMIT_BAN_HOURS" ]] && sed -i "s|^RATE_LIMIT_BAN_HOURS=.*|RATE_LIMIT_BAN_HOURS=$RATE_LIMIT_BAN_HOURS|" "$CONFIG_FILE"

    systemctl restart $SERVICE_NAME
    success_msg "配置已更新并重启服务"
    press_enter
}

# ---------- Webhook 设置 ----------
show_webhook_info() {
    print_banner
    read -p "请输入你的域名（例如 chat.example.com）： " DOMAIN
    if [[ -z "$DOMAIN" ]]; then
        error_msg "域名不能为空"
        press_enter
        return
    fi
    WEBHOOK_URL="https://${DOMAIN}/telegram-webhook"
    echo -e "${CYAN}正在设置 Webhook（含密钥验证）...${NC}"
    RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${WEBHOOK_URL}&secret_token=${WEBHOOK_SECRET}")
    if echo "$RESPONSE" | grep -q '"ok":true'; then
        success_msg "Webhook 设置成功: ${WEBHOOK_URL}"
        # 更新 config.js 中的 WEBHOOK_URL
        sed -i "s|WEBHOOK_URL: \".*\"|WEBHOOK_URL: \"${WEBHOOK_URL}\"|" "$INSTALL_DIR/config.js"
        # 同步 config.env
        sed -i "s|^WEBHOOK_URL=.*|WEBHOOK_URL=\"${WEBHOOK_URL}\"|" "$CONFIG_FILE"
    else
        error_msg "Webhook 设置失败：$RESPONSE"
    fi
    echo -e "${YELLOW}请到 Cloudflare 将域名回源到本机 ${PORT} 端口${NC}"
    press_enter
}

# ---------- 存储管理 ----------
show_storage() {
    print_banner
    UPLOAD_DIR="$INSTALL_DIR/public/uploads"
    if [[ -d "$UPLOAD_DIR" ]]; then
        echo -e "文件总数: $(find "$UPLOAD_DIR" -type f | wc -l)"
        echo -e "占用空间: $(du -sh "$UPLOAD_DIR" | cut -f1)"
        echo -e "图片: $(find "$UPLOAD_DIR" -type f \( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" -o -iname "*.gif" -o -iname "*.webp" -o -iname "*.bmp" -o -iname "*.svg" \) | wc -l)"
        echo -e "视频: $(find "$UPLOAD_DIR" -type f \( -iname "*.mp4" -o -iname "*.webm" -o -iname "*.ogg" -o -iname "*.mov" \) | wc -l)"
        echo -e "文档: $(find "$UPLOAD_DIR" -type f \( -iname "*.pdf" -o -iname "*.doc" -o -iname "*.docx" -o -iname "*.xls" -o -iname "*.xlsx" -o -iname "*.ppt" -o -iname "*.pptx" -o -iname "*.txt" -o -iname "*.csv" -o -iname "*.zip" -o -iname "*.rar" -o -iname "*.7z" \) | wc -l)"
    else
        echo "暂无上传文件"
    fi
    press_enter
}

clear_uploads() {
    read -p "确认删除所有上传文件？(y/N) " confirm
    if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
        rm -rf "$INSTALL_DIR/public/uploads"/*
        success_msg "已清空上传目录"
    fi
    press_enter
}

# ---------- 日志 ----------
view_logs() {
    print_banner
    echo "1) 实时日志 (Ctrl+C 退出)"
    echo "2) 最近 100 行"
    echo "3) 最近 50 行错误日志"
    echo "4) 返回"
    read -p "选择: " opt
    case $opt in
        1) journalctl -u $SERVICE_NAME -f ;;
        2) journalctl -u $SERVICE_NAME -n 100 --no-pager; press_enter ;;
        3) journalctl -u $SERVICE_NAME -p 3 -n 50 --no-pager; press_enter ;;
    esac
}

# ---------- 监控管理 ----------
test_monitor() {
    source "$CONFIG_FILE"
    if [[ -z "$MONITOR_TOPIC_ID" || "$MONITOR_TOPIC_ID" == "YOUR_MONITOR_TOPIC_ID" ]]; then
        error_msg "监控话题ID未配置，请先执行“启用监控”"
        press_enter
        return
    fi

    MSG="🔔 监控测试消息 - $(date '+%Y-%m-%d %H:%M:%S')"
    RESP=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "message_thread_id=${MONITOR_TOPIC_ID}" \
        -d "text=${MSG}")
    if echo "$RESP" | grep -q '"ok":true'; then
        success_msg "第一条测试消息发送成功"
    else
        error_msg "第一条测试消息发送失败: $RESP"
    fi

    if [[ -x "$INSTALL_DIR/monitor.sh" ]]; then
        echo "正在执行监控脚本..."
        "$INSTALL_DIR/monitor.sh" --daily
        success_msg "监控脚本已执行，请查看监控话题中的第二条消息"
    else
        error_msg "监控脚本不存在或不可执行"
        echo -e "${YELLOW}最近的错误日志：${NC}"
        journalctl -u $SERVICE_NAME -p 3 --since "5 min ago" --no-pager | tail -10
    fi
    press_enter
}

monitor_menu() {
    source "$CONFIG_FILE"
    print_banner
    if crontab -l 2>/dev/null | grep -F "/opt/chat-system/monitor.sh" > /dev/null; then
        echo -e "  状态: ${GREEN}已启用${NC} (每60分钟)"
    else
        echo -e "  状态: ${RED}未启用${NC}"
    fi
    echo ""
    echo "1) 启用监控"
    echo "2) 禁用监控"
    echo "3) 测试监控"
    echo "4) 返回"
    read -p "选择: " opt
    case $opt in
        1)
            # 启用监控：若话题无效则自动创建
            if [[ -z "$MONITOR_TOPIC_ID" || "$MONITOR_TOPIC_ID" == "YOUR_MONITOR_TOPIC_ID" ]]; then
                info_msg "未检测到有效监控话题，正在创建..."
                CREATE=$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic" \
                    -d "chat_id=${CHAT_ID}" \
                    -d "name=🔔 系统监控")
                NEW_TOPIC_ID=$(echo "$CREATE" | grep -oP '"message_thread_id":\K\d+')
                if [[ -z "$NEW_TOPIC_ID" ]]; then
                    error_msg "创建话题失败: $CREATE"
                    press_enter
                    return
                fi
                # 更新 config.js
                sed -i "s|MONITOR_TOPIC_ID: \"[^\"]*\"|MONITOR_TOPIC_ID: \"${NEW_TOPIC_ID}\"|" "$INSTALL_DIR/config.js"
                # 更新 config.env
                sed -i "s|^MONITOR_TOPIC_ID=.*|MONITOR_TOPIC_ID=\"$NEW_TOPIC_ID\"|" "$CONFIG_FILE"
                systemctl restart $SERVICE_NAME
                success_msg "监控话题已创建，ID: $NEW_TOPIC_ID，服务已重启"
            fi

            local tmpcron=$(mktemp)
            crontab -l 2>/dev/null | grep -v "monitor.sh" > "$tmpcron" || true
            echo "*/60 * * * * /opt/chat-system/monitor.sh" >> "$tmpcron"
            crontab "$tmpcron"
            rm -f "$tmpcron"
            chmod +x /opt/chat-system/monitor.sh 2>/dev/null || true
            success_msg "监控已启用"
            ;;
        2)
            crontab -l 2>/dev/null | grep -v "monitor.sh" | crontab -
            if [[ -n "$MONITOR_TOPIC_ID" && "$MONITOR_TOPIC_ID" != "YOUR_MONITOR_TOPIC_ID" ]]; then
                echo "正在删除监控话题 ID: $MONITOR_TOPIC_ID ..."
                curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteForumTopic" \
                    -d "chat_id=${CHAT_ID}" \
                    -d "message_thread_id=${MONITOR_TOPIC_ID}" > /dev/null
                sed -i "s|MONITOR_TOPIC_ID: \"[^\"]*\"|MONITOR_TOPIC_ID: \"YOUR_MONITOR_TOPIC_ID\"|" "$INSTALL_DIR/config.js"
                sed -i "s|^MONITOR_TOPIC_ID=.*|MONITOR_TOPIC_ID=\"YOUR_MONITOR_TOPIC_ID\"|" "$CONFIG_FILE"
                systemctl restart $SERVICE_NAME
                success_msg "监控已禁用，话题已删除"
            else
                success_msg "监控已禁用"
            fi
            ;;
        3) test_monitor ;;
        4) return ;;
        *) error_msg "无效选项" ;;
    esac
    press_enter
}

# ---------- 更新 GeoIP ----------
update_geoip() {
    cd "$INSTALL_DIR"
    echo -e "${CYAN}正在更新 GeoIP 数据库...${NC}"
    npm update geoip-lite 2>&1
    if [[ $? -eq 0 ]]; then
        success_msg "GeoIP 数据库已更新"
    else
        error_msg "更新失败，请检查网络或手动 npm update geoip-lite"
    fi
    press_enter
}

# ---------- 更新项目 ----------
update_project() {
    cd "$INSTALL_DIR"
    git fetch origin
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse origin/main)
    if [[ "$LOCAL" == "$REMOTE" ]]; then
        info_msg "已是最新版"
    else
        git update-index --skip-worktree config.js 2>/dev/null || true
        git reset --hard origin/main
        npm install
        npm install geoip-lite --save
        systemctl restart $SERVICE_NAME
        success_msg "更新完成并重启"
    fi
    press_enter
}

# ---------- 卸载 ----------
uninstall_sys() {
    read -p "确认完全卸载？(输入 y 继续): " confirm
    [[ "$confirm" != "y" ]] && return
    systemctl stop $SERVICE_NAME
    systemctl disable $SERVICE_NAME
    rm -f /etc/systemd/system/$SERVICE_NAME.service
    rm -f /usr/local/bin/chat
    crontab -l 2>/dev/null | grep -v "monitor.sh" | crontab -
    rm -rf "$INSTALL_DIR" /etc/chat-system
    success_msg "卸载完成"
    exit 0
}

# ---------- 注册 chat 命令 ----------
register_chat_cmd() {
    cat > /usr/local/bin/chat << 'EOF'
#!/bin/bash
[[ ! -f /opt/chat-system/deploy.sh ]] && echo "未安装" && exit 1
[[ $EUID -ne 0 ]] && exec sudo bash /opt/chat-system/deploy.sh "$@"
exec bash /opt/chat-system/deploy.sh "$@"
EOF
    chmod +x /usr/local/bin/chat
    success_msg "'chat' 命令已就绪"
    press_enter
}

# ---------- 主菜单 ----------
main_menu() {
    while true; do
        source "$CONFIG_FILE"
        print_banner
        if systemctl is-active --quiet $SERVICE_NAME; then
            echo -e "服务: ${GREEN}运行中${NC} | 端口: $PORT"
        else
            echo -e "服务: ${RED}已停止${NC}"
        fi
        echo ""
        echo "1) 启动服务        5) 修改配置"
        echo "2) 停止服务        6) Webhook 设置"
        echo "3) 重启服务        7) 存储信息"
        echo "4) 服务状态        8) 清理上传文件"
        echo ""
        echo "9) 查看日志        11) 监控管理"
        echo "10) 更新代码       12) 注册 chat 命令"
        echo ""
        echo "13) 更新 IP 地址库  14) 卸载"
        echo "0) 退出"
        read -p "请选择: " choice
        case $choice in
            1) start_svc; press_enter ;;
            2) stop_svc; press_enter ;;
            3) restart_svc; press_enter ;;
            4) svc_status ;;
            5) edit_config ;;
            6) show_webhook_info ;;
            7) show_storage ;;
            8) clear_uploads ;;
            9) view_logs ;;
            10) update_project ;;
            11) monitor_menu ;;
            12) register_chat_cmd ;;
            13) update_geoip ;;
            14) uninstall_sys ;;
            0) exit 0 ;;
            *) error_msg "无效选项"; press_enter ;;
        esac
    done
}

# 运行
main_menu
