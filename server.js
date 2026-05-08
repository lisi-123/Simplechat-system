// server.js —— 入口文件
const express = require("express");
const cors = require("cors");
const config = require("./config");
const lib = require("./lib");
const setupRoutes = require("./routes");

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// 连接 Redis 并启动
(async () => {
    try {
        await lib.connectRedis();
    } catch (e) {
        console.error("Redis 启动失败:", e);
        process.exit(1);
    }

    // 挂载路由
    setupRoutes(app, lib, config);

    // 定时清理过期会话（每12小时）
    setInterval(() => lib.cleanupInactiveUsers(lib.redisClient), 12 * 60 * 60 * 1000);
    lib.cleanupInactiveUsers(lib.redisClient);  // 启动时执行一次

    app.listen(config.PORT, () => {
        console.log(`server running on port ${config.PORT}`);
    });
})();