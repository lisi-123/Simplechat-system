#!/bin/bash
# 监控脚本：服务自恢复、资源告警、每日统计
# 依赖 /etc/chat-system/config.env

CONFIG_FILE="/etc/chat-system/config.env"
if [[ -f "$CONFIG_FILE" ]]; then
    source "$CONFIG_FILE"
else
    echo "配置文件不存在，退出"
    exit 1
fi

HOST=$(hostname)
SERVICE="chat-system"

# ---------- 1. 服务宕机自动重启 ----------
if ! systemctl is-active --quiet "$SERVICE"; then
    systemctl start "$SERVICE"
    sleep 5
    if systemctl is-active --quiet "$SERVICE"; then
        MSG="⚠️ $HOST Chat System 已自动恢复"
    else
        MSG="🚨 $HOST Chat System 异常，自动重启失败"
    fi
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" -d "message_thread_id=${MONITOR_TOPIC_ID}" -d "text=${MSG}" > /dev/null
fi

# ---------- 2. 磁盘/内存告警 ----------
DISK=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [[ $DISK -gt 90 ]]; then
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" -d "message_thread_id=${MONITOR_TOPIC_ID}" \
        -d "text=⚠️ $HOST 磁盘使用率 ${DISK}%" > /dev/null
fi

MEM=$(free | grep Mem | awk '{printf "%.0f", $3/$2*100}')
if [[ $MEM -gt 90 ]]; then
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" -d "message_thread_id=${MONITOR_TOPIC_ID}" \
        -d "text=⚠️ $HOST 内存使用率 ${MEM}%" > /dev/null
fi

# ---------- 3. 每日统计（凌晨执行） ----------
CURRENT_HOUR=$(date +%H)
if [[ "$1" == "--daily" ]] || [[ "$CURRENT_HOUR" == "00" ]]; then
    STATS_FILE=$(mktemp)
    TODAY=$(date +%Y-%m-%d)
    echo "📊 每日运行统计 [${TODAY}]" > "$STATS_FILE"
    echo "=========================" >> "$STATS_FILE"

    # 活跃会话数（通过 Redis SCAN 统计 topic:* 前缀的键）
    if command -v redis-cli &>/dev/null; then
        TOPIC_COUNT=$(redis-cli --scan --pattern "topic:*" 2>/dev/null | wc -l)
        echo "• 活跃会话数: ${TOPIC_COUNT:-0}" >> "$STATS_FILE"
    else
        echo "• 活跃会话数: 未知" >> "$STATS_FILE"
    fi

    # 磁盘、内存、CPU
    echo "• 磁盘: $(df -h / | tail -1 | awk '{print $3"/"$2" ("$5")"}')" >> "$STATS_FILE"
    echo "• 内存: $(free -h | grep Mem | awk '{print $3"/"$2}')" >> "$STATS_FILE"
    echo "• CPU负载: $(uptime | awk -F'load average:' '{print $2}')" >> "$STATS_FILE"

    # 上传文件统计
    UPLOAD_PATH="/opt/chat-system/public/uploads"
    if [[ -d "$UPLOAD_PATH" ]]; then
        UPLOAD_SIZE=$(du -sh "$UPLOAD_PATH" 2>/dev/null | cut -f1)
        UPLOAD_COUNT=$(find "$UPLOAD_PATH" -type f | wc -l)
        echo "• 上传文件: ${UPLOAD_COUNT} 个，共 ${UPLOAD_SIZE}" >> "$STATS_FILE"
    fi

    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" -d "message_thread_id=${MONITOR_TOPIC_ID}" \
        -d "text=$(cat "$STATS_FILE")" > /dev/null
    rm "$STATS_FILE"
fi
