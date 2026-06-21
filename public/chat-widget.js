(function () {
    // =========================
    // 1. 初始化 & 配置
    // =========================
    const script = document.querySelector("script[data-chat-widget]");
    if (!script) return;
    const API = new URL(script.src).origin;

    // =========================
    // 2. 全局状态管理
    // =========================
     function getCookie(name) {
     const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
     return match ? decodeURIComponent(match[2]) : null;
    }
    let sid = getCookie("cw_sid") || localStorage.getItem("cw_sid");
    let token = getCookie("cw_token") || localStorage.getItem("cw_token");
    if (sid && !localStorage.getItem("cw_sid")) localStorage.setItem("cw_sid", sid);
    if (token && !localStorage.getItem("cw_token")) localStorage.setItem("cw_token", token);
    let lastTime = 0;
    let open = false;

    // 去重池（最多 500 条 ID）
    const MAX_SEEN = 500;
    const seen = new Set();
    function addSeen(id) {
        if (seen.size >= MAX_SEEN) {
            const arr = Array.from(seen).slice(-250);
            seen.clear();
            arr.forEach(v => seen.add(v));
        }
        seen.add(id);
    }
    function hasSeen(id) { return seen.has(id); }

    // 文件上传状态
    let uploadingFile = null;
    let isUploading = false;

    // 历史加载状态
    let loadingMore = false;
    let hasMoreHistory = true;
    let oldestTime = null;

    // 轮询退避参数
    const POLL_FAST = 1000;          // 快速期 1 秒
    const POLL_MEDIUM = 2000;        // 中速期 2 秒
    const FAST_DURATION = 30000;     // 快速期持续时间
    const MEDIUM_DURATION = 30000;   // 中速期持续时间
    const BACKOFF_INIT = 2000;       // 退避起始间隔
    const BACKOFF_INCREMENT = 500;   // 每次增加 0.5 秒
    const BACKOFF_MAX = 15000;       // 退避上限 15 秒
    let lastMessageTime = Date.now();
    let backoffInterval = BACKOFF_INIT;
    let pollTimer = null;

    // =========================
    // 3. DOM 构建（Shadow DOM）
    // =========================
    const host = document.createElement("div");
    host.id = "cw-root";
    host.style.position = "fixed";
    host.style.zIndex = "999999";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    shadow.innerHTML = `
    <style>
        * { box-sizing: border-box; }
        :host {
            --btn-size: 62px; --btn-right: 20px; --btn-bottom: 67px;
            --btn-right-shrunk: -31px; --btn-font-size: 22px;
        }
        @media (max-width: 480px) {
            :host {
                --btn-size: 42px; --btn-right: 12px; --btn-bottom: 40px;
                --btn-right-shrunk: -22px; --btn-font-size: 17px;
            }
        }

        .cw-btn {
            position: fixed; right: var(--btn-right); bottom: var(--btn-bottom);
            width: var(--btn-size); height: var(--btn-size); border-radius: 50%;
            background: #ffffff; border: 2px solid #07C160; color: #07C160;
            display: flex; align-items: center; justify-content: center; cursor: pointer;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1); font-size: var(--btn-font-size);
            user-select: none; transition: transform 0.2s, right 0.4s ease; z-index: 1;
        }
        .cw-btn:hover { transform: scale(1.05); }
        .cw-btn.cw-btn-shrunk { right: var(--btn-right-shrunk); }
        .cw-btn.cw-btn-shrunk:hover:not(.keep-shrunk) { right: var(--btn-right); }

        .cw-panel {
            position: fixed; right: 20px; bottom: 137px; width: 380px; height: 520px;
            background: #f5f5f5; border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,0.15);
            display: none; flex-direction: column; overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        @media (max-width: 480px) {
            .cw-panel { width: 100%; height: 98dvh; right: 0; bottom: 1px; border-radius: 0; }
        }

        .cw-header {
            background: #111; color: #fff;
            padding: 9px 14px;
            font-size: 14px;
            display: flex;
            align-items: center;
            line-height: 1.2;
        }
        @media (max-width: 480px) {
            .cw-header { padding: 7px 10px; font-size: 13px; }
        }
        .cw-header-dot {
            width: 8px; height: 8px; border-radius: 50%;
            background: #4ade80; margin-right: 8px; flex-shrink: 0;
        }
        .cw-close {
            font-size: 18px; opacity: 0.7; cursor: pointer;
            margin-left: auto; line-height: 1; padding: 0 2px;
        }
        .cw-close:hover { opacity: 1; }

        .cw-msgs { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; }

        .cw-input-area { background: #fff; border-top: 1px solid #eee; padding: 8px 10px; position: relative; }
        .cw-file-preview { display: none; padding: 6px 10px; background: #f0f0f0; border-radius: 8px; margin-bottom: 8px; align-items: center; gap: 6px; font-size: 12px; }
        .cw-file-preview.show { display: flex; }
        .cw-file-preview-remove { cursor: pointer; color: #999; background: none; border: none; }

        .cw-input-row { display: flex; gap: 6px; align-items: center; }
        .cw-input-row input {
            flex: 1; border: none; outline: none; padding: 8px 12px; font-size: 13px;
            border-radius: 20px; background: #f1f1f1; color: #111; min-width: 60px;
        }
        .cw-input-row input:disabled { opacity: 0.5; }
        .cw-attach-btn, .cw-send-btn { flex-shrink: 0; cursor: pointer; }
        .cw-attach-btn {
            width: 38px; height: 38px; font-size: 22px; color: #07c160;
            background: #f1f1f1; border-radius: 50%; border: none;
        }
        .cw-send-btn {
            border: none; background: #111; color: #fff; padding: 8px 14px;
            border-radius: 18px; font-size: 13px; font-weight: 500;
        }
        .cw-send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        .cw-msg-row { display: flex; margin: 10px 0; align-items: flex-start; gap: 8px; }
        .cw-msg-row.user { flex-direction: row-reverse; }
        .cw-avatar {
            width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
            display: flex; align-items: center; justify-content: center; font-size: 12px; color: #fff;
        }
        .cw-avatar.user { background: #07c160; }
        .cw-avatar.agent { background: #111; }
        .cw-bubble {
            max-width: 75%; padding: 8px 10px; border-radius: 10px; font-size: 13px;
            line-height: 1.5; word-break: break-word;
        }
        .cw-bubble.user { background: #95ec69; color: #111; border-top-right-radius: 4px; }
        .cw-bubble.agent { background: #fff; border: 1px solid #e5e5e5; color: #111; border-top-left-radius: 4px; }

        .cw-file-msg { max-width: 75%; }
        .cw-file-card { background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; overflow: hidden; }
        .cw-file-image { width: 100%; max-height: 180px; object-fit: cover; cursor: pointer; }
        .cw-file-video { width: 100%; max-height: 180px; cursor: pointer; }
        .cw-file-doc { display: flex; align-items: center; gap: 8px; padding: 10px; text-decoration: none; color: inherit; cursor: pointer; }
        .cw-file-doc-icon { font-size: 32px; }
        .cw-file-doc-info { flex: 1; min-width: 0; }
        .cw-file-doc-name { font-size: 12px; font-weight: 500; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .cw-file-doc-size { font-size: 10px; color: #999; margin-top: 2px; }
        .cw-file-doc-action { color: #007aff; font-size: 11px; }

        .cw-upload-progress { position: absolute; bottom: 0; left: 0; right: 0; height: 3px; background: #4ade80; display: none; }
        .cw-upload-progress.show { display: block; }
        .cw-drop-overlay {
            display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(17,17,17,0.9); z-index: 10; align-items: center; justify-content: center;
            flex-direction: column; gap: 12px; color: #fff; font-size: 14px;
        }
        .cw-drop-overlay.show { display: flex; }
        .cw-uploading-overlay {
            display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(245,245,245,0.8); z-index: 11; align-items: center; justify-content: center;
        }
        .cw-uploading-overlay.show { display: flex; }
        .cw-spinner {
            width: 32px; height: 32px; border: 3px solid #e0e0e0; border-top: 3px solid #111;
            border-radius: 50%; animation: cw-spin 1s linear infinite;
        }
        @keyframes cw-spin { to { transform: rotate(360deg); } }

        .cw-error-toast {
            position: fixed; top: 20px; right: 20px; background: #ff4444; color: #fff;
            padding: 12px 20px; border-radius: 8px; font-size: 13px; z-index: 1000000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        .cw-load-more { width: 100%; text-align: center; padding: 10px 0; flex-shrink: 0; }
        .cw-load-more button {
            background: #e0e0e0; border: none; border-radius: 12px; padding: 6px 16px;
            font-size: 12px; cursor: pointer; color: #333;
        }
        .cw-load-more button:disabled { opacity: 0.5; cursor: default; }
    </style>

    <div class="cw-btn">💬</div>
    <div class="cw-panel">
        <div class="cw-header">
            <span class="cw-header-dot"></span>
            <span>在线客服</span>
            <span class="cw-close">✕</span>
        </div>
        <div class="cw-msgs">
            <div class="cw-load-more">
                <button class="cw-load-more-btn">加载更早消息</button>
            </div>
        </div>
        <div class="cw-input-area">
            <div class="cw-file-preview">
                <span class="cw-file-preview-icon">＋</span>
                <div class="cw-file-preview-info">
                    <div class="cw-file-preview-name"></div>
                    <div class="cw-file-preview-size"></div>
                </div>
                <button class="cw-file-preview-remove">✕</button>
            </div>
            <div class="cw-input-row">
                <input type="text" placeholder="输入消息..." />
                <button class="cw-attach-btn" title="发送文件">＋</button>
                <button class="cw-send-btn">发送</button>
            </div>
            <div class="cw-upload-progress"></div>
        </div>
        <div class="cw-drop-overlay">
            <span class="cw-drop-overlay-icon">📤</span><span>释放文件以上传</span>
        </div>
        <div class="cw-uploading-overlay"><div class="cw-spinner"></div></div>
        <input type="file" style="display: none;" accept=".jpg,.jpeg,.png,.gif,.webp,.bmp,.svg,.mp4,.webm,.ogg,.mov,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.rar,.7z" />
    </div>
    `;

    // =========================
    // 4. DOM 引用获取
    // =========================
    const btn = shadow.querySelector(".cw-btn");
    const panel = shadow.querySelector(".cw-panel");
    const msgsContainer = shadow.querySelector(".cw-msgs");
    const loadMoreBtn = shadow.querySelector(".cw-load-more-btn");
    const input = shadow.querySelector("input[type='text']");
    const sendBtn = shadow.querySelector(".cw-send-btn");
    const attachBtn = shadow.querySelector(".cw-attach-btn");
    const fileInput = shadow.querySelector("input[type='file']");
    const filePreview = shadow.querySelector(".cw-file-preview");
    const filePreviewName = shadow.querySelector(".cw-file-preview-name");
    const filePreviewSize = shadow.querySelector(".cw-file-preview-size");
    const filePreviewRemove = shadow.querySelector(".cw-file-preview-remove");
    const uploadProgress = shadow.querySelector(".cw-upload-progress");
    const dropOverlay = shadow.querySelector(".cw-drop-overlay");
    const uploadingOverlay = shadow.querySelector(".cw-uploading-overlay");

    // =========================
    // 5. 工具函数
    // =========================
    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }
    function getFileCategory(mimeType) {
        if (!mimeType) return "document";
        if (mimeType.startsWith("image/")) return "image";
        if (mimeType.startsWith("video/")) return "video";
        return "document";
    }
    function showErrorToast(message) {
        const toast = document.createElement("div");
        toast.className = "cw-error-toast";
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }
    function isMobileDevice() {
        return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
               (navigator.maxTouchPoints > 1 && window.innerWidth < 768);
    }

    // =========================
    // 6. 消息渲染模块
    // =========================
    function addMessage(m, prepend = false) {
        const key = m.id;
        if (!key) { console.warn('消息缺少id，无法去重', m); return; }
        if (hasSeen(key)) return;
        addSeen(key);

        const isUser = m.role === "user";
        const row = document.createElement("div");
        row.className = "cw-msg-row " + (isUser ? "user" : "agent");

        const avatar = document.createElement("div");
        avatar.className = "cw-avatar " + (isUser ? "user" : "agent");
        avatar.innerText = isUser ? "你" : "客服";
        row.appendChild(avatar);

        const hasFile = m.type && m.type !== "text";
        const hasText = m.text && m.text.trim();

        if (hasFile) {
            const fileWrapper = document.createElement("div");
            fileWrapper.className = "cw-file-msg";
            const fileCard = document.createElement("div");
            fileCard.className = "cw-file-card";

            const category = m.type || getFileCategory(m.mimeType);
            const fileUrl = m.fileUrl || m.url || "";

            if (category === "image" && fileUrl) {
                const img = document.createElement("img");
                img.className = "cw-file-image";
                img.src = fileUrl;
                img.alt = m.fileName || "图片";
                img.onclick = () => window.open(fileUrl, "_blank");
                fileCard.appendChild(img);
            } else if (category === "video" && fileUrl) {
                const video = document.createElement("video");
                video.className = "cw-file-video";
                video.src = fileUrl;
                video.controls = true;
                video.preload = "metadata";
                fileCard.appendChild(video);
            } else if (fileUrl) {
                const docBtn = document.createElement("div");
                docBtn.className = "cw-file-doc";
                docBtn.onclick = () => window.open(fileUrl, "_blank");
                const ext = (m.fileName || "").split(".").pop()?.toLowerCase();
                const iconMap = {jpg:"🖼️",jpeg:"🖼️",png:"🖼️",gif:"🖼️",webp:"🖼️",bmp:"🖼️",svg:"🖼️",mp4:"🎬",webm:"🎬",ogg:"🎬",mov:"🎬",pdf:"📕",doc:"📘",docx:"📘",xls:"📗",xlsx:"📗",ppt:"📙",pptx:"📙",txt:"📄",csv:"📊",zip:"📦",rar:"📦","7z":"📦"};
                const icon = iconMap[ext] || "📄";
                docBtn.innerHTML = `<span class="cw-file-doc-icon">${icon}</span><div class="cw-file-doc-info"><div class="cw-file-doc-name">${m.fileName||"文件"}</div><div class="cw-file-doc-size">${m.fileSize?formatFileSize(m.fileSize):""}</div></div><span class="cw-file-doc-action">查看</span>`;
                fileCard.appendChild(docBtn);
            }
            fileWrapper.appendChild(fileCard);
            row.appendChild(fileWrapper);
            if (hasText) {
                const textBubble = document.createElement("div");
                textBubble.className = "cw-bubble " + (isUser?"user":"agent");
                textBubble.style.marginTop = "4px";
                textBubble.innerText = m.text;
                row.appendChild(textBubble);
            }
        } else if (m.type === "sticker" && (m.fileUrl || m.url)) {
            const img = document.createElement("img");
            img.src = m.fileUrl || m.url;
            img.style.maxWidth = "120px";
            img.style.maxHeight = "120px";
            if (m.emoji) img.alt = m.emoji;
            row.appendChild(img);
        } else if (m.type === "voice" && (m.fileUrl || m.url)) {
            const audio = document.createElement("audio");
            audio.src = m.fileUrl || m.url;
            audio.controls = true;
            audio.style.maxWidth = "200px";
            row.appendChild(audio);
        } else {
            const bubble = document.createElement("div");
            bubble.className = "cw-bubble " + (isUser?"user":"agent");
            bubble.innerText = m.text || "";
            row.appendChild(bubble);
        }

        if (prepend) {
            msgsContainer.insertBefore(row, msgsContainer.children[1]);
        } else {
            msgsContainer.appendChild(row);
            row.scrollIntoView({ block: 'end', behavior: 'instant' });
        }
    }

    // =========================
    // 7. 历史加载模块
    // =========================
    async function loadHistory(params = {}) {
        if (!sid || !token) return;
        try {
            loadingMore = true;
            loadMoreBtn.disabled = true;

            const url = new URL(`${API}/history`);
            url.searchParams.set("sid", sid);
            url.searchParams.set("token", token);
            url.searchParams.set("limit", 50);
            if (params.after !== undefined) url.searchParams.set("after", params.after);
            if (params.before) url.searchParams.set("before", params.before);

            const r = await fetch(url.toString());
            const json = await r.json();
            const list = json.data || [];

            list.reverse();

            if (list.length > 0) {
                if (params.before) {
                    oldestTime = list[0].time;
                    hasMoreHistory = json.hasMore !== false;
                } else {
                    oldestTime = list[0].time;
                    hasMoreHistory = json.hasMore !== false;
                }

                list.forEach(m => {
                    addMessage(m, !!params.before);
                    lastTime = Math.max(lastTime, m.time || 0);
                });

                if (!params.before && open) {
                    const last = msgsContainer.lastElementChild;
                    if (last) last.scrollIntoView({ block: 'end', behavior: 'instant' });
                }
            } else {
                hasMoreHistory = false;
            }

            loadMoreBtn.parentElement.style.display = hasMoreHistory ? "block" : "none";
        } catch (e) {
            console.error("load history failed:", e);
        } finally {
            loadingMore = false;
            loadMoreBtn.disabled = false;
        }
    }

    // =========================
    // 8. 消息发送模块
    // =========================
    function clearFileSelection() {
        uploadingFile = null;
        filePreview.classList.remove("show");
        filePreviewName.textContent = filePreviewSize.textContent = "";
        input.placeholder = "输入消息...";
    }

    async function send() {
        const msg = input.value.trim();
        if (isUploading) return;
        if (!msg && !uploadingFile) return;

        isUploading = true;
        sendBtn.disabled = true;
        input.disabled = true;
        attachBtn.disabled = true;
        uploadingOverlay.classList.add("show");

        const msgId = crypto.randomUUID();
        const now = Date.now();

        try {
            if (uploadingFile) {
                const formData = new FormData();
                formData.append("sid", sid);
                formData.append("token", token);
                formData.append("file", uploadingFile);
                if (msg) formData.append("msg", msg);

                const response = await new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.upload.addEventListener("progress", (e) => {
                        if (e.lengthComputable) {
                            const percent = (e.loaded / e.total) * 100;
                            uploadProgress.style.width = percent + "%";
                            uploadProgress.classList.add("show");
                        }
                    });
                    xhr.addEventListener("load", () => {
                        try { resolve(JSON.parse(xhr.responseText)); } catch(e) { reject(new Error("解析失败")); }
                    });
                    xhr.addEventListener("error", () => reject(new Error("上传失败")));
                    xhr.open("POST", API + "/send");
                    xhr.send(formData);
                });

                const localMsg = {
                    id: response.msgId || msgId,
                    role: "user", time: now,
                    type: getFileCategory(uploadingFile.type),
                    fileName: uploadingFile.name,
                    fileSize: uploadingFile.size,
                    mimeType: uploadingFile.type,
                    fileUrl: response.msgData?.fileUrl
                };
                if (msg) localMsg.text = msg;
                addMessage(localMsg);
                clearFileSelection();
            } else {
                addMessage({ id: msgId, role: "user", text: msg, time: now });
                await fetch(API + "/send", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ sid, token, msg })
                });
            }
            input.value = "";
            setTimeout(() => {
                uploadProgress.classList.remove("show");
                uploadProgress.style.width = "0%";
            }, 500);
        } catch (e) {
            showErrorToast(e.message || "发送失败");
        } finally {
            isUploading = false;
            sendBtn.disabled = false;
            input.disabled = false;
            attachBtn.disabled = false;
            uploadingOverlay.classList.remove("show");
            input.focus();

            lastMessageTime = Date.now();
            backoffInterval = BACKOFF_INIT;
            clearTimeout(pollTimer);
            pollTimer = setTimeout(poll, POLL_FAST);
        }
    }

    sendBtn.onclick = send;
    input.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });

    // =========================
    // 9. 文件上传处理模块
    // =========================
    attachBtn.onclick = () => { if (!isUploading) fileInput.click(); };
    fileInput.addEventListener("change", e => {
        const file = e.target.files[0];
        if (file) {
            if (file.size > 50 * 1024 * 1024) { showErrorToast("文件大小不能超过50MB"); return; }
            uploadingFile = file;
            filePreviewName.textContent = file.name;
            filePreviewSize.textContent = formatFileSize(file.size);
            filePreview.classList.add("show");
            input.placeholder = "添加说明文字（可选）...";
        }
        fileInput.value = "";
    });
    filePreviewRemove.onclick = clearFileSelection;

    let dragCounter = 0;
    let hideDropTimeout = null;
    panel.addEventListener("dragenter", e => {
        e.preventDefault(); e.stopPropagation();
        if (hideDropTimeout) { clearTimeout(hideDropTimeout); hideDropTimeout = null; }
        dragCounter++;
        if (!isUploading) dropOverlay.classList.add("show");
    });
    panel.addEventListener("dragleave", e => {
        e.preventDefault(); e.stopPropagation();
        dragCounter--;
        if (dragCounter === 0 && !isUploading) {
            hideDropTimeout = setTimeout(() => dropOverlay.classList.remove("show"), 100);
        }
    });
    panel.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); });
    panel.addEventListener("drop", e => {
        e.preventDefault(); e.stopPropagation();
        dragCounter = 0;
        dropOverlay.classList.remove("show");
        if (hideDropTimeout) { clearTimeout(hideDropTimeout); hideDropTimeout = null; }
        if (isUploading) { showErrorToast("正在上传中，请等待完成"); return; }
        const files = e.dataTransfer.files;
        if (files.length === 0) return;
        if (files.length > 1) { showErrorToast("一次只能上传一个文件"); return; }
        const file = files[0];
        if (file.size > 50 * 1024 * 1024) { showErrorToast("文件大小不能超过50MB"); return; }
        uploadingFile = file;
        filePreviewName.textContent = file.name;
        filePreviewSize.textContent = formatFileSize(file.size);
        filePreview.classList.add("show");
        input.placeholder = "添加说明文字（可选）...";
    });

    // =========================
    // 10. 轮询模块（退避策略）
    // =========================
    const poll = async () => {
        if (!sid || !token) return;

        try {
            const url = new URL(`${API}/history`);
            url.searchParams.set("sid", sid);
            url.searchParams.set("token", token);
            url.searchParams.set("after", lastTime);
            url.searchParams.set("limit", 20);
            const r = await fetch(url.toString());
            const json = await r.json();
            const list = json.data || [];
            list.reverse();

            let newMsgs = 0;
            list.forEach(m => {
                if (m.role === "user") return;
                addMessage(m);
                lastTime = Math.max(lastTime, m.time || 0);
                newMsgs++;
            });

            if (newMsgs > 0) {
                lastMessageTime = Date.now();
                backoffInterval = BACKOFF_INIT;
            }
        } catch (e) { /* 静默 */ }

        const now = Date.now();
        const idle = now - lastMessageTime;
        let nextInterval;

        if (idle < FAST_DURATION) {
            nextInterval = POLL_FAST;
            backoffInterval = BACKOFF_INIT;
        } else if (idle < FAST_DURATION + MEDIUM_DURATION) {
            nextInterval = POLL_MEDIUM;
            backoffInterval = BACKOFF_INIT;
        } else {
            nextInterval = backoffInterval;
            backoffInterval = Math.min(backoffInterval + BACKOFF_INCREMENT, BACKOFF_MAX);
        }

        pollTimer = setTimeout(poll, nextInterval);
    };

    function startPolling() {
        clearTimeout(pollTimer);
        poll();
    }

    function stopPolling() {
        clearTimeout(pollTimer);
        pollTimer = null;
    }

    // =========================
    // 11. 会话初始化
    // =========================
