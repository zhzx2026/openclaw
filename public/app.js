const state = {
  appName: "OpenClaw Chat",
  files: [],
  loggedIn: false,
  messages: [],
  pendingAttachmentIds: new Set(),
  sending: false,
  uploading: false,
};

const STORAGE_KEY = "openclaw-chat-history-v1";

const elements = {
  appName: document.querySelector("#appName"),
  clearPendingButton: document.querySelector("#clearPendingButton"),
  composer: document.querySelector("#composer"),
  composerHint: document.querySelector("#composerHint"),
  emptyState: document.querySelector("#emptyState"),
  fileCount: document.querySelector("#fileCount"),
  fileInput: document.querySelector("#fileInput"),
  fileList: document.querySelector("#fileList"),
  libraryPanel: document.querySelector("#libraryPanel"),
  loginButton: document.querySelector("#loginButton"),
  loginForm: document.querySelector("#loginForm"),
  logoutButton: document.querySelector("#logoutButton"),
  messageInput: document.querySelector("#messageInput"),
  messages: document.querySelector("#messages"),
  noticeBanner: document.querySelector("#noticeBanner"),
  passwordInput: document.querySelector("#passwordInput"),
  pendingAttachments: document.querySelector("#pendingAttachments"),
  sendButton: document.querySelector("#sendButton"),
  sessionSummary: document.querySelector("#sessionSummary"),
  uploadZone: document.querySelector("#uploadZone"),
};

bootstrap().catch((error) => {
  console.error(error);
  showNotice("初始化失败，请刷新页面后重试。", "error");
});

elements.loginForm.addEventListener("submit", handleLogin);
elements.logoutButton.addEventListener("click", handleLogout);
elements.composer.addEventListener("submit", handleSendMessage);
elements.fileInput.addEventListener("change", handleFileSelection);
elements.clearPendingButton.addEventListener("click", () => {
  state.pendingAttachmentIds.clear();
  render();
});
elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

async function bootstrap() {
  restoreMessages();
  await refreshSession();
}

async function refreshSession() {
  const session = await api("/api/session");
  state.appName = session.appName || state.appName;
  state.loggedIn = Boolean(session.loggedIn);

  if (state.loggedIn) {
    await refreshFiles();
    ensureWelcomeMessage();
  } else {
    state.messages = [];
    persistMessages();
  }

  render();
}

async function refreshFiles() {
  const response = await api("/api/files");
  state.files = Array.isArray(response.files) ? response.files : [];
  prunePendingAttachments();
}

function ensureWelcomeMessage() {
  if (state.messages.length > 0) {
    return;
  }

  state.messages.push({
    id: crypto.randomUUID(),
    role: "assistant",
    text: "已连接 OpenClaw。你可以直接提问，也可以先上传图片、PDF 或文本文件再一起发给我。",
    attachments: [],
  });
  persistMessages();
}

async function handleLogin(event) {
  event.preventDefault();
  const password = elements.passwordInput.value.trim();
  if (!password) {
    showNotice("先输入访问密码。", "error");
    return;
  }

  setBusy(elements.loginButton, true, "登录中...");

  try {
    const response = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });

    state.loggedIn = Boolean(response.loggedIn);
    state.appName = response.appName || state.appName;
    elements.passwordInput.value = "";
    await refreshFiles();
    ensureWelcomeMessage();
    render();
    showNotice("登录成功，现在可以和 OpenClaw 对话了。", "success");
  } catch (error) {
    showNotice(error.message || "登录失败。", "error");
  } finally {
    setBusy(elements.loginButton, false, "登录到 OpenClaw");
  }
}

async function handleLogout() {
  setBusy(elements.logoutButton, true, "退出中...");

  try {
    await api("/api/logout", { method: "POST" });
  } catch (error) {
    console.error(error);
  } finally {
    state.loggedIn = false;
    state.files = [];
    state.pendingAttachmentIds.clear();
    state.messages = [];
    persistMessages();
    render();
    setBusy(elements.logoutButton, false, "退出登录");
    showNotice("已退出登录。", "info");
  }
}

async function handleFileSelection(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";

  if (!files.length) {
    return;
  }

  if (!state.loggedIn) {
    showNotice("请先登录，再上传文件。", "error");
    return;
  }

  state.uploading = true;
  render();

  try {
    for (const file of files) {
      const formData = new FormData();
      formData.append("file", file);

      const response = await api("/api/files/upload", {
        method: "POST",
        body: formData,
      });

      if (response.file) {
        state.files.unshift(response.file);
        state.pendingAttachmentIds.add(response.file.id);
      }
    }

    state.files = dedupeFiles(state.files);
    render();
    showNotice("文件已上传，可以直接附带到下一条消息。", "success");
  } catch (error) {
    showNotice(error.message || "文件上传失败。", "error");
  } finally {
    state.uploading = false;
    render();
  }
}

