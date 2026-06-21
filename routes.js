// routes.js —— 所有 HTTP 路由处理，依赖 lib 与 config
const crypto = require("crypto");
const axios = require("axios");
const geoip = require("geoip-lite");
const path = require("path");
const multer = require("multer");

function getPublicBaseUrl(config) {

    if (!config.DOMAIN) {
        console.error("DOMAIN 未设置，文件链接将使用相对路径");
        return "";
    }
    return `https://${config.DOMAIN}`;
}

module.exports = function setupRoutes(app, lib, config) {
    // ========================
    // 会话初始化
    // ========================
    app.get("/init", async (req, res) => {
        // ★ 优先从查询参数获取
        let sid = req.query.sid || null;
        console.log(`[INIT] 从 query 获取 sid: ${sid}`);
        
        // 1. 检查请求中是否带有持久化 Cookie 的 cw_sid
        if (!sid) {
            const rawCookie = req.headers.cookie || "";
            const match = rawCookie.match(/(?:^|;)\s*cw_sid=([^;]+)/);
            sid = match ? match[1] : null;
            console.log(`[INIT] 从 Cookie 获取 sid: ${sid}`);
        }

        // 2. 如果 Cookie 中的 sid 在 Redis 中仍有效，直接复用，否则生成新会话
        if (sid) {
            const exists = await lib.redisClient.exists(`sess:${sid}`);
            console.log(`[INIT] sid 在 Redis 中存在? ${exists}`);
            if (!exists) sid = null;
        }
        if (!sid) {
            sid = crypto.randomUUID();
            console.log(`[INIT] 生成新 sid: ${sid}`);
        } else {
            // ★ 刷新最后活动时间，防止被清理
            await lib.redisClient.set(`last:${sid}`, Date.now());
            console.log(`[INIT] 复用 sid: ${sid}，并更新 last`);
        }

        // 3. 获取或生成 token (如果复用会话，则使用已存在的 token)
        let token = await lib.redisClient.get(`token:${sid}`);
        if (!token) {
            token = crypto.randomBytes(16).toString("hex");
        }

        // 4. 更新/创建 Redis 中的会话和 token（过期时间与 Cookie 对齐，这里设为半年）
        const cookieMaxAge = 15552000; // 180 天，单位秒
        await lib.redisClient.set(`sess:${sid}`, JSON.stringify({ created: Date.now() }), { EX: cookieMaxAge });
        await lib.redisClient.set(`token:${sid}`, token, { EX: cookieMaxAge });

        // 5. 设置持久化 Cookie（浏览器会自动携带）
        const isHttps = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
        res.cookie('cw_sid', sid, {
            maxAge: cookieMaxAge * 1000, // express 的 maxAge 是毫秒
            path: '/',
            sameSite: 'lax',
            secure: true,
            httpOnly: false   // 必须 false，前端需要读取该 Cookie
        });
        // 可选：也把 token 写入 Cookie，但会增加暴露风险，建议仅用 sid 即可恢复会话
        // res.cookie('cw_token', token, { maxAge: cookieMaxAge * 1000, path: '/', sameSite: 'lax', secure: isHttps, httpOnly: true });

        res.json({ sid, token });
    });

    // ========================
    // 发送消息
    // ========================
    app.post("/send", lib.upload.single("file"), async (req, res) => {
        try {
            const sid = String(req.body.sid);
            const token = String(req.body.token);
            const msg = req.body.msg || "";
            const file = req.file;

            const storedToken = await lib.redisClient.get(`token:${sid}`);
            if (!storedToken || storedToken !== token) {
                return res.status(403).json({ error: "会话无效" });
            }

            if (!msg && !file) {
                return res.status(400).json({ error: "消息或文件不能同时为空" });
            }

            const ip = req.headers['cf-connecting-ip'] || req.ip || '0.0.0.0';

            if (await lib.isBlocked(lib.redisClient, ip)) {
                return res.json({ ok: true, msgId: crypto.randomUUID(), msgData: {} });
            }

            const rateLimited = await lib.checkRateLimit(lib.redisClient, ip);
            if (rateLimited) {
                return res.json({ ok: true, msgId: crypto.randomUUID(), msgData: {} });
            }

            const currentUsage = Number(await lib.redisClient.get(`usage:${sid}`) || 0);
            if (currentUsage >= config.SESSION_STORAGE_LIMIT) {
                return res.status(413).json({ error: "会话存储空间已满" });
            }

            const topicId = await lib.getOrCreateTopic(lib.redisClient, sid, req.headers['user-agent']);
            const now = Date.now();
            await lib.redisClient.set(`last:${sid}`, now);

            const msgId = crypto.randomUUID();
            const msgData = { id: msgId, role: "user", time: now };

            if (file) {
                const filePathOnDisk = path.join(lib.UPLOAD_DIR, file.filename);
                const fileUrl = `/uploads/${file.filename}`;
                const publicBase = getPublicBaseUrl(config);
                const fullFileUrl = publicBase + fileUrl;

                msgData.type = lib.getFileCategory(file.mimetype);
                msgData.fileName = file.originalname;
                msgData.fileSize = file.size;
                msgData.fileUrl = fullFileUrl;
                msgData.mimeType = file.mimetype;
                if (msg) msgData.text = msg;

                await lib.redisClient.rPush(`files:${sid}`, filePathOnDisk);
                await lib.redisClient.incrBy(`usage:${sid}`, file.size);
                await lib.redisClient.zAdd('global:files', { score: now, value: filePathOnDisk });
            } else {
                msgData.type = "text";
                msgData.text = msg;
            }

            await lib.redisClient.rPush(`chat:${sid}`, JSON.stringify(msgData));

            // 发送到 Telegram（异步）
            const sendToTelegram = async () => {
                try {
                    const geo = geoip.lookup(ip) || {};
                    const location = geo.country ? `${geo.country} ${geo.city || ''}` : '未知';
                    const ipInfo = `[IP: ${ip} | ${location}]`;

                    let tgText = msg || '';
                    if (file) {
                        const fileDesc = `\n\n📎 文件: ${msgData.fileUrl}`;
                        tgText = (tgText ? tgText + fileDesc : fileDesc);
                    }
                    tgText += `\n\n${ipInfo}`;

                    await axios.post(`https://api.telegram.org/bot${config.BOT_TOKEN}/sendMessage`, {
                        chat_id: config.CHAT_ID,
                        message_thread_id: Number(topicId),
                        text: tgText
                    });
                } catch (e) {
                    console.error("Telegram send failed:", e.response?.data || e.message);
                }
            };
            sendToTelegram();

            // 自动回复
            await lib.scheduleAutoReply(lib.redisClient, sid, now);

            res.json({ ok: true, msgId, msgData });
        } catch (e) {
            console.error("send failed:", e);
            res.status(500).json({ error: "发送失败" });
        }
    });

    // ========================
    // Telegram Webhook（验证 secret）
    // ========================
    app.post("/telegram-webhook", async (req, res) => {
        const secret = req.headers['x-telegram-bot-api-secret-token'];
        if (secret !== config.WEBHOOK_SECRET) {
            console.log("非法 webhook 请求");
            return res.sendStatus(200);
        }

        try {
            const msg = req.body.message;
            const baseUrl = getPublicBaseUrl(config);
            if (!msg?.message_thread_id || msg.from?.is_bot) return res.sendStatus(200);

            const topicId = String(msg.message_thread_id);
            let sid = await lib.redisClient.get(`map:topic:${topicId}`);

            if (!sid) {
                let cursor = 0;
                do {
                    const result = await lib.redisClient.scan(cursor, { MATCH: "topic:*", COUNT: 100 });
                    cursor = result.cursor;
                    for (const k of result.keys) {
                        const t = await lib.redisClient.get(k);
                        if (t === topicId) {
                            sid = k.split(":")[1];
                            await lib.redisClient.set(`map:topic:${topicId}`, sid);
                            break;
                        }
                    }
                    if (sid) break;
                } while (cursor !== 0);
                if (!sid) return res.sendStatus(200);
            }

            const now = Date.now();
            const msgId = crypto.randomUUID();
            const data = { id: msgId, role: "agent", time: now };

            if (msg.text) {
                data.type = "text";
                data.text = msg.text;
            }
            if (msg.photo) {
                const file = msg.photo[msg.photo.length - 1];
                try {
                    const saved = await lib.downloadAndSaveTgFile(file.file_id, sid, '.jpg');
                    data.type = "image";
                    data.fileUrl = baseUrl + saved.url;
                    data.fileName = 'image.jpg';
                } catch (e) { console.error("下载图片失败:", e.message); }
            }
            if (msg.video) {
                try {
                    const saved = await lib.downloadAndSaveTgFile(msg.video.file_id, sid, '.mp4');
                    data.type = "video";
                    data.fileUrl = baseUrl + saved.url;
                    data.fileName = msg.video.file_name || 'video.mp4';
                } catch (e) { console.error("下载视频失败:", e.message); }
            }
            if (msg.document) {
                const doc = msg.document;
                try {
                    const saved = await lib.downloadAndSaveTgFile(doc.file_id, sid);
                    data.type = "document";
                    data.fileUrl = baseUrl + saved.url;
                    data.fileName = doc.file_name || 'document';
                    data.mimeType = doc.mime_type;
                } catch (e) { console.error("下载文档失败:", e.message); }
            }
            if (msg.voice) {
                try {
                    const saved = await lib.downloadAndSaveTgFile(msg.voice.file_id, sid, '.ogg');
                    data.type = "voice";
                    data.fileUrl = baseUrl + saved.url;
                    data.duration = msg.voice.duration;
                } catch (e) { console.error("下载语音失败:", e.message); }
            }
            if (msg.sticker) {
                try {
                    const saved = await lib.downloadAndSaveTgFile(msg.sticker.file_id, sid, '.webp');
                    data.type = "sticker";
                    data.fileUrl = baseUrl + saved.url;
                    data.emoji = msg.sticker.emoji;
                } catch (e) { console.error("下载贴纸失败:", e.message); }
            }

            await lib.redisClient.rPush(`chat:${sid}`, JSON.stringify(data));
            await lib.redisClient.del(`autoreply:${sid}`);
            res.sendStatus(200);
        } catch (e) {
            console.error("webhook failed:", e);
            res.sendStatus(500);
        }
    });

    // ========================
    // 历史记录
    // ========================
    app.get("/history", async (req, res) => {
        try {
            const { sid, token, after, before, limit = 50 } = req.query;
            const storedToken = await lib.redisClient.get(`token:${sid}`);
            if (!storedToken || storedToken !== token) {
                return res.status(403).json({ error: "会话无效" });
            }

            const maxLimit = Math.min(Number(limit) || 50, 100);
            let list = await lib.redisClient.lRange(`chat:${sid}`, 0, -1);
            let data = list.map(i => JSON.parse(i));
            if (after) data = data.filter(m => m.time > Number(after));
            if (before) data = data.filter(m => m.time < Number(before));
            data.sort((a, b) => b.time - a.time);
            const page = data.slice(0, maxLimit);
            const hasMore = data.length > maxLimit;
            res.json({ data: page, hasMore });
        } catch (e) {
            console.error("get history failed:", e);
            res.status(500).json({ error: "获取历史记录失败" });
        }
    });

    // ========================
    // 最后在线
    // ========================
    app.get("/last-online", async (req, res) => {
        const sid = String(req.query.sid);
        const last = await lib.redisClient.get(`last:${sid}`);
        res.json({ sid, lastOnline: last ? Number(last) : null });
    });

    // ========================
    // 错误处理中间件
    // ========================
    app.use((err, req, res, next) => {
        if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "文件大小不能超过50MB" });
            return res.status(400).json({ error: `上传错误: ${err.message}` });
        }
        if (err.message?.includes("不支持")) return res.status(400).json({ error: err.message });
        console.error("unexpected error:", err);
        res.status(500).json({ error: "服务器内部错误" });
    });
};
