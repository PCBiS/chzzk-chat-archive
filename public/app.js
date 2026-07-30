const state = {
  csrf: "",
  currentPath: "",
  currentLogPath: "",
  selectedFile: "",
  selectedLogFile: "",
  statusTimer: null,
  settingsLoaded: false,
  bulkDeleteMode: false,
  credentialsEditing: false,
  savedCredentials: { NID_AUT: "", NID_SES: "" }
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);
}

function broadcastState(worker) {
  if (!worker.enabled) return { label: "Disabled", className: "disabled" };
  if (worker.broadcastStatus === "OPEN") return { label: "Online", className: "online" };
  if (worker.broadcastStatus === "CLOSE") return { label: "Offline", className: "offline" };
  return { label: "Unknown", className: "unknown" };
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.csrf && options.method && options.method !== "GET") headers["x-csrf-token"] = state.csrf;
  if (options.body && !(options.body instanceof FormData)) headers["content-type"] = "application/json";
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    showLogin();
    throw new Error("로그인이 필요합니다.");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || `요청 실패 (${response.status})`);
    error.payload = payload;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

function showSetup() {
  $("#setup-view").classList.remove("hidden");
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.add("hidden");
  if (state.statusTimer) clearInterval(state.statusTimer);
}

function showLogin(username = "", message = "") {
  $("#setup-view").classList.add("hidden");
  $("#login-view").classList.remove("hidden");
  $("#app-view").classList.add("hidden");
  $("#login-form").elements.username.value = username;
  $("#login-message").textContent = message;
  $("#login-error").textContent = "";
  if (state.statusTimer) clearInterval(state.statusTimer);
}

function showApp(session) {
  state.csrf = session.csrf;
  $("#username").textContent = session.username;
  $("#setup-view").classList.add("hidden");
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  loadFiles("");
  loadStatus();
  state.statusTimer = setInterval(loadStatus, 15_000);
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.remove("hidden");
  setTimeout(() => element.classList.add("hidden"), 3000);
}

async function loadStatus() {
  try {
    const workers = await api("/api/status");
    $("#status-strip").innerHTML = workers.length
      ? workers.map((worker) => {
        const status = broadcastState(worker);
        return `
        <article class="status-card">
          <div><strong>${escapeHtml(worker.name)}</strong>
            <span class="state ${status.className}">
              ${status.label}
            </span>
          </div>
          <p>${escapeHtml(worker.file || worker.lastError || worker.channelId)}</p>
        </article>`;
      }).join("")
      : `<article class="status-card"><strong>등록된 스트리머가 없습니다.</strong><p>설정 화면에서 스트리머를 추가하세요.</p></article>`;
  } catch (error) {
    console.error(error);
  }
}

async function loadFiles(path = "") {
  state.currentPath = path;
  try {
    const files = await api(`/api/files?path=${encodeURIComponent(path)}`);
    renderBreadcrumbs(path);
    $("#empty-files").classList.toggle("hidden", files.length !== 0);
    $("#file-list").innerHTML = files.map((item) => `
      <tr>
        <td><button class="file-button" data-open="${escapeHtml(item.path)}" data-type="${item.type}">
          ${item.type === "directory" ? "▰" : "▤"}&nbsp; ${escapeHtml(item.name)}
        </button></td>
        <td>${item.type === "directory" ? "폴더" : "채팅 기록"}</td>
        <td>${item.size === null ? "—" : formatBytes(item.size)}</td>
        <td>${new Date(item.modifiedAt).toLocaleString("ko-KR")}</td>
        <td><div class="row-actions">
          ${item.type === "file" ? `<button data-analyze="${escapeHtml(item.path)}">분석</button><a href="/api/files/download?path=${encodeURIComponent(item.path)}">다운로드</a>` : ""}
          <button class="delete-archive" data-delete="${escapeHtml(item.path)}" data-delete-type="${item.type}">삭제</button>
        </div></td>
      </tr>`).join("");
  } catch (error) {
    toast(error.message);
  }
}