async function handleSendMessage(event) {
  event.preventDefault();

  if (!state.loggedIn || state.sending) {
    return;
  }

  const text = elements.messageInput.value.trim();
  const attachments = getPendingAttachments();

  if (!text && attachments.length === 0) {
    showNotice("写点内容，或者至少附带一个文件。", "error");
    return;
  }

  const userMessage = {
    id: crypto.randomUUID(),
    role: "user",
    text,
    attachments,
  };

  state.messages.push(userMessage);
  state.pendingAttachmentIds.clear();
  state.sending = true;
  elements.messageInput.value = "";
  persistMessages();
  render();
  scrollMessagesToBottom();

  const typingMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "OpenClaw 正在整理你的问题...",
    attachments: [],
    pending: true,
  };

  state.messages.push(typingMessage);
  render();
  scrollMessagesToBottom();

  try {
    const payload = {
      messages: state.messages
        .filter((message) => !message.pending)
        .slice(-12)
        .map((message) => ({
          role: message.role,
          text: message.text,
          attachments: message.attachments || [],
        })),
    };

    const response = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    state.messages = state.messages.filter((message) => !message.pending);
    state.messages.push({
      id: crypto.randomUUID(),
      role: "assistant",
      text: response.message?.text || "OpenClaw 暂时没有返回文本。",
      attachments: [],
    });
    persistMessages();
    render();

    if (Array.isArray(response.warnings) && response.warnings.length) {
      showNotice(response.warnings.join(" "), "info");
    } else {
      clearNotice();
    }
  } catch (error) {
    state.messages = state.messages.filter((message) => !message.pending);
    state.messages.push({
      id: crypto.randomUUID(),
      role: "assistant",
      text: `这次请求失败了：${error.message || "未知错误"}。`,
      attachments: [],
    });
    persistMessages();
    render();
    showNotice(error.message || "发送失败。", "error");
  } finally {
    state.sending = false;
    render();
    scrollMessagesToBottom();
  }
}

function getPendingAttachments() {
  return state.files.filter((file) => state.pendingAttachmentIds.has(file.id));
}

function prunePendingAttachments() {
  const availableIds = new Set(state.files.map((file) => file.id));
  for (const fileId of state.pendingAttachmentIds) {
    if (!availableIds.has(fileId)) {
      state.pendingAttachmentIds.delete(fileId);
    }
  }
}

function dedupeFiles(files) {
  const seen = new Set();
  return files.filter((file) => {
    if (!file?.id || seen.has(file.id)) {
      return false;
    }

    seen.add(file.id);
    return true;
  });
}

function render() {
  elements.appName.textContent = state.appName;
  elements.loginForm.classList.toggle("hidden", state.loggedIn);
  elements.sessionSummary.classList.toggle("hidden", !state.loggedIn);
  elements.libraryPanel.classList.toggle("disabled", !state.loggedIn);
  elements.composer.classList.toggle("disabled", !state.loggedIn);
  elements.fileInput.disabled = !state.loggedIn || state.uploading;
  elements.messageInput.disabled = !state.loggedIn || state.sending;
  elements.sendButton.disabled = !state.loggedIn || state.sending;
  elements.sendButton.textContent = state.sending ? "发送中..." : "发送";
  elements.uploadZone.classList.toggle("busy", state.uploading);
  elements.fileCount.textContent = `${state.files.length} 个文件`;
  elements.emptyState.classList.toggle("hidden", state.messages.length > 0);
  elements.composerHint.textContent = state.loggedIn
    ? "Enter 发送，Shift + Enter 换行。"
    : "登录后才能发送消息。";

  renderPendingAttachments();
  renderFileList();
  renderMessages();
}

function renderPendingAttachments() {
  const attachments = getPendingAttachments();
  elements.pendingAttachments.innerHTML = "";

  if (attachments.length === 0) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "还没有附带任何文件。";
    elements.pendingAttachments.appendChild(hint);
    return;
  }

  attachments.forEach((file) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "attachment-chip removable";
    chip.textContent = `${file.name}`;
    chip.addEventListener("click", () => {
      state.pendingAttachmentIds.delete(file.id);
      render();
    });
    elements.pendingAttachments.appendChild(chip);
  });
}