async function initSession() {
    try {
        console.log('[CW] initSession start, current sid:', sid);
        const r = await fetch(API + "/init");
        const d = await r.json();
        console.log('[CW] /init response:', d);
        sid = d.sid;
        token = d.token;
        localStorage.setItem("cw_sid", sid);
        localStorage.setItem("cw_token", token);
        console.log('[CW] initSession done, new sid:', sid);
    } catch (e) {
        console.error('[CW] initSession error:', e);
        showErrorToast("连接失败，请刷新页面");
    }
}

    // =========================
    // 12. UI 交互逻辑
    // =========================
    let shrinkTimer = null;
    function clearShrinkTimer() {
        if (shrinkTimer) { clearTimeout(shrinkTimer); shrinkTimer = null; }
    }
    function scheduleShrink() {
        clearShrinkTimer();
        if (!open) {
            shrinkTimer = setTimeout(() => {
                if (!open) btn.classList.add("cw-btn-shrunk");
            }, 6000);
        }
    }

    btn.onclick = () => {
        // 移动端：打开独立聊天页面
        if (isMobileDevice()) {
            window.open(`${API}/chat.html`, '_blank');
            return;
        }

        // PC 端
        clearShrinkTimer();
        btn.classList.remove("cw-btn-shrunk", "keep-shrunk");
        open = !open;
        panel.style.display = open ? "flex" : "none";
        btn.style.display = open ? "none" : "";
        if (open) {
            input.focus();
            const last = msgsContainer.lastElementChild;
            if (last) last.scrollIntoView({ block: 'end', behavior: 'instant' });
            // 如果之前有会话且轮询未启动，则启动
            if (sid && token && !pollTimer) {
                startPolling();
            }
        } else {
            stopPolling();
            scheduleShrink();
        }
    };

    shadow.querySelector(".cw-close").onclick = (e) => {
        e.stopPropagation();
        open = false;
        panel.style.display = "none";
        btn.style.display = "";
        stopPolling();
        scheduleShrink();
    };

    let btnDragCounter = 0;
    btn.addEventListener("dragenter", (e) => {
        e.preventDefault(); e.stopPropagation();
        btnDragCounter++; btn.classList.add("keep-shrunk");
    });
    btn.addEventListener("dragleave", (e) => {
        e.preventDefault(); e.stopPropagation();
        btnDragCounter--;
        if (btnDragCounter <= 0) { btnDragCounter = 0; btn.classList.remove("keep-shrunk"); }
    });
    btn.addEventListener("drop", (e) => {
        e.preventDefault(); e.stopPropagation();
        btnDragCounter = 0; btn.classList.remove("keep-shrunk");
    });

    // =========================
    // 13. 移动端键盘适配（弹窗已废弃，保留以防直接嵌入使用）
    // =========================
    if (/Mobi|Android/i.test(navigator.userAgent)) {
        const defaultBottomPadding = 40;
        panel.style.paddingBottom = defaultBottomPadding + "px";

        if (window.visualViewport) {
            window.visualViewport.addEventListener("resize", () => {
                const heightDiff = window.innerHeight - window.visualViewport.height;
                panel.style.paddingBottom = heightDiff > 50 ? "0px" : defaultBottomPadding + "px";
            });
        } else {
            window.addEventListener("resize", () => {
                const heightDiff = window.screen.height - window.innerHeight;
                panel.style.paddingBottom = heightDiff > 150 ? "0px" : defaultBottomPadding + "px";
            });
        }
    }

    // =========================
    // 14. 启动流程
    // =========================
    (async () => {
        // 移动端无需加载弹窗资源，直接显示按钮
        if (isMobileDevice()) {
            scheduleShrink();
            return;
        }

        // 无条件初始化会话（自动覆盖本地过期的 sid/token）
        await initSession();

        if (sid && token) {
            await loadHistory({ after: 0 });
            startPolling();
        }
        scheduleShrink();
    })();
})();