function renderBreadcrumbs(path) {
  const parts = path ? path.split("/") : [];
  let accumulated = "";
  const crumbs = [{ name: "채팅 저장소", path: "" }, ...parts.map((part) => {
    accumulated = accumulated ? `${accumulated}/${part}` : part;
    return { name: part, path: accumulated };
  })];
  $("#breadcrumbs").innerHTML = crumbs.map((crumb) =>
    `<button data-path="${escapeHtml(crumb.path)}">${escapeHtml(crumb.name)}</button>`
  ).join("");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function selectTab(name) {
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  $("#explorer-panel").classList.toggle("hidden", name !== "explorer");
  $("#analysis-panel").classList.toggle("hidden", name !== "analysis");
  $("#logs-panel").classList.toggle("hidden", name !== "logs");
  $("#settings-panel").classList.toggle("hidden", name !== "settings");
  if (name === "settings" && !state.settingsLoaded) loadSettings();
  if (name === "logs") loadLogs(state.currentLogPath);
}

async function loadLogs(path = "") {
  state.currentLogPath = path;
  try {
    const files = await api(`/api/logs?path=${encodeURIComponent(path)}`);
    renderLogBreadcrumbs(path);
    $("#empty-logs").classList.toggle("hidden", files.length !== 0);
    $("#log-file-list").innerHTML = files.map((item) => `
      <tr>
        <td><button class="file-button" data-log-open="${escapeHtml(item.path)}" data-type="${item.type}">
          ${item.type === "directory" ? "▰" : "▤"}&nbsp; ${escapeHtml(item.name)}
        </button></td>
        <td>${item.type === "directory" ? "로그 항목" : item.name.endsWith(".gz") ? "압축 로그" : "일별 로그"}</td>
        <td>${item.size === null ? "—" : formatBytes(item.size)}</td>
        <td>${new Date(item.modifiedAt).toLocaleString("ko-KR")}</td>
        <td><div class="row-actions">
          ${item.type === "file" ? `<button data-log-analyze="${escapeHtml(item.path)}">분석</button><a href="/api/logs/download?path=${encodeURIComponent(item.path)}">다운로드</a>` : ""}
        </div></td>
      </tr>`).join("");
  } catch (error) {
    toast(error.message);
  }
}

function renderLogBreadcrumbs(path) {
  const parts = path ? path.split("/") : [];
  let accumulated = "";
  const crumbs = [{ name: "운영 로그", path: "" }, ...parts.map((part) => {
    accumulated = accumulated ? `${accumulated}/${part}` : part;
    return { name: part, path: accumulated };
  })];
  $("#log-breadcrumbs").innerHTML = crumbs.map((crumb) =>
    `<button data-log-path="${escapeHtml(crumb.path)}">${escapeHtml(crumb.name)}</button>`
  ).join("");
}

async function analyzeOperationalLog(file = state.selectedLogFile) {
  if (!file) return;
  state.selectedLogFile = file;
  $("#selected-log-file").textContent = file;
  $("#log-analysis").classList.remove("hidden");
  const params = new URLSearchParams({
    path: file,
    level: $("#log-level-filter").value,
    q: $("#log-query-filter").value,
    limit: "200"
  });
  try {
    const result = await api(`/api/logs/analysis?${params}`);
    $("#log-metric-total").textContent = result.total.toLocaleString("ko-KR");
    $("#log-metric-filtered").textContent = result.filtered.toLocaleString("ko-KR");
    $("#log-metric-errors").textContent = (result.levels.error || 0).toLocaleString("ko-KR");
    $("#log-event-list").innerHTML = result.events.length ? result.events.map((item) => `
      <div class="user-row">
        <button data-log-event="${escapeHtml(item.event)}">${escapeHtml(item.event)}</button>
        <strong>${item.count.toLocaleString("ko-KR")}</strong>
      </div>`).join("") : `<div class="empty">이벤트 정보가 없습니다.</div>`;
    $("#log-record-list").innerHTML = result.records.length ? result.records.map((record) => `
      <article class="message">
        <div class="message-meta">
          <strong class="log-level ${escapeHtml(record.level)}">${escapeHtml(record.level)}</strong>
          <span>${new Date(record.timestamp).toLocaleString("ko-KR")}</span>
        </div>
        <p><strong>${escapeHtml(record.event)}</strong> · ${escapeHtml(record.message)}</p>
        ${record.details ? `<div class="log-details">${escapeHtml(JSON.stringify(record.details, null, 2))}</div>` : ""}
      </article>`).join("") : `<div class="empty">조건에 맞는 로그가 없습니다.</div>`;
    if (result.invalidLines) toast(`읽을 수 없는 로그 ${result.invalidLines}개를 제외했습니다.`);
  } catch (error) {
    toast(error.message);
  }
}

function streamerRow(streamer = { name: "", channelId: "", enabled: true }) {
  const channelId = streamer.channelId === "replace-with-chzzk-channel-id" ? "" : streamer.channelId;
  const row = document.createElement("div");
  row.className = "streamer-row";
  row.dataset.persisted = channelId ? "true" : "false";
  row.innerHTML = `
    <input class="streamer-select ${state.bulkDeleteMode ? "" : "hidden"}" type="checkbox" aria-label="${escapeHtml(streamer.name || "새 스트리머")} 선택" />
    <label class="streamer-name">스트리머 이름
      <input data-setting="name" maxlength="80" value="${escapeHtml(streamer.name)}" placeholder="예: 스트리머 이름" required />
    </label>
    <label class="streamer-channel">CHZZK 채널 ID
      <input data-setting="channelId" maxlength="128" value="${escapeHtml(channelId)}" placeholder="예시 ) https://chzzk.naver.com/live/0123456789abcdef0123456789abcdef 면 0123456789abcdef0123456789abcdef 를 입력" required />
    </label>
    <div class="switch-field">
      <span class="field-caption">채팅 수집</span>
      <label class="toggle-switch">
        <input data-setting="enabled" type="checkbox" ${streamer.enabled ? "checked" : ""} />
        <span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span>
        <span class="toggle-text">${streamer.enabled ? "활성" : "비활성"}</span>
      </label>
    </div>
    <div class="row-actions-settings">
      <button class="save-streamer" type="button">저장</button>
      <button class="remove-streamer" type="button" aria-label="${escapeHtml(streamer.name || "스트리머")} 삭제">삭제</button>
    </div>`;
  row.querySelector('[data-setting="enabled"]').addEventListener("change", (event) => {
    event.target.closest(".toggle-switch").querySelector(".toggle-text").textContent = event.target.checked ? "활성" : "비활성";
  });
  return row;
}

function updateBulkControls() {
  const checkboxes = [...$("#streamer-settings").querySelectorAll(".streamer-select")];
  const selected = checkboxes.filter((checkbox) => checkbox.checked);
  $("#bulk-delete-streamers").disabled = selected.length === 0;
  $("#select-all-streamers").checked = checkboxes.length > 0 && selected.length === checkboxes.length;
  $("#select-all-streamers").indeterminate = selected.length > 0 && selected.length < checkboxes.length;
}

function setBulkDeleteMode(enabled) {
  state.bulkDeleteMode = enabled;
  $("#enter-bulk-delete").classList.toggle("hidden", enabled);
  $("#bulk-delete-controls").classList.toggle("hidden", !enabled);
  $("#streamer-settings").querySelectorAll(".streamer-select").forEach((checkbox) => {
    checkbox.classList.toggle("hidden", !enabled);
    if (!enabled) checkbox.checked = false;
  });
  if (!enabled) $("#select-all-streamers").checked = false;
  updateBulkControls();
}

function renderCredentialStatus(credentials, validation) {
  const chips = [
    ["NID_AUT", credentials.nidAutConfigured],
    ["NID_SES", credentials.nidSesConfigured]
  ].map(([name, ready]) =>
    `<span class="credential-chip ${ready ? "ready" : ""}">${name} · ${ready ? "설정됨" : "없음"}</span>`
  );
  if (validation?.ok) {
    chips.push(`<span class="credential-chip ready">검증됨${validation.nickname ? ` · ${escapeHtml(validation.nickname)}` : ""}</span>`);
  }
  $("#credential-status").innerHTML = chips.join("");
}

function setCredentialsEditing(enabled, { restore = false } = {}) {
  const hasStoredCredentials = Boolean(state.savedCredentials.NID_AUT || state.savedCredentials.NID_SES);
  state.credentialsEditing = hasStoredCredentials ? enabled : true;
  if (restore) {
    $("#nid-aut").value = state.savedCredentials.NID_AUT;
    $("#nid-ses").value = state.savedCredentials.NID_SES;
    $("#clear-credentials").checked = false;
  }
  $("#nid-aut").readOnly = !state.credentialsEditing;
  $("#nid-ses").readOnly = !state.credentialsEditing;
  $("#nid-aut").disabled = $("#clear-credentials").checked;
  $("#nid-ses").disabled = $("#clear-credentials").checked;
  $("#edit-credentials").classList.toggle("hidden", !hasStoredCredentials || state.credentialsEditing);
  $("#cancel-edit-credentials").classList.toggle("hidden", !hasStoredCredentials || !state.credentialsEditing);
  $("#clear-credentials-control").classList.toggle("hidden", !hasStoredCredentials);
  $("#credential-help").textContent = hasStoredCredentials && !state.credentialsEditing
    ? "현재 저장된 쿠키입니다. 값을 변경하려면 편집하기를 누르세요."
    : "설정 저장 및 적용을 누르면 CHZZK 로그인 여부를 검증한 뒤 저장합니다.";
}

function renderSettings(settings, { preserveCredentialInputs = false } = {}) {
  const credentialDraft = preserveCredentialInputs
    ? {
        nidAut: $("#nid-aut").value,
        nidSes: $("#nid-ses").value,
        clear: $("#clear-credentials").checked
      }
    : null;
  const container = $("#streamer-settings");
  container.replaceChildren(...settings.streamers.map((streamer) => streamerRow(streamer)));
  $("#empty-streamers").classList.toggle("hidden", settings.streamers.length !== 0);
  $("#status-poll-seconds").value = settings.crawler.statusPollSeconds;
  $("#scan-stagger-seconds").value = settings.crawler.scanStaggerSeconds;
  const unlimitedOffChat = settings.crawler.offChatLimitMinutes === null;
  $("#off-chat-unlimited").checked = unlimitedOffChat;
  $("#off-chat-limit-minutes").disabled = unlimitedOffChat;
  if (!unlimitedOffChat) {
    $("#off-chat-limit-minutes").value = settings.crawler.offChatLimitMinutes;
  }
  updateCrawlerRateWarning();
  renderCredentialStatus(settings.credentials, settings.credentialValidation);
  state.savedCredentials = {
    NID_AUT: settings.credentials.NID_AUT || "",
    NID_SES: settings.credentials.NID_SES || ""
  };
  if (!preserveCredentialInputs) {
    state.credentialsEditing = !(settings.credentials.nidAutConfigured || settings.credentials.nidSesConfigured);
  }
  $("#nid-aut").value = credentialDraft?.nidAut ?? state.savedCredentials.NID_AUT;
  $("#nid-ses").value = credentialDraft?.nidSes ?? state.savedCredentials.NID_SES;
  $("#clear-credentials").checked = credentialDraft?.clear || false;
  setCredentialsEditing(state.credentialsEditing);
  $("#settings-message").textContent = "";
  state.settingsLoaded = true;
  updateBulkControls();
}

async function loadSettings() {
  try {
    renderSettings(await api("/api/settings"));
  } catch (error) {
    toast(error.message);
  }
}

async function analyze(file = state.selectedFile) {
  if (!file) {
    toast("먼저 분석할 파일을 선택하세요.");
    return;
  }
  state.selectedFile = file;
  $("#selected-file").textContent = file;
  selectTab("analysis");
  const params = new URLSearchParams({
    path: file,
    user: $("#user-filter").value,
    q: $("#message-filter").value,
    limit: "200"
  });
  try {
    const result = await api(`/api/analysis?${params}`);
    $("#metric-total").textContent = result.totalMessages.toLocaleString("ko-KR");
    $("#metric-filtered").textContent = result.filteredMessages.toLocaleString("ko-KR");
    $("#metric-users").textContent = result.uniqueUsers.toLocaleString("ko-KR");
    $("#message-count").textContent = `최대 200개 표시`;
    $("#user-list").innerHTML = result.users.length ? result.users.map((user) => `
      <div class="user-row">
        <button data-user="${escapeHtml(user.id || user.nickname)}">
          ${escapeHtml(user.nickname)}<small>${escapeHtml(user.id || "ID 없음")}</small>
        </button>
        <strong>${user.count.toLocaleString("ko-KR")}</strong>
      </div>`).join("") : `<div class="empty">참여자 정보가 없습니다.</div>`;
    $("#message-list").innerHTML = result.messages.length ? result.messages.map((record) => `
      <article class="message">
        <div class="message-meta"><strong>${escapeHtml(record.user.nickname)}</strong><span>${new Date(record.messageAt).toLocaleString("ko-KR")}</span></div>
        <p>${escapeHtml(record.message)}</p>
      </article>`).join("") : `<div class="empty">조건에 맞는 채팅이 없습니다.</div>`;
    if (result.invalidLines) toast(`읽을 수 없는 줄 ${result.invalidLines}개를 제외했습니다.`);
  } catch (error) {
    toast(error.message);
  }
}

$("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#setup-error").textContent = "";
  const form = new FormData(event.currentTarget);
  const username = String(form.get("username") || "").trim();
  const password = String(form.get("password") || "");
  if (password !== String(form.get("passwordConfirm") || "")) {
    $("#setup-error").textContent = "비밀번호 확인 값이 일치하지 않습니다.";
    return;
  }
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    event.currentTarget.reset();
    showLogin(result.username, "관리자 계정이 생성되었습니다. 새 계정으로 로그인하세요.");
    $("#login-form").elements.password.focus();
  } catch (error) {
    $("#setup-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#login-error").textContent = "";
  $("#login-message").textContent = "";
  const form = new FormData(event.currentTarget);
  try {
    showApp(await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: form.get("username"), password: form.get("password") })
    }));
    event.currentTarget.reset();
  } catch (error) {
    if (error.payload?.setupRequired) {
      showSetup();
      return;
    }
    $("#login-error").textContent = error.message;
  }
});