function renderFileList() {
  elements.fileList.innerHTML = "";

  if (!state.loggedIn) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "登录后会显示最近上传的文件。";
    elements.fileList.appendChild(hint);
    return;
  }

  if (state.files.length === 0) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "还没有上传任何文件。";
    elements.fileList.appendChild(hint);
    return;
  }

  state.files.forEach((file) => {
    const item = document.createElement("article");
    item.className = "file-card";

    const meta = document.createElement("div");
    meta.className = "stack tight";

    const title = document.createElement("strong");
    title.textContent = file.name;
    meta.appendChild(title);

    const details = document.createElement("p");
    details.className = "hint";
    details.textContent = `${formatBytes(file.size)} · ${formatType(file.type)} · ${formatDate(file.uploadedAt)}`;
    meta.appendChild(details);

    const actions = document.createElement("div");
    actions.className = "file-actions";

    const attachButton = document.createElement("button");
    attachButton.type = "button";
    attachButton.className = state.pendingAttachmentIds.has(file.id)
      ? "ghost-button"
      : "text-button";
    attachButton.textContent = state.pendingAttachmentIds.has(file.id)
      ? "已附带"
      : "附加到消息";
    attachButton.addEventListener("click", () => {
      if (state.pendingAttachmentIds.has(file.id)) {
        state.pendingAttachmentIds.delete(file.id);
      } else {
        state.pendingAttachmentIds.add(file.id);
      }
      render();
    });

    const downloadLink = document.createElement("a");
    downloadLink.className = "text-button";
    downloadLink.href = `/api/files/${encodeURIComponent(file.id)}/download`;
    downloadLink.textContent = "下载";

    actions.append(attachButton, downloadLink);
    item.append(meta, actions);
    elements.fileList.appendChild(item);
  });
}

function renderMessages() {
  const messageNodes = Array.from(elements.messages.querySelectorAll(".message-card"));
  messageNodes.forEach((node) => node.remove());

  if (!state.loggedIn) {
    return;
  }

  state.messages.forEach((message) => {
    const card = document.createElement("article");
    card.className = `message-card ${message.role} ${message.pending ? "pending" : ""}`;

    const header = document.createElement("div");
    header.className = "message-head";
    header.innerHTML = `<span>${message.role === "assistant" ? "OpenClaw" : "你"}</span><span>${message.pending ? "生成中" : ""}</span>`;

    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = message.text;

    card.append(header, body);

    if (Array.isArray(message.attachments) && message.attachments.length) {
      const attachmentRow = document.createElement("div");
      attachmentRow.className = "message-attachments";

      message.attachments.forEach((file) => {
        const link = document.createElement("a");
        link.className = "attachment-chip";
        link.href = `/api/files/${encodeURIComponent(file.id)}/download`;
        link.textContent = file.name;
        attachmentRow.appendChild(link);
      });

      card.appendChild(attachmentRow);
    }

    elements.messages.appendChild(card);
  });
}

function persistMessages() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.messages.filter((message) => !message.pending)));
}

function restoreMessages() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (Array.isArray(saved)) {
      state.messages = saved;
    }
  } catch (error) {
    console.error(error);
    state.messages = [];
  }
}

function scrollMessagesToBottom() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

async function api(path, init = {}) {
  const response = await fetch(path, {
    headers: {
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
    ...init,
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    if (response.status === 401) {
      state.loggedIn = false;
      render();
    }

    const message = formatApiError(payload, response.status);
    throw new Error(message);
  }

  return payload;
}

function formatApiError(payload, status) {
  if (typeof payload !== "string") {
    const baseMessage = payload?.error || payload?.message || "请求失败";
    return payload?.requestId ? `${baseMessage}（请求 ID: ${payload.requestId}）` : baseMessage;
  }

  const trimmed = payload.trim();
  if (!trimmed.startsWith("<!DOCTYPE html") && !trimmed.startsWith("<html")) {
    return trimmed || `请求失败（HTTP ${status}）`;
  }

  const errorCode = trimmed.match(/cf-error-code">(\d+)</)?.[1];
  const rayId = trimmed.match(/Cloudflare Ray ID:\s*<strong[^>]*>([^<]+)/i)?.[1];

  if (errorCode) {
    return rayId
      ? `服务暂时异常（Cloudflare ${errorCode}，Ray ID: ${rayId}），请稍后重试。`
      : `服务暂时异常（Cloudflare ${errorCode}），请稍后重试。`;
  }

  return `服务暂时返回了一个 HTML 错误页（HTTP ${status}），请稍后重试。`;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.textContent = label;
}

function showNotice(message, tone = "info") {
  elements.noticeBanner.textContent = message;
  elements.noticeBanner.className = `notice ${tone}`;
  elements.noticeBanner.classList.remove("hidden");
}

function clearNotice() {
  elements.noticeBanner.className = "notice hidden";
  elements.noticeBanner.textContent = "";
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatType(type = "") {
  if (!type) return "未知类型";
  if (type.startsWith("image/")) return "图片";
  if (type === "application/pdf") return "PDF";
  if (type.startsWith("text/")) return "文本";
  return type;
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
      day: "numeric",
    });
  } catch (_error) {
    return value;
  }
}
