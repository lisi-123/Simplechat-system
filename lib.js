// lib.js —— Redis 客户端、Multer、工具函数、业务逻辑
const redis = require("redis");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const axios = require("axios");
const geoip = require("geoip-lite");
const config = require("./config");

// ---------- Redis 客户端 ----------
const redisClient = redis.createClient({
    socket: {
        reconnectStrategy: (retries) => {
            if (retries > 20) {
                console.error("Redis 重连失败次数过多，退出进程");
                return new Error("重连上限");
            }
            return Math.min(retries * 200, 5000);
        }
    }
});

redisClient.on("error", (err) => console.error("Redis 错误:", err.message));

async function connectRedis() {
    await redisClient.connect();
    console.log("Redis 已连接");
}

// ---------- Multer 配置 ----------
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIMES = [
    "image/jpeg","image/png","image/gif","image/webp","image/bmp","image/svg+xml",
    "video/mp4","video/webm","video/ogg","video/quicktime",
    "application/pdf","application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain","text/csv","application/zip","application/x-rar-compressed",
    "application/x-7z-compressed"
];

const ALLOWED_EXTENSIONS = [
    ".jpg",".jpeg",".png",".gif",".webp",".bmp",".svg",
    ".mp4",".webm",".ogg",".mov",
    ".pdf",".doc",".docx",".xls",".xlsx",".ppt",".pptx",
    ".txt",".csv",".zip",".rar",".7z"
];

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = crypto.randomBytes(8).toString("hex");
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${Date.now()}-${uniqueSuffix}${ext}`);
    }
});

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) return cb(new Error(`不支持的文件类型: ${ext}`), false);
    if (!ALLOWED_MIMES.includes(file.mimetype)) return cb(new Error(`不支持的MIME类型: ${file.mimetype}`), false);
    cb(null, true);
};

const upload = multer({ storage, fileFilter, limits: { fileSize: config.MAX_FILE_SIZE } });

// ---------- 通用工具函数 ----------
function getFileCategory(mimeType) {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    return "document";
}

// ---------- 全局存储清理 ----------
async function enforceGlobalStorageLimit(redisClient) {
    try {
        const files = await redisClient.zRange('global:files', 0, -1, 'WITHSCORES');
        let totalSize = 0;
        const entries = [];
        for (let i = 0; i < files.length; i += 2) {
            const fpath = files[i];
            const size = Number(files[i + 1]);
            totalSize += size;
            entries.push({ fpath, size });
        }
        if (totalSize <= config.GLOBAL_STORAGE_LIMIT) return;

        const toDelete = [];
        for (const entry of entries) {
            if (totalSize <= config.GLOBAL_STORAGE_LIMIT) break;
            toDelete.push(entry.fpath);
            totalSize -= entry.size;
        }
        for (const fpath of toDelete) {
            fs.unlink(fpath, () => {});
            await redisClient.zRem('global:files', fpath);
        }
    } catch (e) {
        console.error("全局存储清理失败:", e);
    }
}

// ---------- 会话清理 ----------
async function cleanupInactiveUsers(redisClient) {
    try {
        const now = Date.now();
        let cursor = 0;
        do {
            const result = await redisClient.scan(cursor, { MATCH: "last:*", COUNT: 100 });
            cursor = result.cursor;
            for (const k of result.keys) {
                const sid = k.split(":")[1];
                const last = Number(await redisClient.get(k));
                if (!last || now - last < config.EXPIRE_MS) continue;

                console.log("cleanup user:", sid);
                const topicId = await redisClient.get(`topic:${sid}`);
                if (topicId) {
                    try {
                        await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/deleteForumTopic`, {
                            chat_id: config.CHAT_ID,
                            message_thread_id: Number(topicId)
                        });
                    } catch (e) { console.log("delete topic failed:", sid); }
                }

                let batch = await redisClient.lRange(`files:${sid}`, 0, 19);
                while (batch.length > 0) {
                    for (const fp of batch) fs.unlink(fp, () => {});
                    await redisClient.lTrim(`files:${sid}`, batch.length, -1);
                    batch = await redisClient.lRange(`files:${sid}`, 0, 19);
                }

                const delKeys = [`sess:${sid}`, `topic:${sid}`, `chat:${sid}`, `last:${sid}`,
                                 `files:${sid}`, `usage:${sid}`, `autoreply:${sid}`, `token:${sid}`];
                if (topicId) delKeys.push(`map:topic:${topicId}`);
                await redisClient.del(delKeys);
            }
        } while (cursor !== 0);
        await enforceGlobalStorageLimit(redisClient);
    } catch (e) {
        console.error("cleanup failed:", e);
    }
}