$("#logout-button").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  state.csrf = "";
  showLogin();
});
$("#file-list").addEventListener("click", (event) => {
  const open = event.target.closest("[data-open]");
  const analysis = event.target.closest("[data-analyze]");
  const deletion = event.target.closest("[data-delete]");
  if (open?.dataset.type === "directory") loadFiles(open.dataset.open);
  if (open?.dataset.type === "file") analyze(open.dataset.open);
  if (analysis) analyze(analysis.dataset.analyze);
  if (deletion) {
    const itemPath = deletion.dataset.delete;
    const name = itemPath.split("/").pop();
    const kind = deletion.dataset.deleteType === "directory" ? "폴더" : "채팅 파일";
    if (!window.confirm(`“${name}” ${kind}을(를) 삭제하시겠습니까? 삭제 후 복구할 수 없습니다.`)) return;
    api(`/api/files?path=${encodeURIComponent(itemPath)}`, { method: "DELETE" })
      .then(() => {
        if (state.selectedFile === itemPath) state.selectedFile = "";
        toast(`${name} 삭제 완료`);
        loadFiles(state.currentPath);
      })
      .catch((error) => toast(error.message));
  }
});
$("#breadcrumbs").addEventListener("click", (event) => {
  const crumb = event.target.closest("[data-path]");
  if (crumb) loadFiles(crumb.dataset.path);
});
$("#log-file-list").addEventListener("click", (event) => {
  const open = event.target.closest("[data-log-open]");
  const analysis = event.target.closest("[data-log-analyze]");
  if (open?.dataset.type === "directory") loadLogs(open.dataset.logOpen);
  if (open?.dataset.type === "file") analyzeOperationalLog(open.dataset.logOpen);
  if (analysis) analyzeOperationalLog(analysis.dataset.logAnalyze);
});
$("#log-breadcrumbs").addEventListener("click", (event) => {
  const crumb = event.target.closest("[data-log-path]");
  if (crumb) loadLogs(crumb.dataset.logPath);
});
$("#log-filter-form").addEventListener("submit", (event) => {
  event.preventDefault();
  analyzeOperationalLog();
});
$("#log-event-list").addEventListener("click", (event) => {
  const selected = event.target.closest("[data-log-event]");
  if (selected) {
    $("#log-query-filter").value = selected.dataset.logEvent;
    analyzeOperationalLog();
  }
});
$("#filter-form").addEventListener("submit", (event) => { event.preventDefault(); analyze(); });
$("#user-list").addEventListener("click", (event) => {
  const user = event.target.closest("[data-user]");
  if (user) {
    $("#user-filter").value = user.dataset.user;
    analyze();
  }
});
$("#back-to-files").addEventListener("click", () => selectTab("explorer"));
$("#add-streamer").addEventListener("click", () => {
  $("#streamer-settings").append(streamerRow());
  $("#empty-streamers").classList.add("hidden");
  $("#streamer-settings").lastElementChild.querySelector('[data-setting="name"]').focus();
  updateBulkControls();
});
$("#enter-bulk-delete").addEventListener("click", () => setBulkDeleteMode(true));
$("#cancel-bulk-delete").addEventListener("click", () => setBulkDeleteMode(false));
$("#streamer-settings").addEventListener("change", (event) => {
  if (event.target.matches(".streamer-select")) updateBulkControls();
});
$("#edit-credentials").addEventListener("click", () => {
  setCredentialsEditing(true);
  $("#nid-aut").focus();
  $("#nid-aut").select();
});
$("#cancel-edit-credentials").addEventListener("click", () => {
  setCredentialsEditing(false, { restore: true });
});
$("#clear-credentials").addEventListener("change", (event) => {
  $("#nid-aut").disabled = event.target.checked;
  $("#nid-ses").disabled = event.target.checked;
  $("#credential-help").textContent = event.target.checked
    ? "설정 저장 및 적용을 누르면 저장된 쿠키를 모두 삭제합니다."
    : "설정 저장 및 적용을 누르면 CHZZK 로그인 여부를 검증한 뒤 저장합니다.";
});
function collectStreamerSettings() {
  const rows = [...$("#streamer-settings").querySelectorAll(".streamer-row")];
  return rows.map((row) => ({
    name: row.querySelector('[data-setting="name"]').value.trim(),
    channelId: row.querySelector('[data-setting="channelId"]').value.trim(),
    enabled: row.querySelector('[data-setting="enabled"]').checked
  })).filter((streamer) => streamer.name || streamer.channelId);
}

