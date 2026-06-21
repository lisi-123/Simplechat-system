// config.js —— 所有配置均在此硬编码，由 install.sh/deploy.sh 直接修改
module.exports = {
    BOT_TOKEN: "YOUR_BOT_TOKEN",
    CHAT_ID: "YOUR_CHAT_ID",
    EXPIRE_DAYS: 30,
    get EXPIRE_MS() { return this.EXPIRE_DAYS * 24 * 60 * 60 * 1000; },
    MAX_FILE_SIZE: 50 * 1024 * 1024,
    RATE_LIMIT_COUNT: 20,
    RATE_LIMIT_BAN_HOURS: 48,
    MONITOR_TOPIC_ID: "YOUR_MONITOR_TOPIC_ID",
    WEBHOOK_SECRET: "YOUR_WEBHOOK_SECRET",
    DOMAIN: "",
    PORT: 3000,
    SESSION_STORAGE_LIMIT: 200 * 1024 * 1024,
    GLOBAL_STORAGE_LIMIT: 2 * 1024 * 1024 * 1024
};
