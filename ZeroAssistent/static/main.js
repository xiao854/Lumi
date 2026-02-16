let preferredPort = null;
let lastInstruction = null;
let lastPort = null;
let lastCode = null;
let lastBoardId = null;
let lastPlatform = null;
let supportedBoards = [];
let currentController = null;
let currentPhase = "idle"; // idle | generating | flashing
let currentMode = "micropython"; // micropython | platformio
let lastMode = "micropython";

async function getDevicesData(refresh = false) {
  const url = refresh ? "/api/devices?refresh=1" : "/api/devices";
  const res = await fetch(url);
  if (!res.ok) throw new Error("请求失败");
  const data = await res.json();
  return { devices: data.devices || [], guessed: data.guessed || null };
}

function updateDeviceListFromData(data) {
  const status = document.getElementById("device-status-text");
  const list = document.getElementById("device-list");
  const detail = document.getElementById("device-detail");
  if (!status || !list) return;

  const devices = data.devices || [];
  const guessed = data.guessed || null;

  if (!devices.length) {
    status.textContent = "未检测到串口设备";
    list.innerHTML = "";
    if (detail) detail.textContent = "";
    return;
  }

  status.textContent = `已检测到 ${devices.length} 个串口设备`;
  preferredPort = guessed || devices[0].device;
  list.innerHTML = "";
  if (detail) detail.textContent = "";

  devices.forEach((d) => {
    const pill = document.createElement("div");
    pill.className = "device-pill";
    const main = document.createElement("div");
    main.className = "device-pill-main";
    main.textContent = d.device;
    const sub = document.createElement("div");
    sub.className = "device-pill-sub";
    sub.textContent = d.product || d.description || "未知设备";
    pill.title = [
      d.description || "",
      d.manufacturer ? `厂商: ${d.manufacturer}` : "",
      d.hwid ? `HWID: ${d.hwid}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    pill.appendChild(main);
    pill.appendChild(sub);
    if (preferredPort === d.device) pill.classList.add("active");
    pill.addEventListener("click", () => {
      preferredPort = d.device;
      list.querySelectorAll(".device-pill").forEach((el) => {
        el.classList.toggle("active", el === pill);
      });
      if (detail) {
        detail.textContent = [
          `当前设备: ${d.device}`,
          d.product || d.description || "",
          d.manufacturer ? `厂商: ${d.manufacturer}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
      }
    });
    list.appendChild(pill);
  });

  if (detail && preferredPort) {
    const current = devices.find((d) => d.device === preferredPort) || devices[0];
    detail.textContent = [
      `当前设备: ${current.device}`,
      current.product || current.description || "",
      current.manufacturer ? `厂商: ${current.manufacturer}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
}

async function fetchDevices(refresh = false) {
  const status = document.getElementById("device-status-text");
  const list = document.getElementById("device-list");
  const detail = document.getElementById("device-detail");
  if (!status || !list) return;
  status.textContent = "正在检测串口设备...";
  list.innerHTML = "";
  if (detail) detail.textContent = "";
  try {
    const data = await getDevicesData(refresh);
    updateDeviceListFromData(data);
  } catch (e) {
    status.textContent = `串口检测失败：${e}`;
  }
}

async function loadBoards() {
  const sel = document.getElementById("board-select");
  if (!sel) return;
  try {
    const res = await fetch("/api/boards");
    const data = await res.json();
    supportedBoards = data.boards || [];
    sel.innerHTML = "";
    if (!supportedBoards.length) {
      sel.innerHTML = "<option value=\"\">无可用开发板</option>";
      return;
    }
    supportedBoards.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.name;
      opt.dataset.platform = b.platform || "";
      sel.appendChild(opt);
    });
  } catch (e) {
    sel.innerHTML = "<option value=\"\">加载失败</option>";
  }
}

function getSelectedBoard() {
  const sel = document.getElementById("board-select");
  if (!sel || !sel.value) return { id: null, platform: null };
  const platform = sel.selectedOptions[0]?.dataset?.platform || "";
  return { id: sel.value, platform };
}

async function loadToolbox(devicesDataPreloaded) {
  const container = document.getElementById("toolbox-list");
  if (!container) return;
  try {
    let scripts = [];
    let devices = [];
    let preferred = "";
    if (devicesDataPreloaded && devicesDataPreloaded.devices) {
      const scriptsRes = await fetch("/api/toolbox");
      if (!scriptsRes.ok) throw new Error(`工具箱 ${scriptsRes.status}`);
      const scriptsData = await scriptsRes.json();
      scripts = scriptsData.scripts || [];
      devices = devicesDataPreloaded.devices || [];
      preferred = devicesDataPreloaded.guessed || (devices[0]?.device ?? "");
    } else {
      const [scriptsRes, devicesRes] = await Promise.all([
        fetch("/api/toolbox"),
        fetch("/api/devices"),
      ]);
      if (!scriptsRes.ok || !devicesRes.ok) {
        throw new Error(scriptsRes.ok ? `设备列表 ${devicesRes.status}` : `工具箱 ${scriptsRes.status}`);
      }
      const scriptsData = await scriptsRes.json();
      const devicesData = await devicesRes.json();
      scripts = scriptsData.scripts || [];
      devices = devicesData.devices || [];
      preferred = devicesData.guessed || (devices[0]?.device ?? "");
    }

    const withShortcuts = [
      {
        id: "_flash_last",
        name: "烧录上次代码",
        description: "使用上一条生成的代码直接烧录，不重新调用模型",
        category: "设备",
        params: [],
      },
      ...scripts,
    ];

    const byCategory = {};
    withShortcuts.forEach((s) => {
      const cat = s.category || "其他";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(s);
    });

    container.innerHTML = "";
    ["维护", "设备", "环境", "代码", "文档", "其他"].forEach((cat) => {
      if (!byCategory[cat]?.length) return;
      const section = document.createElement("div");
      section.className = "toolbox-section";
      const title = document.createElement("div");
      title.className = "toolbox-section-title";
      title.textContent = cat;
      section.appendChild(title);
      byCategory[cat].forEach((s) => {
        const card = document.createElement("div");
        card.className = "toolbox-card";
        card.dataset.scriptId = s.id;
        card.dataset.searchable = [s.name || "", s.description || "", s.category || ""].join(" ").toLowerCase();
        card.innerHTML = `
          <div class="toolbox-card-name">${escapeHtml(s.name)}</div>
          <div class="toolbox-card-desc">${escapeHtml(s.description)}</div>
          <div class="toolbox-card-params" data-script-id="${s.id}"></div>
          <button type="button" class="toolbox-card-run" data-script-id="${s.id}">运行</button>
          <div class="toolbox-card-category">${escapeHtml(s.category)}</div>
        `;
        const paramsEl = card.querySelector(".toolbox-card-params");
        if (s.params && s.params.length) {
          s.params.forEach((p) => {
            if (p.key === "port") {
              const sel = document.createElement("select");
              sel.dataset.param = p.key;
              sel.innerHTML = "<option value=\"\">选择串口</option>";
              devices.forEach((d) => {
                const opt = document.createElement("option");
                opt.value = d.device;
                opt.textContent = d.device;
                if (d.device === preferred) opt.selected = true;
                sel.appendChild(opt);
              });
              paramsEl.appendChild(sel);
            } else if (p.key === "code") {
              const hint = document.createElement("span");
              hint.className = "toolbox-param-hint";
              hint.textContent = "将使用上一条生成的代码";
              hint.style.fontSize = "9px";
              hint.style.color = "var(--text-secondary)";
              paramsEl.appendChild(hint);
            } else if (p.key === "suffix") {
              const input = document.createElement("input");
              input.type = "text";
              input.dataset.param = p.key;
              input.placeholder = ".py 或 .cpp";
              input.value = ".py";
              paramsEl.appendChild(input);
            } else if (["download_path", "pdf_path", "output_path"].indexOf(p.key) !== -1) {
              const wrap = document.createElement("div");
              wrap.className = "toolbox-param-wrap toolbox-param-path";
              const input = document.createElement("input");
              input.type = "text";
              input.dataset.param = p.key;
              input.placeholder = p.label || p.key;
              input.style.fontSize = "11px";
              wrap.appendChild(input);
              const previewWrap = document.createElement("div");
              previewWrap.className = "toolbox-path-preview-wrap";
              const preview = document.createElement("code");
              preview.className = "toolbox-path-preview";
              preview.dataset.paramPreviewFor = p.key;
              preview.title = "当前路径，点击复制";
              preview.textContent = "（未填写）";
              previewWrap.appendChild(preview);
              wrap.appendChild(previewWrap);
              paramsEl.appendChild(wrap);
              input.addEventListener("input", () => {
                const v = input.value.trim();
                preview.textContent = v ? v : "（未填写）";
              });
              input.addEventListener("change", () => {
                const v = input.value.trim();
                preview.textContent = v ? v : "（未填写）";
              });
              preview.addEventListener("click", () => {
                const v = input.value.trim();
                if (!v) {
                  showToast("暂无路径可复制", "error");
                  return;
                }
                navigator.clipboard.writeText(v).then(() => showToast("已复制路径", "success")).catch(() => showToast("复制失败", "error"));
              });
            } else {
              const input = document.createElement("input");
              input.type = "text";
              input.dataset.param = p.key;
              input.placeholder = p.label || p.key;
              input.style.fontSize = "11px";
              paramsEl.appendChild(input);
            }
          });
        }
        section.appendChild(card);
      });
      container.appendChild(section);
    });

    const toolboxSearchInput = document.getElementById("toolbox-search");
    function filterToolboxBySearch() {
      const q = (toolboxSearchInput?.value || "").trim().toLowerCase();
      container.querySelectorAll(".toolbox-section").forEach((section) => {
        let visibleCount = 0;
        section.querySelectorAll(".toolbox-card").forEach((card) => {
          const match = !q || (card.dataset.searchable || "").indexOf(q) !== -1;
          card.classList.toggle("toolbox-card-hidden", !match);
          if (match) visibleCount++;
        });
        section.classList.toggle("toolbox-section-empty", visibleCount === 0);
      });
    }
    if (toolboxSearchInput) {
      toolboxSearchInput.addEventListener("input", filterToolboxBySearch);
      toolboxSearchInput.addEventListener("keydown", (e) => { if (e.key === "Escape") { toolboxSearchInput.value = ""; filterToolboxBySearch(); toolboxSearchInput.blur(); } });
    }

    container.addEventListener("click", async (e) => {
      const btn = e.target.closest(".toolbox-card-run");
      if (!btn) return;
      const scriptId = btn.dataset.scriptId;
      const card = btn.closest(".toolbox-card");
      if (!card) return;
      const params = {};
      card.querySelectorAll("[data-param]").forEach((el) => {
        params[el.dataset.param] = el.value != null ? String(el.value).trim() : "";
      });
      if (scriptId === "export_code") {
        if (!lastCode) {
          showToast("请先生成一次代码后再导出", "error");
          appendProcessLog("工具箱：请先生成一次代码后再导出。");
          return;
        }
        params.code = lastCode;
        if (!params.suffix) params.suffix = lastMode === "platformio" ? ".cpp" : ".py";
      }
      if (scriptId === "_flash_last") {
        if (!lastCode || !lastInstruction) {
          showToast("请先发送指令并生成代码后再烧录", "error");
          appendProcessLog("工具箱：请先发送一条指令并生成代码后再烧录。");
          return;
        }
        const runText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "运行中…";
        try {
          const body = {
            instruction: lastInstruction,
            port: lastPort || preferredPort || "",
            auto_flash: true,
            use_search: false,
            mode: lastMode,
            reuse_code: true,
            code: lastCode,
          };
          if (lastMode === "platformio" && (lastBoardId || lastPlatform)) {
            if (lastBoardId) body.board_id = lastBoardId;
            if (lastPlatform) body.platform = lastPlatform;
          }
          const res = await fetch("/api/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          const processLog = document.getElementById("process-log");
          if (processLog) {
            const lines = (data.logs || []).length
              ? (data.logs || []).map((l) => "[工具箱] " + l).join("\n")
              : "[工具箱] " + (data.error || data.ok ? "烧录请求已发送" : "失败");
            processLog.textContent = (processLog.textContent || "") + "\n" + lines;
            processLog.scrollTop = processLog.scrollHeight;
          }
          if (data.ok && data.code) lastCode = data.code;
          if (data.ok) showToast("烧录请求已发送", "success");
        } finally {
          btn.disabled = false;
          btn.textContent = runText;
        }
        return;
      }
      const runText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "运行中…";
      try {
        const res = await fetch("/api/toolbox/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ script_id: scriptId, params }),
        });
        const data = await res.json();
        const processLog = document.getElementById("process-log");
        if (processLog) {
          const lines = (data.logs || []).length
            ? (data.logs || []).map((l) => "[工具箱] " + l).join("\n")
            : "[工具箱] " + (data.error || "完成");
          processLog.textContent = (processLog.textContent || "") + "\n" + lines;
          processLog.scrollTop = processLog.scrollHeight;
        }
        if (!data.ok) {
          appendProcessLog("工具箱执行失败: " + (data.error || "未知错误"));
          showToast("执行失败：" + (data.error || "未知错误"), "error");
        } else {
          showToast("执行完成", "success");
          if (scriptId === "refresh_devices") {
            getDevicesData(true).then(updateDeviceListFromData).catch(() => {});
          }
        }
      } finally {
        btn.disabled = false;
        btn.textContent = runText;
      }
    });
  } catch (e) {
    const msg = e?.message || String(e);
    container.innerHTML =
      "<div class=\"toolbox-loading\" title=\"" +
      escapeHtml(msg) +
      "\">加载失败" +
      (msg ? "：" + escapeHtml(msg) : "") +
      "</div>";
  }
}

function escapeHtml(s) {
  if (!s) return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function showToast(message, type = "") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = "toast" + (type ? " toast-" + type : "");
  el.textContent = message;
  el.setAttribute("role", "status");
  container.appendChild(el);
  const duration = type === "error" ? 4000 : 2500;
  const t = setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.2s";
    setTimeout(() => el.remove(), 200);
  }, duration);
  el.addEventListener("click", () => {
    clearTimeout(t);
    el.style.opacity = "0";
    el.style.transition = "opacity 0.2s";
    setTimeout(() => el.remove(), 200);
  });
}

const PROCESS_LOG_MAX_LEN = 80000;

function appendProcessLog(msg) {
  const processLog = document.getElementById("process-log");
  const scrollBtn = document.getElementById("process-log-scroll-btn");
  if (!processLog) return;
  let text = (processLog.textContent || "") + "\n" + msg;
  if (text.length > PROCESS_LOG_MAX_LEN) {
    text = "[日志已截断，仅保留最近内容]\n" + text.slice(-PROCESS_LOG_MAX_LEN);
  }
  processLog.textContent = text;
  processLog.scrollTop = processLog.scrollHeight;
  if (scrollBtn) scrollBtn.classList.add("hidden");
}

async function runAgent() {
  const btn = document.getElementById("run-agent");
  const select = document.getElementById("device-select");
  const textarea = document.getElementById("instruction");
  const autoFlash = document.getElementById("auto-flash");
  const preview = document.getElementById("preview");
  const logs = document.getElementById("logs");

  if (!textarea.value.trim()) {
    showToast("请先输入指令", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "运行中…";
  preview.textContent = "";
  logs.textContent = "开始执行 Agent...\n";

  try {
    const body = {
      instruction: textarea.value,
      port: select.value || "",
      auto_flash: autoFlash.checked,
    };

    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!data.ok) {
      logs.textContent += `\n[错误] ${data.error || "未知错误"}`;
      if (data.logs && data.logs.length) {
        logs.textContent += "\n" + data.logs.join("\n");
      }
      return;
    }

    if (data.preview) {
      preview.textContent = data.preview;
    } else {
      preview.textContent = "// 无预览内容";
    }

    if (data.logs && data.logs.length) {
      logs.textContent += "\n" + data.logs.join("\n");
    } else {
      logs.textContent += "\n执行完成。";
    }
  } catch (e) {
    logs.textContent += `\n[异常] ${e}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "生成并执行";
  }
}