function collectCrawlerSettings() {
  const unlimited = $("#off-chat-unlimited").checked;
  return {
    statusPollSeconds: Number($("#status-poll-seconds").value),
    scanStaggerSeconds: Number($("#scan-stagger-seconds").value),
    offChatLimitMinutes: unlimited ? null : Number($("#off-chat-limit-minutes").value)
  };
}

function crawlerRateWarnings() {
  const warnings = [];
  const pollSeconds = Number($("#status-poll-seconds").value);
  const staggerSeconds = Number($("#scan-stagger-seconds").value);
  if (pollSeconds < 60) warnings.push(`방송 상태 확인 주기가 권장값 60초보다 짧습니다 (${pollSeconds}초).`);
  if (staggerSeconds < 20) warnings.push(`스트리머 간 스캔 간격이 권장값 20초보다 짧습니다 (${staggerSeconds}초).`);
  return warnings;
}

function updateCrawlerRateWarning() {
  const warnings = crawlerRateWarnings();
  const element = $("#crawler-rate-warning");
  element.textContent = warnings.length
    ? `${warnings.join(" ")} 요청이 과도하면 CHZZK에서 사용 중인 IP를 일시적 또는 영구적으로 차단할 수 있습니다.`
    : "";
  element.classList.toggle("hidden", warnings.length === 0);
}