// ---------- 话题创建（带锁） ----------
async function getOrCreateTopic(redisClient, sid) {
    let topicId = await redisClient.get(`topic:${sid}`);
    if (topicId) return topicId;

    const lockKey = `lock:topic:${sid}`;
    const locked = await redisClient.set(lockKey, "1", { NX: true, EX: 10 });
    if (locked) {
        try {
            topicId = await redisClient.get(`topic:${sid}`);
            if (topicId) return topicId;

            const topic = await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/createForumTopic`, {
                chat_id: config.CHAT_ID,
                name: `用户 ${sid.slice(0, 8)}`
            });
            topicId = String(topic.data.result.message_thread_id);
            await redisClient.set(`topic:${sid}`, topicId);
            await redisClient.set(`map:topic:${topicId}`, sid);
            return topicId;
        } finally {
            await redisClient.del(lockKey);
        }
    } else {
        await new Promise(r => setTimeout(r, 500));
        return getOrCreateTopic(redisClient, sid);
    }
}

// ---------- 频率限制 ----------
async function isBlocked(redisClient, ip) {
    return !!(await redisClient.get(`blocked:ip:${ip}`));
}

async function checkRateLimit(redisClient, ip) {
    const key = `rate:${ip}`;
    const now = Date.now();
    await redisClient.lPush(key, now.toString());
    await redisClient.lTrim(key, 0, config.RATE_LIMIT_COUNT * 2);
    await redisClient.expire(key, 120);
    const recent = await redisClient.lRange(key, 0, -1);
    const oneMinuteAgo = now - 60000;
    const countInWindow = recent.filter(t => Number(t) > oneMinuteAgo).length;

    if (countInWindow > config.RATE_LIMIT_COUNT) {
        const banSeconds = config.RATE_LIMIT_BAN_HOURS * 3600;
        await redisClient.set(`blocked:ip:${ip}`, "1", { EX: banSeconds });
        try {
            const info = geoip.lookup(ip) || {};
            const location = info.country ? `${info.country} ${info.city || ''}` : '未知';
            await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
                chat_id: config.CHAT_ID,
                message_thread_id: Number(config.MONITOR_TOPIC_ID),
                text: `🚫 触发频率限制\nIP: ${ip}\n地区: ${location}\n已拉黑 ${config.RATE_LIMIT_BAN_HOURS} 小时`
            });
        } catch (e) { console.error("监控通知失败:", e.message); }
        return true;
    }
    return false;
}

// ---------- 从 Telegram 下载文件到本地 ----------
async function downloadAndSaveTgFile(fileId, sessionId, originalExt = '') {
    const r = await axios.get(`https://api.telegram.org/bot${config.BOT_TOKEN}/getFile?file_id=${fileId}`);
    const filePath = r.data.result.file_path;
    const tgUrl = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${filePath}`;
    const ext = originalExt || path.extname(filePath);
    const destName = `tg_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`;
    const destPath = path.join(UPLOAD_DIR, destName);
    const resp = await axios.get(tgUrl, { responseType: 'stream' });
    const writer = fs.createWriteStream(destPath);
    resp.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
    const fileSize = fs.statSync(destPath).size;
    await redisClient.rPush(`files:${sessionId}`, destPath);
    await redisClient.zAdd('global:files', { score: Date.now(), value: destPath });
    await redisClient.incrBy(`usage:${sessionId}`, fileSize);
    return { url: `/uploads/${destName}`, size: fileSize };
}

// ---------- 自动回复逻辑（独立函数） ----------
async function scheduleAutoReply(redisClient, sid, now) {
    const autoReplyKey = `autoreply:${sid}`;
    const alreadySent = await redisClient.get(autoReplyKey);
    if (alreadySent) return;

    setTimeout(async () => {
        try {
            const recentMsgs = await redisClient.lRange(`chat:${sid}`, -50, -1);
            const hasRecentAgent = recentMsgs.some(m => {
                try { return JSON.parse(m).role === "agent" && (now - JSON.parse(m).time < 86400000); } catch { return false; }
            });
            if (hasRecentAgent) return;

            const allMsgs = await redisClient.lRange(`chat:${sid}`, 0, -1);
            const userMsgs = allMsgs.map(m => JSON.parse(m)).filter(m => m.role === "user");
            if (userMsgs.length === 0) return;
            const firstUserTime = userMsgs[0].time;
            if (now - firstUserTime > 30 * 60000) return;

            await redisClient.rPush(`chat:${sid}`, JSON.stringify({
                id: crypto.randomUUID(),
                role: "agent",
                type: "text",
                text: "您好，当前是留言模式。客服暂时不在线，您的消息已成功传达，上线后会第一时间回复您，请稍候。",
                time: Date.now()
            }));
            setTimeout(async () => {
                await redisClient.rPush(`chat:${sid}`, JSON.stringify({
                    id: crypto.randomUUID(),
                    role: "agent",
                    type: "text",
                    text: "如果有任何问题或需求可以先详细描述一下，方便客服上线后快速了解情况，帮您高效处理。",
                    time: Date.now()
                }));
            }, 3000);

            await redisClient.set(autoReplyKey, "1", { EX: 3600 });
        } catch (e) {
            console.error("auto reply failed:", e.message);
        }
    }, 20000); // 20 秒后触发（已修改）
}

// 导出所有需要的模块
module.exports = {
    redisClient,
    connectRedis,
    upload,
    UPLOAD_DIR,
    getFileCategory,
    enforceGlobalStorageLimit,
    cleanupInactiveUsers,
    getOrCreateTopic,
    isBlocked,
    checkRateLimit,
    downloadAndSaveTgFile,
    scheduleAutoReply
};