async function editDesktopFile() {
  const btn = document.getElementById("edit-desktop-file");
  const pathInput = document.getElementById("desktop-path");
  const instruction = document.getElementById("desktop-instruction");
  const preview = document.getElementById("desktop-preview");
  const logs = document.getElementById("desktop-logs");

  if (!pathInput.value.trim()) {
    showToast("请输入桌面文件的相对路径", "error");
    return;
  }
  if (!instruction.value.trim()) {
    showToast("请输入希望 Lumi 做的修改", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "处理中…";
  preview.textContent = "";
  logs.textContent = "开始调用 Lumi 修改桌面文件...\n";

  try {
    const body = {
      relative_path: pathInput.value,
      instruction: instruction.value,
    };

    const res = await fetch("/api/edit-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!data.ok) {
      logs.textContent += `\n[错误] ${data.error || "未知错误"}`;
      if (data.logs && data.logs.length) {
        logs.textContent += "\n" + data.logs.join("\n");
      }
      return;
    }

    if (data.preview) {
      preview.textContent = data.preview;
    } else {
      preview.textContent = "// 无预览内容";
    }

    if (data.logs && data.logs.length) {
      logs.textContent += "\n" + data.logs.join("\n");
    } else {
      logs.textContent += "\n修改完成。";
    }
  } catch (e) {
    logs.textContent += `\n[异常] ${e}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "生成修改并保存到桌面文件";
  }
}

async function githubFlash() {
  const btn = document.getElementById("github-flash");
  const urlInput = document.getElementById("github-url");
  const select = document.getElementById("device-select");
  const autoFlash = document.getElementById("auto-flash");
  const preview = document.getElementById("preview");
  const logs = document.getElementById("logs");

  if (!urlInput.value.trim()) {
    showToast("请输入 GitHub 文件的 URL", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "处理中…";
  preview.textContent = "";
  logs.textContent = "开始从 GitHub 下载并准备烧录...\n";

  try {
    const body = {
      url: urlInput.value,
      port: select.value || "",
      auto_flash: autoFlash.checked,
    };

    const res = await fetch("/api/github-flash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!data.ok) {
      logs.textContent += `\n[错误] ${data.error || "未知错误"}`;
      if (data.logs && data.logs.length) {
        logs.textContent += "\n" + data.logs.join("\n");
      }
      return;
    }

    if (data.preview) {
      preview.textContent = data.preview;
    } else {
      preview.textContent = "// 无预览内容";
    }

    if (data.logs && data.logs.length) {
      logs.textContent += "\n" + data.logs.join("\n");
    } else {
      logs.textContent += "\n完成 GitHub 文件下载及烧录。";
    }
  } catch (e) {
    logs.textContent += `\n[异常] ${e}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "下载并烧录到 main.py";
  }
}

function escapeHtmlForChat(s) {
  if (!s) return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

/** 将消息中的 ``` 代码块转为 <pre><code>，其余部分转义后显示 */
function formatMessageBody(text) {
  const escaped = escapeHtmlForChat(text);
  const blockRegex = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  const parts = [];
  let lastIndex = 0;
  let m;
  while ((m = blockRegex.exec(escaped)) !== null) {
    parts.push(escaped.slice(lastIndex, m.index));
    const code = escapeHtmlForChat(m[2].trim());
    const lang = m[1].trim() ? ` data-lang="${escapeHtmlForChat(m[1])}"` : "";
    parts.push(`<pre class="chat-code-block"${lang}><code>${code}</code></pre>`);
    lastIndex = m.index + m[0].length;
  }
  parts.push(escaped.slice(lastIndex));
  return parts.join("").replace(/\n/g, "<br>");
}

function appendMessage(role, text) {
  const win = document.getElementById("chat-window");
  if (!win) return;
  const placeholder = win.querySelector(".chat-placeholder");
  if (placeholder) placeholder.remove();

  const wrapper = document.createElement("div");
  wrapper.className = `chat-message chat-message-${role}`;

  const roleEl = document.createElement("div");
  roleEl.className = "chat-message-role";
  roleEl.textContent = role === "user" ? "You" : "Lumi";

  const bodyEl = document.createElement("div");
  bodyEl.className = "chat-message-body";
  bodyEl.innerHTML = formatMessageBody(text);

  wrapper.appendChild(roleEl);
  wrapper.appendChild(bodyEl);
  win.appendChild(wrapper);
  win.scrollTop = win.scrollHeight;
}

function clearChat() {
  const win = document.getElementById("chat-window");
  const hardwareView = document.getElementById("content-view-hardware");
  const contentWrap = document.querySelector(".app-content-wrap");
  if (!win) return;
  win.querySelectorAll(".chat-message").forEach((el) => el.remove());
  const placeholder = document.createElement("div");
  placeholder.className = "chat-placeholder";
  placeholder.textContent =
    "你可以让 Lumi 为你的硬件写代码、烧录到设备，或者从 GitHub 拉取项目并部署到板子上。";
  win.appendChild(placeholder);
  if (hardwareView) hardwareView.classList.remove("has-messages");
  if (contentWrap) contentWrap.classList.remove("hardware-chat-active");
  showToast("对话已清空");
}

async function sendChat() {
  const input = document.getElementById("chat-input");
  const searchBtn = document.getElementById("btn-search-toggle");
  const processLog = document.getElementById("process-log");
  const sendBtn = document.getElementById("chat-send");
  const stopBtn = document.getElementById("chat-stop");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  if (!input || !input.value.trim()) {
    showToast("请输入消息后再发送", "error");
    return;
  }

  const text = input.value.trim();
  lastInstruction = text;
  lastMode = currentMode;
  lastCode = null;
  appendMessage("user", text);
  input.value = "";

  const hardwareView = document.getElementById("content-view-hardware");
  const contentWrap = document.querySelector(".app-content-wrap");
  if (hardwareView) hardwareView.classList.add("has-messages");
  if (contentWrap) contentWrap.classList.add("hardware-chat-active");

  const loadingText = "Lumi 正在思考并为你的硬件生成/执行操作...";
  appendMessage("assistant", loadingText);

  if (processLog) {
    processLog.textContent =
      "步骤 1/2：正在调用模型生成 main.py 代码...\n" +
      "指令摘要: " +
      (text.length > 80 ? text.slice(0, 77) + "..." : text);
  }

  if (progressFill) progressFill.style.width = "20%";
  if (progressText) progressText.textContent = "生成中";
  currentPhase = "generating";

  const sendBtnOriginalText = sendBtn?.textContent ?? "↑";
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.classList.add("loading");
    sendBtn.title = "发送中…";
    sendBtn.textContent = "生成中…";
  }
  if (stopBtn) stopBtn.disabled = false;

  const controller = new AbortController();
  currentController = controller;

  try {
    const body = {
      instruction: text,
      port: preferredPort || "",
      auto_flash: false,
      use_search: searchBtn ? searchBtn.classList.contains("active") : false,
      mode: currentMode,
    };
    if (currentMode === "platformio") {
      const board = getSelectedBoard();
      if (board.id) body.board_id = board.id;
      if (board.platform) body.platform = board.platform;
    } else {
      const multiFileEl = document.getElementById("multi-file-checkbox");
      if (multiFileEl && multiFileEl.checked) body.multi_file = true;
    }

    let res;
    try {
      res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const win = document.getElementById("chat-window");
      if (win) {
        const last = win.lastElementChild;
        if (last && last.querySelector(".chat-message-role")?.textContent === "Lumi") win.removeChild(last);
      }
      appendMessage("assistant", "网络请求失败，请检查连接或稍后重试。");
      showToast("请求失败：" + (err.message || "网络错误"), "error");
      return;
    }

    let data;
    try {
      data = await res.json();
    } catch (_) {
      const win = document.getElementById("chat-window");
      if (win) {
        const last = win.lastElementChild;
        if (last && last.querySelector(".chat-message-role")?.textContent === "Lumi") win.removeChild(last);
      }
      appendMessage("assistant", "服务器返回格式异常，请稍后重试。");
      showToast("响应解析失败", "error");
      return;
    }

    // 删除最后一条 loading 消息，再追加正式回复
    const win = document.getElementById("chat-window");
    if (win) {
      const last = win.lastElementChild;
      if (last && last.querySelector(".chat-message-role")?.textContent === "Lumi") {
        win.removeChild(last);
      }
    }

    if (!data.ok) {
      appendMessage("assistant", `出错了：${data.error || "未知错误"}`);
      showToast(data.error || "未知错误", "error");
      return;
    }

    lastPort = data.port || preferredPort || "";
    lastCode = data.code || null;
    if (currentMode === "platformio") {
      const board = getSelectedBoard();
      lastBoardId = board.id || null;
      lastPlatform = board.platform || null;
    }

    const preview = data.preview || "";
    const logs = (data.logs || []).join("\n");
    const isMultiFile = !!data.multi_file && data.files && Object.keys(data.files).length > 1;
    let reply = "";
    if (preview) {
      reply += isMultiFile
        ? "已为你生成多文件项目（预览）：\n" + preview
        : "已为你生成 main.py 代码（前部分预览）：\n" + preview;
    }
    if (logs) {
      reply += (reply ? "\n\n执行日志：\n" : "执行日志：\n") + logs;
    }
    if (!reply) {
      reply = "操作已完成。";
    }

    appendMessage("assistant", reply);

    if (processLog) {
      processLog.textContent =
        "步骤 1/2：代码生成完成。\n\n" +
        (preview ? "代码预览（前 80 行）：\n" + preview + "\n\n" : "") +
        (logs ? "生成阶段日志：\n" + logs : "");
    }

    if (progressFill) progressFill.style.width = "60%";
    if (progressText) progressText.textContent = "待烧录";

    const flashBar = document.getElementById("flash-bar");
    if (flashBar && lastInstruction) {
      const label = flashBar.querySelector("span");
      if (label) {
        label.textContent = lastPort
          ? `是否将上一条指令生成的代码烧录到设备（端口：${lastPort}）？`
          : "是否将上一条指令生成的代码烧录到设备？";
      }
      flashBar.classList.remove("hidden");
    }
  } catch (e) {
    if (e.name === "AbortError") {
      appendMessage("assistant", "已停止当前回答。");
      if (progressFill) progressFill.style.width = "0%";
      if (progressText) progressText.textContent = "已停止";
    } else {
      appendMessage("assistant", `请求失败：${e}`);
      if (progressFill) progressFill.style.width = "0%";
      if (progressText) progressText.textContent = "空闲";
      appendProcessLog(`[错误] 请求失败：${e.message || e}`);
    }
  } finally {
    currentController = null;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.classList.remove("loading");
      sendBtn.title = "";
      sendBtn.textContent = sendBtnOriginalText !== undefined ? sendBtnOriginalText : "↑";
    }
    if (stopBtn) stopBtn.disabled = true;
    if (input) input.focus();
  }
}

async function flashLastInstruction() {
  if (!lastInstruction) {
    appendMessage("assistant", "当前没有可烧录的指令，请先让 Lumi 生成一次代码。");
    return;
  }

  appendMessage("assistant", "正在使用上一条生成的代码烧录到设备（不会重新调用模型）...");

  const processLog = document.getElementById("process-log");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  if (processLog) {
    processLog.textContent =
      "步骤 2/2：正在使用上一条生成的代码烧录到设备...\n" +
      (lastPort ? `目标端口: ${lastPort}\n` : "");
  }

  if (progressFill) progressFill.style.width = "80%";
  if (progressText) progressText.textContent = "烧录中";
  currentPhase = "flashing";

  try {
    const body = {
      instruction: lastInstruction,
      port: lastPort || preferredPort || "",
      auto_flash: true,
      use_search: false,
      mode: lastMode,
      reuse_code: !!lastCode,
      code: lastCode || "",
    };
    if (lastMode === "platformio" && (lastBoardId || lastPlatform)) {
      if (lastBoardId) body.board_id = lastBoardId;
      if (lastPlatform) body.platform = lastPlatform;
    }

    let res;
    try {
      res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      appendMessage("assistant", "烧录请求失败，请检查网络后重试。");
      showToast("请求失败：" + (e.message || "网络错误"), "error");
      if (progressFill) progressFill.style.width = "0%";
      if (progressText) progressText.textContent = "失败";
      return;
    }

    let data;
    try {
      data = await res.json();
    } catch (_) {
      appendMessage("assistant", "服务器返回格式异常，请稍后重试。");
      showToast("响应解析失败", "error");
      if (progressFill) progressFill.style.width = "0%";
      if (progressText) progressText.textContent = "失败";
      return;
    }

    if (!data.ok) {
      appendMessage("assistant", `烧录失败：${data.error || "未知错误"}`);
      showToast(data.error || "烧录失败", "error");
      if (progressFill) progressFill.style.width = "0%";
      if (progressText) progressText.textContent = "失败";
      return;
    }

    const logs = (data.logs || []).join("\n");
    let reply = "烧录已完成。";
    if (logs) {
      reply += "\n\n执行日志：\n" + logs;
    }
    appendMessage("assistant", reply);

    if (processLog) {
      processLog.textContent =
        (processLog.textContent ? processLog.textContent + "\n\n" : "") +
        "步骤 2/2：烧录完成。\n" +
        (logs ? "烧录阶段日志：\n" + logs : "");
    }
    if (progressFill) progressFill.style.width = "100%";
    if (progressText) progressText.textContent = "完成";

    const flashBar = document.getElementById("flash-bar");
    if (flashBar) {
      flashBar.classList.add("hidden");
    }
  } catch (e) {
    appendMessage("assistant", `烧录请求失败：${e}`);
    const progressText = document.getElementById("progress-text");
    if (progressText) progressText.textContent = "失败";
  }
}

function buildEnvStatusText(data, pingData) {
  const lines = [];
  lines.push("当前模型接口: " + (data.model_provider_label || "未知"));
  if (data.model_name) {
    lines.push("当前模型: " + data.model_name);
  }
  lines.push("API Key: " + (data.has_api_key ? "已配置" : "未检测到（需设置 DEEPSEEK_API_KEY、DASHSCOPE_API_KEY 或 您的本地API 对应 QWEN_API_BASE）"));
  lines.push("mpremote: " + (data.has_mpremote ? (data.mpremote_path || "已找到") : "未找到，请先安装 mpremote"));
  lines.push("PlatformIO: " + (data.has_platformio ? "已找到" : "未找到"));
  if (pingData) {
    if (pingData.ok) {
      lines.push("模型连通: 正常（" + (pingData.latency_ms != null ? pingData.latency_ms : 0) + " ms）");
    } else {
      lines.push("模型连通: 异常 - " + (pingData.error || "未知错误"));
    }
  } else {
    lines.push("模型连通: 检测失败");
  }
  return lines.join("\n");
}

async function runDevCheckEnv() {
  const resultEl = document.getElementById("dev-status-result");
  const banner = document.getElementById("status-banner");
  const bannerText = document.getElementById("status-text");
  if (resultEl) resultEl.textContent = "检测中…";
  try {
    const [statusRes, pingRes] = await Promise.all([
      fetch("/api/status"),
      fetch("/api/model-ping"),
    ]);
    const data = statusRes.ok ? await statusRes.json() : null;
    let pingData = null;
    try {
      pingData = await pingRes.json();
    } catch (_) {}
    if (!pingData && !pingRes.ok) {
      pingData = { ok: false, error: pingRes.statusText || "HTTP " + pingRes.status };
    }
    if (!data) {
      if (resultEl) resultEl.textContent = "无法获取运行环境状态，请检查后端是否已启动。";
      if (banner && bannerText) {
        banner.classList.remove("status-loading");
        banner.classList.add("status-error");
        bannerText.textContent = "环境异常 · 请查看开发者调试";
        banner.style.cursor = "pointer";
        banner.title = "点击重试";
      }
      return;
    }
    const text = buildEnvStatusText(data, pingData);
    if (resultEl) resultEl.textContent = text;
    if (banner && bannerText) {
      banner.classList.remove("status-loading");
      if (data.has_api_key && data.has_mpremote && pingData && pingData.ok) {
        banner.classList.add("status-ok");
        banner.classList.remove("status-warn", "status-error");
        bannerText.textContent = "运行正常";
        banner.style.cursor = "";
        banner.title = "";
      } else {
        banner.classList.add("status-warn");
        banner.classList.remove("status-ok", "status-error");
        bannerText.textContent = "环境异常 · 请查看开发者调试";
        banner.style.cursor = "pointer";
        banner.title = "点击重试";
      }
    }
  } catch (e) {
    if (resultEl) resultEl.textContent = "检测异常：" + e;
    if (banner && bannerText) {
      banner.classList.remove("status-loading");
      banner.classList.add("status-error");
      bannerText.textContent = "环境异常 · 请查看开发者调试";
      banner.style.cursor = "pointer";
      banner.title = "点击重试";
    }
  }
}

async function loadStatus() {
  const banner = document.getElementById("status-banner");
  const text = document.getElementById("status-text");
  if (!banner || !text) return;

  try {
    const [statusRes, pingRes] = await Promise.all([
      fetch("/api/status"),
      fetch("/api/model-ping"),
    ]);

    const data = statusRes.ok ? await statusRes.json() : null;
    let pingData = null;
    try {
      pingData = await pingRes.json();
    } catch (_) {}
    if (!pingData && !pingRes.ok) {
      pingData = { ok: false, error: pingRes.statusText || "请求失败" };
    }

    if (!data) {
      banner.classList.remove("status-loading");
      banner.classList.add("status-error");
      text.textContent = "环境异常 · 无法获取状态，请确认后端已启动";
      banner.style.cursor = "pointer";
      banner.title = "点击重试";
      return;
    }

    function envAbnormalReason() {
      const parts = [];
      if (!data.has_api_key) parts.push("未配置 API 密钥");
      if (!data.has_mpremote) parts.push("未找到 mpremote");
      if (!pingData || !pingData.ok) parts.push(pingData && pingData.error ? "模型不可达: " + pingData.error : "模型连通异常");
      return parts.length ? parts.join("；") : "";
    }

    banner.classList.remove("status-loading");
    if (data.has_api_key && data.has_mpremote && pingData && pingData.ok) {
      banner.classList.add("status-ok");
      banner.style.cursor = "";
      banner.title = "";
      text.textContent = "运行正常";
    } else {
      banner.classList.add("status-warn");
      banner.style.cursor = "pointer";
      const reason = envAbnormalReason();
      banner.title = reason ? reason + "（点击重试）" : "点击重试";
      text.textContent = reason ? "环境异常 · " + reason : "环境异常 · 请打开开发者调试查看";
    }
  } catch (e) {
    banner.classList.remove("status-loading");
    banner.classList.add("status-error");
    text.textContent = "环境异常 · 网络或后端错误";
    banner.style.cursor = "pointer";
    banner.title = (e && e.message) ? e.message + "（点击重试）" : "点击重试";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const runBtn = document.getElementById("run-agent");
  const editFileBtn = document.getElementById("edit-desktop-file");
  const githubBtn = document.getElementById("github-flash");
  const navItems = document.querySelectorAll(".sidebar-nav-item");
  const views = document.querySelectorAll(".main-view");
  const chatSendBtn = document.getElementById("chat-send");
  const chatInput = document.getElementById("chat-input");
  const searchBtn = document.getElementById("btn-search-toggle");
  const flashConfirmBtn = document.getElementById("flash-confirm");
  const quickActionBtns = document.querySelectorAll(".quick-action");
  const chatStopBtn = document.getElementById("chat-stop");
  const modeButtons = document.querySelectorAll(".mode-btn");
  const modelTag = document.getElementById("hardware-model-tag") || document.querySelector(".model-tag");
  const boardSelectWrap = document.getElementById("board-select-wrap");

  let hardwareModelProviderLabel = "";

  function updateHardwareModelTag() {
    if (!modelTag) return;
    const provider = hardwareModelProviderLabel || "您的本地API";
    const suffix = currentMode === "platformio" ? "C++ / PlatformIO（多开发板）" : "MicroPython";
    modelTag.textContent = "当前模型：" + provider + " · Lumi · " + suffix;
  }

  async function updateHardwareModelProvider() {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      hardwareModelProviderLabel = data.model_provider_label || "您的本地API";
      updateHardwareModelTag();
    } catch (e) {
      hardwareModelProviderLabel = "您的本地API";
      updateHardwareModelTag();
    }
  }

  loadBoards();
  getDevicesData(false)
    .then((data) => {
      updateDeviceListFromData(data);
      return loadToolbox(data);
    })
    .catch(() => {
      loadToolbox();
    });

  const toolboxToggle = document.getElementById("toolbox-toggle");
  const toolboxList = document.getElementById("toolbox-list");
  if (toolboxToggle && toolboxList) {
    toolboxToggle.addEventListener("click", () => {
      const collapsed = toolboxList.classList.toggle("toolbox-list-collapsed");
      toolboxToggle.setAttribute("aria-expanded", String(!collapsed));
      toolboxToggle.textContent = collapsed ? "展开" : "收起";
    });
  }

  async function updateDevModelProvider() {
    const labelEl = document.getElementById("dev-model-provider");
    const nameEl = document.getElementById("dev-model-name");
    if (!labelEl) return;
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      labelEl.textContent = data.model_provider_label || "未配置";
      if (nameEl) {
        nameEl.textContent = data.model_name ? "模型: " + data.model_name : "";
        nameEl.style.display = data.model_name ? "" : "none";
      }
    } catch (e) {
      labelEl.textContent = "获取失败";
      if (nameEl) nameEl.textContent = "";
    }
  }

  const VIEW_TRANSITION_MS = 200;
  document.querySelectorAll(".left-sidebar-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view;
      document.querySelectorAll(".left-sidebar-item").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const currentActive = document.querySelector(".content-view.active");
      const target = document.getElementById("content-view-" + view);
      if (currentActive && target && currentActive !== target) {
        currentActive.classList.add("content-view-leaving");
        setTimeout(() => {
          document.querySelectorAll(".content-view").forEach((v) => {
            v.classList.remove("active", "content-view-leaving");
          });
          target.classList.add("active");
        }, VIEW_TRANSITION_MS);
      } else {
        document.querySelectorAll(".content-view").forEach((v) => v.classList.remove("active", "content-view-leaving"));
        if (target) target.classList.add("active");
      }
      if (view === "dev") updateDevModelProvider();
      if (view === "hardware") updateHardwareModelProvider();
      const contentWrap = document.querySelector(".app-content-wrap");
      const hardwareView = document.getElementById("content-view-hardware");
      if (contentWrap && hardwareView) {
        if (view === "hardware" && hardwareView.classList.contains("has-messages")) {
          contentWrap.classList.add("hardware-chat-active");
        } else {
          contentWrap.classList.remove("hardware-chat-active");
        }
        if (["ai-edit", "toolbox", "assistant", "create-agent", "dev"].indexOf(view) !== -1) {
          contentWrap.classList.add("content-view-full");
        } else {
          contentWrap.classList.remove("content-view-full");
        }
      }
    });
  });

  // 电脑助手
  let lastAssistantTerminalReply = "";
  const assistantChat = document.getElementById("assistant-chat");
  const assistantInput = document.getElementById("assistant-input");
  const assistantSendBtn = document.getElementById("assistant-send");
  const assistantPlanDisplay = document.getElementById("assistant-plan-display");
  const assistantRunCmdBtn = document.getElementById("assistant-run-cmd");
  const assistantStopBtn = document.getElementById("assistant-stop");
  const ASSISTANT_TODO_KEY = "lumi_assistant_todo";
  let assistantController = null;

  const assistantFilePanel = document.getElementById("assistant-file-panel");
  const assistantFilePanelPath = document.getElementById("assistant-file-panel-path");
  const assistantFileDiff = document.getElementById("assistant-file-diff");
  const assistantFilePanelEmpty = document.getElementById("assistant-file-panel-empty");
  const assistantFilePanelClose = document.getElementById("assistant-file-panel-close");
  const assistantFilePanelToolbar = document.getElementById("assistant-file-panel-toolbar");
  const assistantFilePanelFilename = document.getElementById("assistant-file-panel-filename");
  const assistantFilePanelToolbarClose = document.getElementById("assistant-file-panel-toolbar-close");
  const assistantFilePanelActions = document.getElementById("assistant-file-panel-actions");
  const assistantFileOpenBtn = document.getElementById("assistant-file-open-btn");
  const assistantFileCreateBtn = document.getElementById("assistant-file-create-btn");
  const assistantFilePanelWriteStatus = document.getElementById("assistant-file-panel-write-status");
  const assistantFilePanelMentioned = document.getElementById("assistant-file-panel-mentioned");
  const assistantFilePanelMentionedList = document.getElementById("assistant-file-panel-mentioned-list");
  const assistantThinking = document.getElementById("assistant-thinking");
  const assistantProgressWrap = document.getElementById("assistant-progress-wrap");
  let assistantFilePanelCurrentPath = null;

  function diffLines(before, after) {
    const a = (before || "").split("\n");
    const b = (after || "").split("\n");
    const m = a.length, n = b.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    const ops = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        ops.push({ op: "eq", line: a[i - 1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        ops.push({ op: "add", line: b[j - 1] });
        j--;
      } else {
        ops.push({ op: "del", line: a[i - 1] });
        i--;
      }
    }
    return ops.reverse();
  }

  function renderFileDiff(fileEdit) {
    if (!fileEdit || !assistantFilePanel || !assistantFileDiff || !assistantFilePanelPath) return;
    const path = fileEdit.path || "";
    const before = fileEdit.before || "";
    const after = fileEdit.after || "";
    const writeOk = fileEdit.write_ok !== false;
    assistantFilePanelCurrentPath = path;
    assistantFilePanelPath.textContent = path;
    const basename = path.split(/[/\\]/).filter(Boolean).pop() || path;
    if (assistantFilePanelFilename) {
      assistantFilePanelFilename.textContent = basename;
      assistantFilePanelFilename.title = path;
    }
    if (assistantFilePanelToolbar) assistantFilePanelToolbar.classList.remove("hidden");
    if (assistantFilePanelActions) assistantFilePanelActions.classList.remove("hidden");
    if (assistantFilePanelWriteStatus) {
      if (writeOk) {
        assistantFilePanelWriteStatus.classList.add("hidden");
        assistantFilePanelWriteStatus.textContent = "";
      } else {
        assistantFilePanelWriteStatus.textContent = "⚠️ 未写回原文件（可能因内容过短被拒绝），仅显示对比。";
        assistantFilePanelWriteStatus.classList.remove("hidden");
      }
    }
    const ops = diffLines(before, after);
    const html = ops
      .map(({ op, line }) => {
        const escaped = escapeHtml(line || " ");
        const cls = op === "del" ? "diff-line diff-del" : op === "add" ? "diff-line diff-add" : "diff-line";
        return `<span class="${cls}">${escaped}</span>`;
      })
      .join("\n");
    assistantFileDiff.innerHTML = html;
    assistantFilePanel.classList.add("has-diff");
    if (assistantFilePanelEmpty) assistantFilePanelEmpty.style.display = "none";
  }

  function renderMentionedFiles(list) {
    if (!assistantFilePanelMentioned || !assistantFilePanelMentionedList) return;
    if (!list || list.length === 0) {
      assistantFilePanelMentioned.classList.add("hidden");
      assistantFilePanelMentionedList.innerHTML = "";
      if (assistantFilePanelEmpty && assistantFilePanel && !assistantFilePanel.classList.contains("has-diff")) {
        assistantFilePanelEmpty.style.display = "";
      }
      return;
    }
    assistantFilePanelMentioned.classList.remove("hidden");
    if (assistantFilePanelEmpty) assistantFilePanelEmpty.style.display = "none";
    const pathHtml = (p) => escapeHtml(p || "");
    assistantFilePanelMentionedList.innerHTML = list
      .map(
        (f) =>
          `<li class="mentioned-item">
            <div class="mentioned-main">
              <span class="mentioned-name" title="${pathHtml(f.path)}">${pathHtml(f.name || f.path)}</span>
              <span class="mentioned-actions">
                <button type="button" class="pill-button pill-outline mentioned-preview" data-path="${pathHtml(f.path)}">预览</button>
                <button type="button" class="pill-button pill-outline mentioned-app-preview" data-path="${pathHtml(f.path)}" title="在页面内运行预览">网页预览</button>
                <button type="button" class="pill-button pill-outline mentioned-open-xcode" data-path="${pathHtml(f.path)}" title="用 Xcode 打开该工程">Xcode</button>
                <button type="button" class="pill-button pill-outline mentioned-open" data-path="${pathHtml(f.path)}">打开</button>
              </span>
            </div>
            <code class="mentioned-path" title="完整路径，点击复制" data-path="${pathHtml(f.path)}">${pathHtml(f.path)}</code>
          </li>`
      )
      .join("");
    assistantFilePanelMentionedList.querySelectorAll(".mentioned-open").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const path = btn.dataset.path;
        if (!path) return;
        try {
          const res = await fetch("/api/assistant/open-file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
          });
          const data = await res.json();
          if (data.ok) showToast("已用默认应用打开文件", "success");
          else showToast(data.error || "打开失败", "error");
        } catch (e) {
          showToast("请求失败", "error");
        }
      });
    });
    assistantFilePanelMentionedList.querySelectorAll(".mentioned-preview").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const path = btn.dataset.path;
        if (!path) return;
        try {
          const res = await fetch("/api/assistant/read-file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
          });
          const data = await res.json();
          if (data.ok && data.content != null) {
            showFilePreview(path, data.content);
          } else {
            showToast(data.error || "预览失败", "error");
          }
        } catch (e) {
          showToast("请求失败", "error");
        }
      });
    });
    assistantFilePanelMentionedList.querySelectorAll(".mentioned-app-preview").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const path = btn.dataset.path;
        if (!path) return;
        try {
          const res = await fetch("/api/assistant/register-preview-root", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
          });
          const data = await res.json();
          if (data.ok && data.preview_id) {
            openAppPreviewModal("/api/assistant/serve-app/" + data.preview_id + "/");
          } else {
            showToast(data.error || "网页预览失败", "error");
          }
        } catch (e) {
          showToast("请求失败", "error");
        }
      });
    });
    assistantFilePanelMentionedList.querySelectorAll(".mentioned-open-xcode").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const path = btn.dataset.path;
        if (!path) return;
        try {
          const res = await fetch("/api/assistant/open-in-xcode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
          });
          const data = await res.json();
          if (data.ok) showToast("已用 Xcode 打开", "success");
          else showToast(data.error || "打开失败", "error");
        } catch (e) {
          showToast("请求失败", "error");
        }
      });
    });
    assistantFilePanelMentionedList.querySelectorAll(".mentioned-path").forEach((el) => {
      el.addEventListener("click", () => {
        const path = el.dataset.path;
        if (!path) return;
        navigator.clipboard.writeText(path).then(() => showToast("已复制路径", "success")).catch(() => showToast("复制失败", "error"));
      });
    });
  }

  function showFilePreview(path, content) {
    if (!assistantFilePanel || !assistantFileDiff || !assistantFilePanelPath) return;
    assistantFilePanelCurrentPath = path;
    assistantFilePanelPath.textContent = path;
    const basename = path.split(/[/\\]/).filter(Boolean).pop() || path;
    if (assistantFilePanelFilename) {
      assistantFilePanelFilename.textContent = basename;
      assistantFilePanelFilename.title = path;
    }
    if (assistantFilePanelToolbar) assistantFilePanelToolbar.classList.remove("hidden");
    if (assistantFilePanelActions) assistantFilePanelActions.classList.remove("hidden");
    if (assistantFilePanelWriteStatus) assistantFilePanelWriteStatus.classList.add("hidden");
    const lines = (content || "").split(/\r?\n/);
    const numbered = lines.map((line, i) => {
      const escaped = escapeHtml(line || " ");
      return `<span class="diff-line">${String(i + 1).padStart(3)}  ${escaped}</span>`;
    }).join("\n");
    assistantFileDiff.innerHTML = numbered;
    assistantFilePanel.classList.add("has-diff");
    if (assistantFilePanelEmpty) assistantFilePanelEmpty.style.display = "none";
  }

  function clearFilePanel() {
    assistantFilePanelCurrentPath = null;
    if (assistantFilePanel) assistantFilePanel.classList.remove("has-diff");
    if (assistantFilePanelPath) assistantFilePanelPath.textContent = "";
    if (assistantFileDiff) assistantFileDiff.innerHTML = "";
    if (assistantFilePanelEmpty) assistantFilePanelEmpty.style.display = "";
    if (assistantFilePanelToolbar) assistantFilePanelToolbar.classList.add("hidden");
    if (assistantFilePanelActions) assistantFilePanelActions.classList.add("hidden");
    if (assistantFilePanelFilename) assistantFilePanelFilename.textContent = "";
    if (assistantFilePanelWriteStatus) {
      assistantFilePanelWriteStatus.classList.add("hidden");
      assistantFilePanelWriteStatus.textContent = "";
    }
    renderMentionedFiles([]);
  }

  function openAppPreviewModal(iframeSrc) {
    const modal = document.getElementById("app-preview-modal");
    const iframe = document.getElementById("app-preview-iframe");
    if (!modal || !iframe) return;
    iframe.src = iframeSrc;
    modal.classList.remove("hidden");
  }
  function closeAppPreviewModal() {
    const modal = document.getElementById("app-preview-modal");
    const iframe = document.getElementById("app-preview-iframe");
    if (modal) modal.classList.add("hidden");
    if (iframe) iframe.src = "about:blank";
  }
  const appPreviewModalClose = document.getElementById("app-preview-modal-close");
  const appPreviewModal = document.getElementById("app-preview-modal");
  const appPreviewBackdrop = appPreviewModal && appPreviewModal.querySelector(".app-preview-modal-backdrop");
  if (appPreviewModalClose) appPreviewModalClose.addEventListener("click", closeAppPreviewModal);
  if (appPreviewBackdrop) appPreviewBackdrop.addEventListener("click", closeAppPreviewModal);

  if (assistantFilePanelClose) {
    assistantFilePanelClose.addEventListener("click", () => {
      clearFilePanel();
    });
  }
  if (assistantFilePanelToolbarClose) {
    assistantFilePanelToolbarClose.addEventListener("click", () => {
      clearFilePanel();
    });
  }
  if (assistantFileOpenBtn) {
    assistantFileOpenBtn.addEventListener("click", async () => {
      if (!assistantFilePanelCurrentPath) return;
      try {
        const res = await fetch("/api/assistant/open-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: assistantFilePanelCurrentPath }),
        });
        const data = await res.json();
        if (data.ok) showToast("已用默认应用打开文件", "success");
        else showToast(data.error || "打开失败", "error");
      } catch (e) {
        showToast("请求失败：" + (e.message || "网络错误"), "error");
      }
    });
  }
  if (assistantFileCreateBtn) {
    assistantFileCreateBtn.addEventListener("click", async () => {
      if (!assistantFilePanelCurrentPath) return;
      try {
        const res = await fetch("/api/assistant/open-folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: assistantFilePanelCurrentPath }),
        });
        const data = await res.json();
        if (data.ok) showToast("已打开所在文件夹", "success");
        else showToast(data.error || "打开失败", "error");
      } catch (e) {
        showToast("请求失败：" + (e.message || "网络错误"), "error");
      }
    });
  }

  const ASSISTANT_PANEL_WIDTH_KEY = "lumi_assistant_file_panel_width";
  const assistantResizeHandle = document.getElementById("assistant-resize-handle");
  const assistantViewLayout = document.querySelector(".assistant-view-layout");
  if (assistantResizeHandle && assistantFilePanel && assistantViewLayout) {
    const minW = 280;
    const maxWPercent = 0.7;
    const saved = sessionStorage.getItem(ASSISTANT_PANEL_WIDTH_KEY);
    if (saved) {
      const px = parseInt(saved, 10);
      if (px >= minW) assistantViewLayout.style.setProperty("--assistant-file-panel-width", px + "px");
    }
    assistantResizeHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const rect = assistantViewLayout.getBoundingClientRect();
      const startWidth = rect.right - startX;
      const maxW = rect.width * maxWPercent;
      function move(ev) {
        const w = Math.min(maxW, Math.max(minW, rect.right - ev.clientX));
        assistantViewLayout.style.setProperty("--assistant-file-panel-width", w + "px");
      }
      function up() {
        const w = parseFloat(getComputedStyle(assistantViewLayout).getPropertyValue("--assistant-file-panel-width") || "0", 10);
        if (w >= minW) sessionStorage.setItem(ASSISTANT_PANEL_WIDTH_KEY, String(Math.round(w)));
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    });
  }

  function appendAssistantMessage(role, text) {
    if (!assistantChat) return;
    const placeholder = assistantChat.querySelector(".assistant-placeholder");
    if (placeholder) placeholder.remove();
    assistantChat.classList.add("has-messages");
    const div = document.createElement("div");
    div.className = `assistant-message ${role}`;
    div.textContent = text;
    assistantChat.appendChild(div);
    assistantChat.scrollTop = assistantChat.scrollHeight;
  }
  /** 创建一条可流式追加内容的助手消息，返回用于 appendStreamingChunk 的 div */
  function createStreamingAssistantMessage() {
    if (!assistantChat) return null;
    const placeholder = assistantChat.querySelector(".assistant-placeholder");
    if (placeholder) placeholder.remove();
    assistantChat.classList.add("has-messages");
    const div = document.createElement("div");
    div.className = "assistant-message assistant";
    assistantChat.appendChild(div);
    return div;
  }
  function appendStreamingChunk(streamingDiv, chunk) {
    if (!streamingDiv) return;
    streamingDiv.textContent = (streamingDiv.textContent || "") + chunk;
    if (assistantChat) assistantChat.scrollTop = assistantChat.scrollHeight;
  }
  function _removeLastAssistantMessage() {
    if (!assistantChat) return;
    const last = assistantChat.lastElementChild;
    if (last && last.classList.contains("assistant-message") && last.classList.contains("assistant")) {
      last.remove();
    }
  }
  /** 收集最近 N 轮对话作为上下文（不含当前输入），供模型多轮记忆 */
  function getAssistantHistory(maxMessages = 20) {
    if (!assistantChat) return [];
    const nodes = Array.from(assistantChat.querySelectorAll(".assistant-message"));
    if (nodes.length <= 1) return [];
    const prev = nodes.slice(0, -1).slice(-maxMessages);
    return prev.map((el) => ({
      role: el.classList.contains("user") ? "user" : "assistant",
      content: (el.textContent || "").trim(),
    })).filter((m) => m.content.length > 0);
  }

  function getAssistantTodos() {
    try {
      const raw = sessionStorage.getItem(ASSISTANT_TODO_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }
  function setAssistantTodos(items) {
    sessionStorage.setItem(ASSISTANT_TODO_KEY, JSON.stringify(items));
    renderAssistantTodos();
  }
  function renderAssistantTodos() {
    const list = document.getElementById("assistant-todo-list");
    if (!list) return;
    const items = getAssistantTodos();
    list.innerHTML = items
      .map(
        (item, i) =>
          `<div class="assistant-todo-item ${item.done ? "done" : ""}" data-i="${i}">
            <input type="checkbox" ${item.done ? "checked" : ""} />
            <span>${escapeHtml(item.text)}</span>
          </div>`
      )
      .join("");
    list.querySelectorAll(".assistant-todo-item input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const idx = parseInt(cb.closest(".assistant-todo-item").dataset.i, 10);
        const todos = getAssistantTodos();
        if (todos[idx]) {
          todos[idx].done = cb.checked;
          setAssistantTodos(todos);
        }
      });
    });
  }
  const todoAddInput = document.getElementById("assistant-todo-add");
  if (todoAddInput) {
    todoAddInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const text = todoAddInput.value.trim();
        if (text) {
          setAssistantTodos(getAssistantTodos().concat([{ text, done: false }]));
          todoAddInput.value = "";
        }
      }
    });
  }
  renderAssistantTodos();

  const quickTaskTemplates = {
    "下载视频到桌面": "请写一个 Python 脚本：从指定网页下载视频并保存到桌面，使用 requests/yt-dlp 等，并说明如何运行。",
    抠图: "请给出一段可用脚本或命令，对一张图片进行抠图（去除背景），保存到桌面。",
    "压缩/解压文件": "请给出在终端中压缩指定文件夹为 zip、以及解压 zip 到指定目录的命令或简短脚本。",
    写文案: "请根据我接下来给出的主题或要求，写一段文案（可指定字数、风格）。",
    写脚本: "请根据我接下来的需求，写一个可直接运行的脚本（Python/Shell 等）。",
    做PPT: "请用 ---FILE: 文件名.pptx --- 格式直接生成一份 PPT：每页空行分隔，首行为标题，其余行为 - 或 * 要点。需要配图时在单独一行写 [IMG: 图片URL]，我会自动插入到对应页。请适当加入 1～2 张配图让 PPT 更丰富。",
  };
  document.querySelectorAll(".assistant-quick").forEach((btn) => {
    btn.addEventListener("click", () => {
      const task = btn.dataset.task;
      const template = quickTaskTemplates[task] || task;
      if (assistantInput) assistantInput.value = template;
      assistantInput?.focus();
    });
  });

  if (assistantSendBtn && assistantInput) {
    assistantSendBtn.addEventListener("click", sendAssistantMessage);
    assistantInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendAssistantMessage();
      }
    });
  }
  if (assistantRunCmdBtn) {
    assistantRunCmdBtn.addEventListener("click", async () => {
      const cmd = (lastAssistantTerminalReply || "").split("\n").map((l) => l.trim()).find((l) => l.length > 0);
      if (!cmd) {
        showToast("暂无可执行的终端命令", "error");
        return;
      }
      assistantRunCmdBtn.disabled = true;
      try {
        const res = await fetch("/api/assistant/terminal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: cmd, timeout: 60 }),
        });
        const data = await res.json();
        const output = data.output || (data.ok ? "(无输出)" : "执行失败");
        appendAssistantMessage("assistant", "[执行结果]\n" + output);
        if (data.ok) showToast("命令已执行", "success");
        else showToast("命令执行失败", "error");
      } catch (e) {
        appendAssistantMessage("assistant", "[执行失败] " + (e.message || "网络错误"));
        showToast("请求失败", "error");
      } finally {
        assistantRunCmdBtn.disabled = false;
      }
    });
  }

  async function sendAssistantMessage() {
    const instruction = assistantInput?.value?.trim();
    if (!instruction) {
      showToast("请输入任务描述", "error");
      return;
    }
    const deepThink = document.getElementById("assistant-deep-think")?.checked;
    const mode = deepThink ? "deep_think" : "auto";
    appendAssistantMessage("user", instruction);
    assistantInput.value = "";
    if (assistantSendBtn) {
      assistantSendBtn.disabled = true;
      assistantSendBtn.classList.add("loading");
    }
    if (assistantStopBtn) {
      assistantStopBtn.classList.remove("hidden");
      assistantStopBtn.disabled = false;
    }
    _removeLastAssistantMessage();
    if (assistantThinking) {
      assistantThinking.textContent = "Lumi 正在处理… 润色/修改文件或长内容时可能需要 1–2 分钟，请耐心等待。";
    }
    const controller = new AbortController();
    assistantController = controller;
    const useStream = true;
    const history = getAssistantHistory();
    try {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, instruction, stream: useStream, context: history.length ? { history } : {} }),
        signal: controller.signal,
      });
      if (!res.ok) {
        if (assistantProgressWrap) assistantProgressWrap.classList.add("hidden");
        const errData = await res.json().catch(() => ({}));
        appendAssistantMessage("assistant", "错误：" + (errData.error || res.statusText));
        showToast(errData.error || "请求失败", "error");
        if (assistantThinking) assistantThinking.textContent = "";
        return;
      }
      const contentType = (res.headers.get("Content-Type") || "").toLowerCase();
      const isStream = contentType.indexOf("text/event-stream") !== -1;

      if (isStream && res.body) {
        const streamingDiv = createStreamingAssistantMessage();
        if (assistantProgressWrap) {
          assistantProgressWrap.classList.remove("hidden");
          assistantProgressWrap.setAttribute("aria-hidden", "false");
        }
        let buffer = "";
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const payload = JSON.parse(line.slice(6));
                if (payload.type === "chunk" && payload.content) {
                  if (assistantThinking) assistantThinking.textContent = "";
                  appendStreamingChunk(streamingDiv, payload.content);
                } else if (payload.type === "status" && payload.message) {
                  if (assistantThinking) assistantThinking.textContent = payload.message;
                } else if (payload.type === "done") {
                  if (assistantProgressWrap) {
                    assistantProgressWrap.classList.add("hidden");
                    assistantProgressWrap.setAttribute("aria-hidden", "true");
                  }
                  const inferredMode = payload.mode || mode;
                  if (payload.reply && streamingDiv) streamingDiv.textContent = payload.reply;
                  if (payload.file_edit) renderFileDiff(payload.file_edit);
                  (function () {
                    const list = payload.mentioned_files || [];
                    if (payload.created_path && !list.some((f) => (f.path || "") === payload.created_path)) {
                      const name = payload.created_path.split(/[/\\]/).filter(Boolean).pop() || payload.created_path;
                      renderMentionedFiles([...list, { path: payload.created_path, name }]);
                    } else if (list.length) {
                      renderMentionedFiles(list);
                    }
                  })();
                  if (inferredMode === "terminal" && payload.reply) {
                    lastAssistantTerminalReply = payload.reply;
                    if (assistantRunCmdBtn) assistantRunCmdBtn.classList.remove("hidden");
                  } else if (assistantRunCmdBtn) assistantRunCmdBtn.classList.add("hidden");
                  if (inferredMode === "plan" && payload.reply && assistantPlanDisplay) {
                    assistantPlanDisplay.textContent = payload.reply;
                  }
                  if (inferredMode === "todo" && payload.reply) {
                    const todoLines = payload.reply.split("\n").filter((l) => /^[-*]\s*\[[ x]\]\s*.+/.test(l.trim()));
                    if (todoLines.length) {
                      setAssistantTodos(
                        todoLines.map((l) => ({
                          text: l.replace(/^[-*]\s*\[[ x]\]\s*/, "").trim(),
                          done: /\[x\]/i.test(l),
                        }))
                      );
                    }
                  }
                  if (payload.created_path && (payload.auto_open_path || payload.created_path)) {
                    const pathToOpen = payload.auto_open_path || payload.created_path;
                    fetch("/api/assistant/open-file", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ path: pathToOpen }),
                    }).then((r) => r.json()).then((data) => {
                      if (data.ok) showToast("已自动打开", "success");
                    }).catch(() => {});
                  }
                }
              } catch (parseErr) {
                /* ignore malformed chunk */
              }
            }
          }
        }
        if (assistantProgressWrap) {
          assistantProgressWrap.classList.add("hidden");
          assistantProgressWrap.setAttribute("aria-hidden", "true");
        }
        if (assistantThinking) assistantThinking.textContent = "";
      } else {
        const data = await res.json();
        if (!data.ok) {
          if (assistantProgressWrap) assistantProgressWrap.classList.add("hidden");
          appendAssistantMessage("assistant", "错误：" + (data.error || "未知错误"));
          showToast(data.error || "请求失败", "error");
          if (assistantThinking) assistantThinking.textContent = "";
          return;
        }
        const reply = data.reply || "";
        const inferredMode = data.mode || mode;
        appendAssistantMessage("assistant", reply);
        if (data.file_edit) renderFileDiff(data.file_edit);
        (function () {
          const list = data.mentioned_files || [];
          if (data.created_path && !list.some((f) => (f.path || "") === data.created_path)) {
            const name = data.created_path.split(/[/\\]/).filter(Boolean).pop() || data.created_path;
            renderMentionedFiles([...list, { path: data.created_path, name }]);
          } else if (list.length) {
            renderMentionedFiles(list);
          }
        })();
        if (inferredMode === "terminal" && reply) {
          lastAssistantTerminalReply = reply;
          if (assistantRunCmdBtn) assistantRunCmdBtn.classList.remove("hidden");
        } else if (assistantRunCmdBtn) assistantRunCmdBtn.classList.add("hidden");
        if (inferredMode === "plan" && reply && assistantPlanDisplay) {
          assistantPlanDisplay.textContent = reply;
        }
        if (inferredMode === "todo" && reply) {
          const lines = reply.split("\n").filter((l) => /^[-*]\s*\[[ x]\]\s*.+/.test(l.trim()));
          if (lines.length) {
            setAssistantTodos(
              lines.map((l) => ({
                text: l.replace(/^[-*]\s*\[[ x]\]\s*/, "").trim(),
                done: /\[x\]/i.test(l),
              }))
            );
          }
        }
        if (data.created_path && (data.auto_open_path || data.created_path)) {
          const pathToOpen = data.auto_open_path || data.created_path;
          fetch("/api/assistant/open-file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: pathToOpen }),
          }).then((r) => r.json()).then((openData) => {
            if (openData.ok) showToast("已自动打开", "success");
          }).catch(() => {});
        }
        if (assistantThinking) assistantThinking.textContent = "";
      }
    } catch (e) {
      if (assistantProgressWrap) assistantProgressWrap.classList.add("hidden");
      if (e.name === "AbortError") {
        appendAssistantMessage("assistant", "已停止输出。");
        showToast("已停止", "success");
      } else {
        appendAssistantMessage("assistant", "请求失败：" + (e.message || "网络错误"));
        showToast("请求失败", "error");
      }
      if (assistantThinking) assistantThinking.textContent = "";
    } finally {
      if (assistantProgressWrap) {
        assistantProgressWrap.classList.add("hidden");
        assistantProgressWrap.setAttribute("aria-hidden", "true");
      }
      assistantController = null;
      if (assistantSendBtn) {
        assistantSendBtn.disabled = false;
        assistantSendBtn.classList.remove("loading");
      }
      if (assistantStopBtn) {
        assistantStopBtn.classList.add("hidden");
        assistantStopBtn.disabled = true;
      }
      assistantInput?.focus();
    }
  }

  if (assistantStopBtn) {
    assistantStopBtn.addEventListener("click", () => {
      if (assistantController) assistantController.abort();
    });
  }

  document.querySelectorAll(".ai-edit-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      document.querySelectorAll(".ai-edit-mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const paneFile = document.getElementById("ai-edit-pane-file");
      const paneCode = document.getElementById("ai-edit-pane-code");
      if (paneFile) paneFile.classList.toggle("hidden", mode !== "file-edit");
      if (paneCode) paneCode.classList.toggle("hidden", mode !== "code-action");
    });
  });

  const devCheckEnvBtn = document.getElementById("dev-check-env");
  if (devCheckEnvBtn) {
    devCheckEnvBtn.addEventListener("click", () => runDevCheckEnv());
  }

  const devCheckVersionBtn = document.getElementById("dev-check-version");
  const devVersionResult = document.getElementById("dev-version-result");
  if (devCheckVersionBtn && devVersionResult) {
    devCheckVersionBtn.addEventListener("click", async () => {
      devVersionResult.textContent = "检查中…";
      try {
        const res = await fetch("/api/version");
        const data = await res.json();
        devVersionResult.textContent =
          (data.app || "Lumi") +
          (data.agent_version ? "\nLumi Agent 版本: " + data.agent_version : "") +
          "\nPython: " +
          (data.python_full || data.python || "—");
      } catch (e) {
        devVersionResult.textContent = "请求失败：" + e;
      }
    });
  }

  const DEV_STORAGE_KEY = "lumi_developer";

  function updateHeroByAuth() {
    const el = document.getElementById("hero-title-text");
    if (!el) return;
    el.textContent =
      sessionStorage.getItem(DEV_STORAGE_KEY) === "1"
        ? "欢迎回来，主人/开发者！"
        : "今天有什么可以帮到你？";
  }

  function updateDevAuthUI() {
    const isAuth = sessionStorage.getItem(DEV_STORAGE_KEY) === "1";
    const form = document.getElementById("dev-auth-form");
    const success = document.getElementById("dev-auth-success");
    const hint = document.getElementById("dev-auth-hint");
    if (form) form.classList.toggle("hidden", isAuth);
    if (success) success.classList.toggle("hidden", !isAuth);
    if (hint) hint.textContent = "";
  }

  updateHeroByAuth();
  updateDevAuthUI();

  const devSecretInput = document.getElementById("dev-secret-input");
  const devAuthBtn = document.getElementById("dev-auth-btn");
  const devAuthHint = document.getElementById("dev-auth-hint");
  if (devAuthBtn && devSecretInput) {
    devAuthBtn.addEventListener("click", async () => {
      const key = devSecretInput.value.trim();
      if (!key) {
        if (devAuthHint) devAuthHint.textContent = "请输入开发者密钥";
        return;
      }
      devAuthBtn.disabled = true;
      if (devAuthHint) devAuthHint.textContent = "";
      try {
        const res = await fetch("/api/developer/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key }),
        });
        const data = await res.json();
        if (data.ok) {
          sessionStorage.setItem(DEV_STORAGE_KEY, "1");
          updateHeroByAuth();
          updateDevAuthUI();
          devSecretInput.value = "";
          showToast("开发者认证成功", "success");
        } else {
          if (devAuthHint) devAuthHint.textContent = "密钥错误，认证失败";
          showToast("认证失败", "error");
        }
      } catch (e) {
        if (devAuthHint) devAuthHint.textContent = "请求失败：" + e;
        showToast("认证请求失败", "error");
      }
      devAuthBtn.disabled = false;
    });
  }

  const createAgentSubmit = document.getElementById("create-agent-submit");
  const createAgentInstruction = document.getElementById("create-agent-instruction");
  const createAgentName = document.getElementById("create-agent-name");
  const createAgentVersion = document.getElementById("create-agent-version");
  const createAgentApi = document.getElementById("create-agent-api");
  const createAgentSourcePath = document.getElementById("create-agent-source-path");
  const createAgentCapabilities = document.getElementById("create-agent-capabilities");
  const createAgentResult = document.getElementById("create-agent-result");
  const createAgentResultContent = document.getElementById("create-agent-result-content");
  const createAgentDevEmpty = document.getElementById("create-agent-dev-empty");
  const createAgentDevList = document.getElementById("create-agent-dev-list");
  const createAgentDevName = document.getElementById("create-agent-dev-name");
  const createAgentDevVersion = document.getElementById("create-agent-dev-version");
  const createAgentDevApi = document.getElementById("create-agent-dev-api");
  const createAgentDevSourcePath = document.getElementById("create-agent-dev-source-path");
  const createAgentDevCapabilities = document.getElementById("create-agent-dev-capabilities");

  if (createAgentSubmit && createAgentInstruction) {
    createAgentSubmit.addEventListener("click", async () => {
      const instruction = (createAgentInstruction.value || "").trim();
      if (!instruction) {
        showToast("请用自然语言描述你要创造的 Agent", "error");
        return;
      }
      const name = (createAgentName && createAgentName.value ? createAgentName.value.trim() : "") || "未命名 Agent";
      const version = (createAgentVersion && createAgentVersion.value ? createAgentVersion.value.trim() : "") || "1.0.0";
      const api = (createAgentApi && createAgentApi.value ? createAgentApi.value.trim() : "") || "—";
      const sourcePath = (createAgentSourcePath && createAgentSourcePath.value ? createAgentSourcePath.value.trim() : "") || "";
      const capabilities = (createAgentCapabilities && createAgentCapabilities.value ? createAgentCapabilities.value.trim() : "") || "—";
      const folderName = sourcePath ? sourcePath.replace(/^.*[/\\]/, "") || name : name;
      const fullInstruction =
        "【创造 Agent】请在桌面创建名为「" + folderName + "」的 agent 项目文件夹，并根据以下信息与用户描述生成完整项目。所有文件夹与文件由你决策，请仅使用 ---FILE: 相对路径--- 输出多文件，必要时使用 ---RUN: 命令 ---。\n\n" +
        "名称：" + name + "\n版本号：" + version + "\nAPI 接口：" + api + "\n代理功能：" + capabilities + "\n\n用户描述：" + instruction;
      const btnText = createAgentSubmit.textContent;
      createAgentSubmit.disabled = true;
      createAgentSubmit.textContent = "创建中…";
      createAgentResultContent.textContent = "正在创建…";
      if (createAgentResult) createAgentResult.classList.remove("hidden");
      try {
        const res = await fetch("/api/assistant/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "create_file", instruction: fullInstruction, stream: false, context: {} }),
        });
        const data = await res.json();
        createAgentResultContent.textContent = data.reply || (data.error || "请求失败");
        if (data.ok && createAgentDevList && createAgentDevEmpty) {
          createAgentDevEmpty.classList.add("hidden");
          createAgentDevList.classList.remove("hidden");
          if (createAgentDevName) createAgentDevName.textContent = name;
          if (createAgentDevVersion) createAgentDevVersion.textContent = version;
          if (createAgentDevApi) createAgentDevApi.textContent = api;
          if (createAgentDevSourcePath) createAgentDevSourcePath.textContent = data.created_path || sourcePath || "—";
          if (createAgentDevCapabilities) createAgentDevCapabilities.textContent = capabilities;
        }
        if (!data.ok) showToast(data.error || "创建失败", "error");
        else showToast("创建请求已处理", "success");
      } catch (e) {
        createAgentResultContent.textContent = "请求失败：" + (e.message || e);
        showToast("请求失败", "error");
      }
      createAgentSubmit.disabled = false;
      createAgentSubmit.textContent = btnText;
    });
  }

  if (runBtn) {
    runBtn.addEventListener("click", runAgent);
  }
  if (editFileBtn) {
    editFileBtn.addEventListener("click", editDesktopFile);
  }
  if (githubBtn) {
    githubBtn.addEventListener("click", githubFlash);
  }
  if (chatSendBtn) {
    chatSendBtn.addEventListener("click", sendChat);
  }
  const chatClearBtn = document.getElementById("chat-clear-btn");
  if (chatClearBtn) {
    chatClearBtn.addEventListener("click", clearChat);
  }
  if (chatInput) {
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    });
    chatInput.addEventListener("input", () => {
      chatInput.style.height = "auto";
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
    });
  }

  if (searchBtn) {
    searchBtn.addEventListener("click", () => {
      searchBtn.classList.toggle("active");
    });
  }

  if (flashConfirmBtn) {
    flashConfirmBtn.addEventListener("click", flashLastInstruction);
  }
  const flashDismissBtn = document.getElementById("flash-dismiss");
  if (flashDismissBtn) {
    flashDismissBtn.addEventListener("click", () => {
      const bar = document.getElementById("flash-bar");
      if (bar) bar.classList.add("hidden");
      showToast("已关闭烧录提示，可随时在工具箱中「烧录上次代码」");
    });
  }

  const processCopyBtn = document.getElementById("process-copy");
  const processClearBtn = document.getElementById("process-clear");
  const processLogEl = document.getElementById("process-log");
  const deviceRefreshBtn = document.getElementById("device-refresh");

  if (processCopyBtn && processLogEl) {
    processCopyBtn.addEventListener("click", async () => {
      const text = processLogEl.textContent || "";
      try {
        await navigator.clipboard.writeText(text);
        showToast("已复制到剪贴板", "success");
        const orig = processCopyBtn.textContent;
        processCopyBtn.textContent = "已复制";
        processCopyBtn.disabled = true;
        setTimeout(() => {
          processCopyBtn.textContent = orig;
          processCopyBtn.disabled = false;
        }, 1200);
      } catch (err) {
        showToast("复制失败，请手动选择后复制", "error");
        appendProcessLog("[提示] 复制失败，请手动选择进程日志复制。");
      }
    });
  }

  const processLogScrollBtn = document.getElementById("process-log-scroll-btn");
  if (processLogEl && processLogScrollBtn) {
    processLogEl.addEventListener("scroll", () => {
      const atBottom = processLogEl.scrollHeight - processLogEl.scrollTop - processLogEl.clientHeight < 24;
      processLogScrollBtn.classList.toggle("hidden", atBottom);
    });
    processLogScrollBtn.addEventListener("click", () => {
      processLogEl.scrollTop = processLogEl.scrollHeight;
      processLogScrollBtn.classList.add("hidden");
    });
  }

  const PROCESS_LOG_DEFAULT = "Lumi 等待你的第一个指令，用于生成或烧录代码...";
  if (processClearBtn && processLogEl) {
    processClearBtn.addEventListener("click", () => {
      processLogEl.textContent = PROCESS_LOG_DEFAULT;
      processLogEl.scrollTop = 0;
      if (processLogScrollBtn) processLogScrollBtn.classList.add("hidden");
    });
  }

  if (deviceRefreshBtn) {
    deviceRefreshBtn.addEventListener("click", () => {
      deviceRefreshBtn.disabled = true;
      deviceRefreshBtn.textContent = "…";
      fetchDevices(true).finally(() => {
        deviceRefreshBtn.disabled = false;
        deviceRefreshBtn.textContent = "刷新";
      });
    });
  }

  const codeActionToggle = document.getElementById("code-action-toggle");
  const codeActionBody = document.getElementById("code-action-body");
  const codeActionInput = document.getElementById("code-action-input");
  const codeActionLanguage = document.getElementById("code-action-language");
  const codeActionInstruction = document.getElementById("code-action-instruction");
  const codeActionFillLast = document.getElementById("code-action-fill-last");
  const codeActionCompleteBtn = document.getElementById("code-action-complete");
  const codeActionOptimizeBtn = document.getElementById("code-action-optimize");
  const codeActionResultWrap = document.getElementById("code-action-result-wrap");
  const codeActionResult = document.getElementById("code-action-result");
  const codeActionUseResult = document.getElementById("code-action-use-result");

  if (codeActionToggle && codeActionBody) {
    codeActionToggle.addEventListener("click", () => {
      const open = codeActionBody.classList.toggle("hidden");
      codeActionToggle.setAttribute("aria-expanded", String(!open));
      codeActionToggle.textContent = open ? "展开" : "收起";
    });
  }

  if (codeActionFillLast) {
    codeActionFillLast.addEventListener("click", () => {
      if (lastCode && codeActionInput) {
        codeActionInput.value = lastCode;
        appendProcessLog("[代码补全/优化] 已填入上一条生成的代码。");
      } else {
        appendProcessLog("[代码补全/优化] 暂无上一条代码，请先发送指令生成一次。");
      }
    });
  }

  async function runCodeAction(action) {
    const code = codeActionInput?.value?.trim();
    if (!code) {
      appendProcessLog("[代码补全/优化] 请先输入或粘贴待处理代码。");
      return;
    }
    const btn = action === "complete" ? codeActionCompleteBtn : codeActionOptimizeBtn;
    if (btn) btn.disabled = true;
    appendProcessLog(action === "complete" ? "[代码补全] 正在补全…" : "[代码优化] 正在优化…");
    try {
      const url = action === "complete" ? "/api/code-complete" : "/api/code-optimize";
      const body = action === "complete"
        ? { code, language_hint: (codeActionLanguage?.value || "").trim() }
        : { code, instruction: (codeActionInstruction?.value || "").trim() };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) {
        appendProcessLog("[代码补全/优化] 失败：" + (data.error || "未知错误"));
        return;
      }
      const resultCode = data.code || "";
      if (codeActionResult) codeActionResult.textContent = resultCode;
      if (codeActionResultWrap) codeActionResultWrap.classList.remove("hidden");
      appendProcessLog(action === "complete" ? "[代码补全] 完成。" : "[代码优化] 完成。");
      window.__lastCodeActionResult = resultCode;
    } catch (e) {
      appendProcessLog("[代码补全/优化] 请求失败：" + (e.message || e));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  if (codeActionCompleteBtn) {
    codeActionCompleteBtn.addEventListener("click", () => runCodeAction("complete"));
  }
  if (codeActionOptimizeBtn) {
    codeActionOptimizeBtn.addEventListener("click", () => runCodeAction("optimize"));
  }

  if (codeActionUseResult) {
    codeActionUseResult.addEventListener("click", () => {
      const result = window.__lastCodeActionResult;
      if (result) {
        lastCode = result;
        showToast("已设为当前代码，可烧录", "success");
        appendProcessLog("[代码补全/优化] 已设为当前代码，可点击「烧录到设备」进行烧录。");
      } else {
        appendProcessLog("[代码补全/优化] 请先执行一次补全或优化。");
      }
    });
  }

  const aiEditToggle = document.getElementById("ai-edit-toggle");
  const aiEditBody = document.getElementById("ai-edit-body");
  const aiEditProjectRoot = document.getElementById("ai-edit-project-root");
  const aiEditPath = document.getElementById("ai-edit-path");
  const aiEditInstruction = document.getElementById("ai-edit-instruction");
  const aiEditSelected = document.getElementById("ai-edit-selected");
  const aiEditContextPaths = document.getElementById("ai-edit-context-paths");
  const aiEditPreviewBtn = document.getElementById("ai-edit-preview");
  const aiEditStopBtn = document.getElementById("ai-edit-stop");
  const aiEditApplyBtn = document.getElementById("ai-edit-apply");
  const aiEditResultWrap = document.getElementById("ai-edit-result-wrap");
  const aiEditResult = document.getElementById("ai-edit-result");
  let aiEditPreviewController = null;

  fetch("/api/project-root")
    .then((r) => r.json())
    .then((d) => {
      if (aiEditProjectRoot && d.project_root) aiEditProjectRoot.textContent = d.project_root;
    })
    .catch(() => {});

  if (aiEditToggle && aiEditBody) {
    aiEditToggle.addEventListener("click", () => {
      const open = aiEditBody.classList.toggle("hidden");
      aiEditToggle.setAttribute("aria-expanded", String(!open));
      aiEditToggle.textContent = open ? "展开" : "收起";
    });
  }

  if (aiEditPreviewBtn) {
    aiEditPreviewBtn.addEventListener("click", async () => {
      const path = aiEditPath?.value?.trim();
      const instruction = aiEditInstruction?.value?.trim();
      if (!path || !instruction) {
        showToast("请填写文件路径和修改需求", "error");
        appendProcessLog("[AI 编辑] 请填写文件路径和修改需求。");
        return;
      }
      const previewBtnOriginalText = aiEditPreviewBtn.textContent || "预览";
      aiEditPreviewBtn.disabled = true;
      aiEditPreviewBtn.textContent = "预览中…";
      if (aiEditStopBtn) {
        aiEditStopBtn.classList.remove("hidden");
        aiEditStopBtn.disabled = false;
      }
      const selected = aiEditSelected?.value?.trim() || undefined;
      const pathsText = aiEditContextPaths?.value?.trim() || "";
      const context_files = pathsText
        ? pathsText.split(/\n/).map((p) => ({ path: p.trim() })).filter((p) => p.path)
        : undefined;
      const controller = new AbortController();
      aiEditPreviewController = controller;
      try {
        const res = await fetch("/api/edit-file/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            relative_path: path,
            instruction,
            selected_text: selected,
            context_files,
          }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (!data.ok) {
          appendProcessLog("[AI 编辑] 预览失败：" + (data.error || "未知错误"));
          return;
        }
        window.__aiEditNewContent = data.new_content;
        if (aiEditResult) aiEditResult.textContent = data.new_content || "";
        if (aiEditResultWrap) aiEditResultWrap.classList.remove("hidden");
        if (aiEditApplyBtn) aiEditApplyBtn.disabled = false;
        appendProcessLog("[AI 编辑] 预览完成，可点击「应用」写回文件。");
      } catch (e) {
        if (e.name === "AbortError") {
          appendProcessLog("[AI 编辑] 已停止生成。");
          showToast("已停止", "success");
        } else {
          appendProcessLog("[AI 编辑] 请求失败：" + (e.message || "网络错误"));
        }
      } finally {
        aiEditPreviewController = null;
        aiEditPreviewBtn.disabled = false;
        aiEditPreviewBtn.textContent = typeof previewBtnOriginalText !== "undefined" ? previewBtnOriginalText : "预览";
        if (aiEditStopBtn) {
          aiEditStopBtn.classList.add("hidden");
          aiEditStopBtn.disabled = true;
        }
      }
    });
  }

  if (aiEditStopBtn) {
    aiEditStopBtn.addEventListener("click", () => {
      if (aiEditPreviewController) aiEditPreviewController.abort();
    });
  }

  if (aiEditApplyBtn) {
    aiEditApplyBtn.addEventListener("click", async () => {
      const path = aiEditPath?.value?.trim();
      const new_content = window.__aiEditNewContent;
      if (!path || new_content == null) {
        showToast("请先执行「预览」再应用", "error");
        appendProcessLog("[AI 编辑] 请先执行「预览」再应用。");
        return;
      }
      aiEditApplyBtn.disabled = true;
      try {
        const res = await fetch("/api/edit-file/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ relative_path: path, new_content }),
        });
        const data = await res.json();
        if (data.ok) {
          showToast("已写回文件：" + path, "success");
          appendProcessLog("[AI 编辑] 已写回文件：" + path);
        } else {
          appendProcessLog("[AI 编辑] 应用失败：" + (data.error || "未知错误"));
        }
      } finally {
        aiEditApplyBtn.disabled = false;
      }
    });
  }

  quickActionBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tpl = btn.getAttribute("data-template") || "";
      const input = document.getElementById("chat-input");
      if (!input) return;
      if (!input.value.trim()) {
        input.value = tpl;
      } else {
        input.value = input.value.trimEnd() + "\n" + tpl;
      }
      input.focus();
    });
  });

  // 模式切换：MicroPython / C++ PlatformIO（多开发板）
  modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-mode") || "micropython";
      currentMode = mode;
      modeButtons.forEach((b) => {
        b.classList.toggle("mode-btn-active", b === btn);
      });
      if (boardSelectWrap) {
        boardSelectWrap.classList.toggle("hidden", mode !== "platformio");
      }
      const multiFileWrap = document.getElementById("multi-file-wrap");
      if (multiFileWrap) {
        multiFileWrap.classList.toggle("hidden", mode !== "micropython");
      }
      updateHardwareModelTag();
    });
  });

  loadStatus();
  updateDevModelProvider();
  updateHardwareModelProvider();

  const statusBanner = document.getElementById("status-banner");
  if (statusBanner) {
    statusBanner.addEventListener("click", () => {
      if (statusBanner.classList.contains("status-error") || statusBanner.classList.contains("status-warn")) {
        statusBanner.classList.add("status-loading");
        statusBanner.classList.remove("status-error", "status-warn");
        const st = document.getElementById("status-text");
        if (st) st.textContent = "正在重新检测…";
        loadStatus();
      }
    });
  }

  // 默认展示聊天视图
  const mainView = document.getElementById("view-chat-main");
  if (mainView) {
    mainView.classList.add("active");
  }

  // 初次加载时检测串口设备
  fetchDevices();

  if (chatStopBtn) {
    chatStopBtn.disabled = true;
    chatStopBtn.addEventListener("click", () => {
      if (currentController) {
        currentController.abort();
      }
    });
  }
});