async function persistSettings(
  button,
  successMessage = "설정이 저장되고 크롤러에 적용되었습니다.",
  { includeCredentials = false } = {}
) {
  const crawlerFields = [
    $("#status-poll-seconds"),
    $("#scan-stagger-seconds"),
    $("#off-chat-limit-minutes")
  ];
  const invalidCrawlerField = crawlerFields.find((field) => !field.disabled && !field.checkValidity());
  if (invalidCrawlerField) {
    invalidCrawlerField.reportValidity();
    return false;
  }
  const rateWarnings = crawlerRateWarnings();
  if (
    rateWarnings.length
    && !window.confirm(
      `${rateWarnings.join("\n")}\n\n과도한 요청으로 CHZZK에서 IP가 차단될 수 있습니다. 이 설정을 저장하시겠습니까?`
    )
  ) {
    return false;
  }
  const saveButton = button || $("#save-settings");
  const previousText = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = "저장 중…";
  $("#settings-message").textContent = "설정을 저장하고 크롤러를 다시 시작하는 중입니다…";
  try {
    const settings = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        streamers: collectStreamerSettings(),
        crawler: collectCrawlerSettings(),
        credentials: includeCredentials
          ? {
              NID_AUT: $("#nid-aut").value,
              NID_SES: $("#nid-ses").value,
              clear: $("#clear-credentials").checked
            }
          : {},
        validateCredentials: includeCredentials
      })
    });
    renderSettings(settings, { preserveCredentialInputs: !includeCredentials });
    $("#nid-aut").disabled = false;
    $("#nid-ses").disabled = false;
    const validationMessage = settings.credentialValidation
      ? `${settings.credentialValidation.message}${settings.credentialValidation.nickname ? ` (${settings.credentialValidation.nickname})` : ""}`
      : "";
    $("#settings-message").textContent = validationMessage || `마지막 적용: ${new Date().toLocaleTimeString("ko-KR")}`;
    toast(validationMessage || successMessage);
    await loadStatus();
    return true;
  } catch (error) {
    $("#settings-message").textContent = error.message;
    toast(error.message);
    return false;
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = previousText;
  }
}

$("#streamer-settings").addEventListener("click", async (event) => {
  const save = event.target.closest(".save-streamer");
  const remove = event.target.closest(".remove-streamer");
  if (save) {
    const row = save.closest(".streamer-row");
    const fields = [...row.querySelectorAll("input[required]")];
    const invalid = fields.find((field) => !field.reportValidity());
    if (!invalid) await persistSettings(save, `${row.querySelector('[data-setting="name"]').value.trim()} 설정을 저장했습니다.`);
    return;
  }
  if (!remove) return;
  const row = remove.closest(".streamer-row");
  const name = row.querySelector('[data-setting="name"]').value.trim() || "이 스트리머";
  if (!window.confirm(`“${name}”의 채팅 수집을 중단하시겠습니까?`)) return;
  const persisted = row.dataset.persisted === "true";
  row.remove();
  $("#empty-streamers").classList.toggle("hidden", $("#streamer-settings").children.length !== 0);
  updateBulkControls();
  if (persisted && !(await persistSettings(remove, `${name}을(를) 삭제하고 채팅 수집을 중단했습니다.`))) {
    await loadSettings();
  }
});

$("#select-all-streamers").addEventListener("change", (event) => {
  $("#streamer-settings").querySelectorAll(".streamer-select").forEach((checkbox) => {
    checkbox.checked = event.target.checked;
  });
  updateBulkControls();
});

$("#bulk-delete-streamers").addEventListener("click", async (event) => {
  const selectedRows = [...$("#streamer-settings").querySelectorAll(".streamer-select:checked")]
    .map((checkbox) => checkbox.closest(".streamer-row"));
  if (!selectedRows.length) return;
  if (!window.confirm(`선택한 ${selectedRows.length}명의 채팅 수집을 중단하시겠습니까?`)) return;
  const hasPersisted = selectedRows.some((row) => row.dataset.persisted === "true");
  selectedRows.forEach((row) => row.remove());
  $("#empty-streamers").classList.toggle("hidden", $("#streamer-settings").children.length !== 0);
  updateBulkControls();
  setBulkDeleteMode(false);
  if (hasPersisted && !(await persistSettings(event.currentTarget, `선택한 ${selectedRows.length}명을 삭제했습니다.`))) {
    await loadSettings();
  }
});

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await persistSettings(
    $("#save-settings"),
    "설정이 저장되고 크롤러에 적용되었습니다.",
    { includeCredentials: true }
  );
});
$("#status-poll-seconds").addEventListener("input", updateCrawlerRateWarning);
$("#scan-stagger-seconds").addEventListener("input", updateCrawlerRateWarning);
$("#off-chat-unlimited").addEventListener("change", (event) => {
  $("#off-chat-limit-minutes").disabled = event.target.checked;
  if (!event.target.checked) $("#off-chat-limit-minutes").focus();
});
$$(".tab").forEach((tab) => tab.addEventListener("click", () => {
  if (tab.dataset.tab === "analysis" && !state.selectedFile) toast("탐색기에서 분석할 파일을 선택하세요.");
  selectTab(tab.dataset.tab);
}));

api("/api/auth/session")
  .then((session) => session.setupRequired ? showSetup() : session.authenticated ? showApp(session) : showLogin())
  .catch(() => showLogin());
