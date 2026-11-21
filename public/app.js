const state = {
  csrf: "",
  deleteEnabled: false,
  currentPath: "",
  streamers: [],
  days: {},
  undated: 0,
  calendarMonth: "",
  selectedDay: "",
  recentFiles: [],
  dayFiles: [],
  selectedFile: "",
  messages: [],
  renderedMessages: 0,
  analysisRequest: 0,
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
  loadFilePolicy().finally(loadFiles);
  loadStatus();
  loadCookieHealth();
  state.statusTimer = setInterval(loadStatus, 15_000);
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.remove("hidden");
  setTimeout(() => element.classList.add("hidden"), 3000);
}

async function loadFilePolicy() {
  try {
    state.deleteEnabled = (await api("/api/files/policy")).deleteEnabled === true;
  } catch {
    state.deleteEnabled = false;
  }
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

function kstDayKey(date = new Date()) {
  return dayKeyFormat.format(date);
}

function shiftDayKey(key, days) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

async function filesIn(query) {
  return api(`/api/files?${new URLSearchParams({ path: state.currentPath, ...query })}`);
}

// Entry point for "채팅 기록 보기": streamers across the top, the last week as a list, older days through the calendar.
const COOKIE_STATE_LABELS = { valid: "유효", expired: "만료", failed: "확인 실패", missing: "쿠키 없음", unknown: "확인 전" };

function renderCookieHealth(health) {
  $("#cookie-banner").classList.toggle("hidden", health.state !== "expired");
  const badge = $("#cookie-health-state");
  badge.className = `cookie-state ${health.state}`;
  badge.textContent = COOKIE_STATE_LABELS[health.state] || health.state;
  const parts = [];
  if (health.nickname) parts.push(health.nickname);
  if (health.message && health.state !== "valid") parts.push(health.message);
  if (health.checkedAt) parts.push(`마지막 확인 ${new Date(health.checkedAt).toLocaleString("ko-KR")}`);
  $("#cookie-health-detail").textContent = parts.join(" · ");
}

async function loadCookieHealth() {
  try {
    renderCookieHealth(await api("/api/cookie-status"));
  } catch (error) {
    console.error(error);
  }
}

async function loadFiles(path = state.currentPath) {
  try {
    const root = await api("/api/files?path=");
    state.streamers = root.filter((item) => item.type === "directory").map((item) => item.path);
    if (root.some((item) => item.type === "file")) state.streamers.push("");
    if (!state.streamers.includes(path)) path = state.streamers[0] ?? "";
    if (path !== state.currentPath) state.selectedDay = "";
    state.currentPath = path;
    const today = kstDayKey();
    const [calendar, recent] = await Promise.all([
      api(`/api/files/days?path=${encodeURIComponent(path)}`),
      filesIn({ from: shiftDayKey(today, -2), to: today })
    ]);
    state.days = calendar.days;
    state.undated = calendar.undated;
    state.recentFiles = recent;
    const known = Object.keys(state.days).sort();
    if (!state.calendarMonth) state.calendarMonth = (known.at(-1) || today).slice(0, 7);
    if (state.selectedDay && state.selectedDay !== "undated" && !state.days[state.selectedDay]) state.selectedDay = "";
    renderExplorer();
    if (state.selectedDay) await selectDay(state.selectedDay);
  } catch (error) {
    toast(error.message);
  }
}

async function selectDay(day) {
  state.selectedDay = day;
  try {
    state.dayFiles = day === "undated" ? await filesIn({ undated: "1" }) : await filesIn({ from: day, to: day });
  } catch (error) {
    state.dayFiles = [];
    toast(error.message);
  }
  renderExplorer();
}

const KST = "Asia/Seoul";
const dayKeyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: KST, year: "numeric", month: "2-digit", day: "2-digit" });
const startLabelFormat = new Intl.DateTimeFormat("ko-KR", {
  timeZone: KST, month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});

function fileKindLabel(item) {
  if (item.type === "directory") return "폴더";
  if (item.encoding === "unavailable") return "확인 필요";
  return item.encoding === "gzip" ? "압축됨" : "원본";
}

function fileRow(item) {
  const started = item.startedAt ? new Date(item.startedAt) : null;
  const title = started
    ? `<span class="file-start">${escapeHtml(startLabelFormat.format(started))}</span>
       <span class="kind-badge ${item.kind}">${item.kind === "live" ? "LIVE" : "OFF"}</span>
       <small class="file-name">${escapeHtml(item.name)}</small>`
    : escapeHtml(item.name);
  return `
    <tr>
      <td><button class="file-button" data-open="${escapeHtml(item.path)}">${title}</button></td>
      <td>${fileKindLabel(item)}</td>
      <td>${item.size === null ? "—" : formatBytes(item.size)}</td>
      <td><div class="row-actions">
        ${item.encoding === "gzip" ? `<a href="/api/files/download?path=${encodeURIComponent(item.path)}&format=gzip">압축본</a>` : ""}<a href="/api/files/download?path=${encodeURIComponent(item.path)}&format=jsonl">JSONL</a>
        ${state.deleteEnabled ? `<button class="delete-archive" data-delete="${escapeHtml(item.path)}">삭제</button>` : ""}
      </div></td>
    </tr>`;
}

function fileTable(items, emptyText) {
  return items.length
    ? `<div class="table-wrap"><table class="file-table"><tbody>${items.map(fileRow).join("")}</tbody></table></div>`
    : `<div class="empty compact">${escapeHtml(emptyText)}</div>`;
}

function renderCalendar() {
  const [year, month] = state.calendarMonth.split("-").map(Number);
  const today = kstDayKey();
  const years = new Set(Object.keys(state.days).map((day) => Number(day.slice(0, 4))));
  years.add(year);
  years.add(Number(today.slice(0, 4)));
  const monthTotals = Array.from({ length: 12 }, () => 0);
  for (const [day, count] of Object.entries(state.days)) {
    if (Number(day.slice(0, 4)) === year) monthTotals[Number(day.slice(5, 7)) - 1] += count.live + count.off;
  }
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells = Array.from({ length: firstWeekday }, () => `<span class="calendar-cell blank"></span>`);
  for (let date = 1; date <= daysInMonth; date += 1) {
    const key = `${state.calendarMonth}-${String(date).padStart(2, "0")}`;
    const count = state.days[key];
    const classes = ["calendar-cell", count ? "has-files" : "", key === today ? "today" : "", key === state.selectedDay ? "selected" : ""].join(" ");
    cells.push(count
      ? `<button type="button" class="${classes}" data-day="${key}" aria-pressed="${key === state.selectedDay}">
           <span class="calendar-date">${date}</span>
           <span class="calendar-marks">${count.live ? `<i class="mark live">LIVE${count.live > 1 ? ` ${count.live}` : ""}</i>` : ""}${count.off ? `<i class="mark off">OFF${count.off > 1 ? ` ${count.off}` : ""}</i>` : ""}</span>
         </button>`
      : `<span class="${classes}"><span class="calendar-date">${date}</span></span>`);
  }
  return `
    <div class="calendar-toolbar">
      <button type="button" class="ghost-button" data-calendar-step="-1" aria-label="이전 달">‹</button>
      <strong>${year}년 ${month}월</strong>
      <button type="button" class="ghost-button" data-calendar-step="1" aria-label="다음 달">›</button>
      <select id="calendar-year" aria-label="연도">${[...years].sort((a, b) => b - a).map((value) => `<option value="${value}" ${value === year ? "selected" : ""}>${value}년</option>`).join("")}</select>
    </div>
    <div class="month-strip">${monthTotals.map((total, index) => `
      <button type="button" data-calendar-month="${index + 1}" class="${index + 1 === month ? "active" : ""} ${total ? "" : "none"}">
        ${index + 1}월${total ? `<small>${total}</small>` : ""}
      </button>`).join("")}</div>
    <div class="calendar-grid">
      ${["일", "월", "화", "수", "목", "금", "토"].map((name) => `<span class="calendar-weekday">${name}</span>`).join("")}
      ${cells.join("")}
    </div>`;
}

function renderExplorer() {
  $("#streamer-tabs").innerHTML = state.streamers.length > 1 ? state.streamers.map((path) =>
    `<button type="button" data-streamer="${escapeHtml(path)}" class="${path === state.currentPath ? "active" : ""}">${escapeHtml(path || "기타")}</button>`
  ).join("") : "";
  $("#streamer-tabs").classList.toggle("hidden", state.streamers.length <= 1);
  $("#explorer-streamer").textContent = state.streamers.length ? (state.currentPath || "기타") : "";
  const hasAny = Object.keys(state.days).length > 0 || state.undated > 0;
  $("#empty-files").classList.toggle("hidden", hasAny);
  $("#explorer-body").classList.toggle("hidden", !hasAny);
  if (!hasAny) return;
  $("#recent-files").innerHTML = fileTable(state.recentFiles, "최근 3일 동안 기록된 방송이 없습니다.");
  $("#recent-count").textContent = state.recentFiles.length ? `${state.recentFiles.length}개` : "";
  $("#calendar").innerHTML = renderCalendar();
  $("#undated-link").classList.toggle("hidden", !state.undated);
  $("#undated-link").textContent = `날짜를 알 수 없는 파일 ${state.undated}개`;
  const picked = $("#day-files");
  if (!state.selectedDay) {
    picked.innerHTML = `<div class="empty compact">달력에서 표시된 날짜를 누르면 그날의 방송이 여기에 나옵니다.</div>`;
    $("#day-title").textContent = "선택한 날";
  } else {
    $("#day-title").textContent = state.selectedDay === "undated"
      ? "날짜를 알 수 없는 파일"
      : logDayFormat.format(new Date(`${state.selectedDay}T12:00:00+09:00`));
    picked.innerHTML = fileTable(state.dayFiles, "이 날짜에는 방송 기록이 없습니다.");
  }
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
  if (name === "logs") loadLogs();
  if (name === "settings") { loadCookieHealth(); loadMcpKeys(); }
}

const LOG_CATEGORY_LABELS = { crawler: "수집", system: "시스템", auth: "로그인", settings: "설정", files: "파일" };
const LOG_LEVEL_LABELS = { info: "정보", warn: "경고", error: "오류" };
const logDayFormat = new Intl.DateTimeFormat("ko-KR", { timeZone: KST, month: "long", day: "numeric", weekday: "long" });
const logState = { days: 1, category: "", request: 0 };

// The few detail fields worth showing without opening the entry.
function logContext(details) {
  if (!details) return "";
  const parts = [];
  if (details.streamer) parts.push(details.streamer);
  if (details.from && details.to) parts.push(`${details.from} → ${details.to}`);
  if (details.username) parts.push(details.username);
  if (details.error) parts.push(details.error);
  return parts.join(" · ");
}

async function loadLogs() {
  const params = new URLSearchParams({
    days: String(logState.days),
    category: logState.category,
    level: $("#log-level-filter").value,
    q: $("#log-query-filter").value,
    routine: $("#log-routine").checked ? "1" : "0"
  });
  const request = ++logState.request;
  try {
    const result = await api(`/api/logs/timeline?${params}`);
    if (request !== logState.request) return;
    const number = (value) => value.toLocaleString("ko-KR");
    $("#log-summary").innerHTML = `
      <span class="log-stat stat-error ${result.levels.error ? "" : "zero"}">오류 ${number(result.levels.error)}</span>
      <span class="log-stat stat-warn ${result.levels.warn ? "" : "zero"}">경고 ${number(result.levels.warn)}</span>
      <span class="log-stat">기록 ${number(result.levels.info)}</span>
      <span class="log-stat muted-stat">방송 상태 확인 ${number(Math.round(result.routine / 2))}회</span>`;
    const timeline = $("#log-timeline");
    timeline.replaceChildren();
    if (!result.records.length) {
      timeline.innerHTML = `<div class="empty">이 기간에 해당하는 기록이 없습니다.</div>`;
      return;
    }
    let day = "";
    const fragment = document.createDocumentFragment();
    for (const record of result.records) {
      const at = new Date(record.timestamp);
      const label = logDayFormat.format(at);
      if (label !== day) {
        const divider = document.createElement("div");
        divider.className = "day-divider";
        divider.textContent = label;
        fragment.append(divider);
        day = label;
      }
      const entry = document.createElement("details");
      entry.className = `log-entry level-${record.level}`;
      const summary = document.createElement("summary");
      const time = document.createElement("time");
      time.textContent = messageTimeFormat.format(at);
      const level = document.createElement("span");
      level.className = "log-level-dot";
      level.title = LOG_LEVEL_LABELS[record.level] || record.level;
      const category = document.createElement("span");
      category.className = "log-category";
      category.textContent = LOG_CATEGORY_LABELS[record.category] || record.category;
      const text = document.createElement("span");
      text.className = "log-text";
      text.textContent = record.message;
      const context = logContext(record.details);
      if (context) {
        const extra = document.createElement("small");
        extra.textContent = context;
        text.append(" ", extra);
      }
      summary.append(time, level, category, text);
      const detail = document.createElement("pre");
      detail.className = "log-details";
      detail.textContent = `${record.event}\n${record.details ? JSON.stringify(record.details, null, 2) : "상세 정보 없음"}`;
      entry.append(summary, detail);
      fragment.append(entry);
    }
    if (result.truncated) {
      const note = document.createElement("div");
      note.className = "empty";
      note.textContent = `최근 ${number(result.records.length)}건만 표시했습니다. 기간을 줄이거나 검색어를 넣어 좁혀 보세요.`;
      fragment.append(note);
    }
    timeline.append(fragment);
    if (result.invalidLines) toast(`읽을 수 없는 로그 ${result.invalidLines}줄을 제외했습니다.`);
  } catch (error) {
    if (request === logState.request) toast(error.message);
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
  $("#web-delete-enabled").checked = settings.crawler.webDeleteEnabled !== false;
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

const MESSAGE_BATCH = 400;
const EMOJI_TOKEN = /\{:([^:{}\s]+):\}/g;
const EVENT_LABELS = { donation: "후원", subscription: "구독", system: "시스템" };

const messageTimeFormat = new Intl.DateTimeFormat("ko-KR", { timeZone: KST, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const messageDayFormat = new Intl.DateTimeFormat("ko-KR", { timeZone: KST, year: "numeric", month: "long", day: "numeric", weekday: "long" });

// Stable per-participant colour so a conversation is easier to follow.
function nickColor(identity) {
  let hash = 0;
  for (let index = 0; index < identity.length; index += 1) hash = (hash * 31 + identity.charCodeAt(index)) >>> 0;
  return `hsl(${hash % 360} 62% 70%)`;
}

function appendMessageText(body, record) {
  const text = record.message;
  const emojis = record.emojis;
  if (!emojis) {
    body.append(text);
    return;
  }
  let last = 0;
  for (const match of text.matchAll(EMOJI_TOKEN)) {
    const key = emojis[match[1]];
    if (!key) continue;
    if (match.index > last) body.append(text.slice(last, match.index));
    const image = document.createElement("img");
    image.className = "emoji";
    image.alt = match[0];
    image.title = match[1];
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => image.replaceWith(match[0]), { once: true });
    image.src = `/api/emoji/${encodeURIComponent(key)}`;
    body.append(image);
    last = match.index + match[0].length;
  }
  if (last < text.length) body.append(text.slice(last));
}

function messageNode(record) {
  const at = new Date(record.messageAt);
  const article = document.createElement("article");
  article.className = `message ${EVENT_LABELS[record.event] ? record.event : ""}`.trim();
  const time = document.createElement("time");
  time.dateTime = record.messageAt;
  time.title = at.toLocaleString("ko-KR");
  time.textContent = messageTimeFormat.format(at);
  const body = document.createElement("div");
  body.className = "message-body";
  const name = document.createElement("button");
  name.type = "button";
  name.className = "nick";
  name.dataset.user = record.user.id || record.user.nickname;
  name.title = "이 참여자의 채팅만 보기";
  name.textContent = record.user.nickname;
  name.style.color = nickColor(name.dataset.user);
  body.append(name);
  if (EVENT_LABELS[record.event]) {
    const badge = document.createElement("span");
    badge.className = "event-badge";
    badge.textContent = EVENT_LABELS[record.event];
    body.append(badge);
  }
  appendMessageText(body, record);
  article.append(time, body);
  return article;
}

// The whole result is held in memory; only the part the reader has scrolled to is put in the DOM.
function renderMoreMessages() {
  const next = state.messages.slice(state.renderedMessages, state.renderedMessages + MESSAGE_BATCH);
  if (!next.length) return;
  const fragment = document.createDocumentFragment();
  for (const record of next) {
    const day = messageDayFormat.format(new Date(record.messageAt));
    if (day !== state.renderedDay) {
      const divider = document.createElement("div");
      divider.className = "day-divider";
      divider.textContent = day;
      fragment.append(divider);
      state.renderedDay = day;
    }
    fragment.append(messageNode(record));
  }
  $("#message-list").append(fragment);
  state.renderedMessages += next.length;
}

async function analyze(file = state.selectedFile) {
  if (!file) {
    toast("먼저 분석할 파일을 선택하세요.");
    return;
  }
  if (file !== state.selectedFile) {
    $("#user-filter").value = "";
    $("#message-filter").value = "";
  }
  state.selectedFile = file;
  $("#selected-file").textContent = file;
  selectTab("analysis");
  const params = new URLSearchParams({
    path: file,
    user: $("#user-filter").value,
    q: $("#message-filter").value,
    limit: "all"
  });
  const request = ++state.analysisRequest;
  $("#message-count").textContent = "불러오는 중…";
  try {
    const result = await api(`/api/analysis?${params}`);
    if (request !== state.analysisRequest) return;
    $("#metric-total").textContent = result.totalMessages.toLocaleString("ko-KR");
    $("#metric-filtered").textContent = result.filteredMessages.toLocaleString("ko-KR");
    $("#metric-users").textContent = result.uniqueUsers.toLocaleString("ko-KR");
    $("#user-list").innerHTML = result.users.length ? result.users.map((user) => `
      <div class="user-row">
        <button data-user="${escapeHtml(user.id || user.nickname)}">
          ${escapeHtml(user.nickname)}<small>${escapeHtml(user.id || "ID 없음")}</small>
        </button>
        <strong>${user.count.toLocaleString("ko-KR")}</strong>
      </div>`).join("") : `<div class="empty">참여자 정보가 없습니다.</div>`;
    $("#message-count").textContent = `${result.messages.length.toLocaleString("ko-KR")}개`;
    state.messages = result.messages;
    state.renderedMessages = 0;
    state.renderedDay = "";
    const list = $("#message-list");
    list.scrollTop = 0;
    if (result.messages.length) {
      list.replaceChildren();
      renderMoreMessages();
    } else {
      list.innerHTML = `<div class="empty">조건에 맞는 채팅이 없습니다.</div>`;
    }
    if (result.invalidLines) toast(`읽을 수 없는 줄 ${result.invalidLines}개를 제외했습니다.`);
  } catch (error) {
    if (request !== state.analysisRequest) return;
    $("#message-count").textContent = "";
    state.messages = [];
    state.renderedMessages = 0;
    state.renderedDay = "";
    $("#message-list").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    toast(error.message);
  }
}

$("#message-list").addEventListener("click", (event) => {
  const user = event.target.closest("[data-user]");
  if (user) {
    $("#user-filter").value = user.dataset.user;
    analyze();
  }
});
$("#message-list").addEventListener("scroll", (event) => {
  const list = event.currentTarget;
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 600) renderMoreMessages();
}, { passive: true });

$("#rebuild-analysis").addEventListener("click", async (event) => {
  if (!state.selectedFile) { toast("먼저 분석할 파일을 선택하세요."); return; }
  const button = event.currentTarget;
  button.disabled = true;
  try {
    toast("검색 자료를 준비하고 있습니다.");
    await api("/api/analysis/rebuild", { method: "POST", body: JSON.stringify({ path: state.selectedFile }) });
    await analyze();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

$("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#setup-error").textContent = "";
  const formElement = event.currentTarget;
  const formData = new FormData(formElement);
  const username = String(formData.get("username") || "").trim();
  const password = String(formData.get("password") || "");
  if (password !== String(formData.get("passwordConfirm") || "")) {
    $("#setup-error").textContent = "비밀번호 확인 값이 일치하지 않습니다.";
    return;
  }
  const submit = formElement.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    formElement.reset();
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
  const formElement = event.currentTarget;
  const formData = new FormData(formElement);
  try {
    showApp(await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: formData.get("username"), password: formData.get("password") })
    }));
    formElement.reset();
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
$("#explorer-panel").addEventListener("click", (event) => {
  const open = event.target.closest("[data-open]");
  if (open) return void analyze(open.dataset.open);
  const streamer = event.target.closest("[data-streamer]");
  if (streamer) {
    state.calendarMonth = "";
    return void loadFiles(streamer.dataset.streamer);
  }
  const day = event.target.closest("[data-day]");
  if (day) return void selectDay(day.dataset.day);
  if (event.target.closest("#undated-link")) return void selectDay("undated");
  const step = event.target.closest("[data-calendar-step]");
  const month = event.target.closest("[data-calendar-month]");
  if (step || month) {
    const [year, current] = state.calendarMonth.split("-").map(Number);
    const target = month ? new Date(Date.UTC(year, Number(month.dataset.calendarMonth) - 1, 1))
      : new Date(Date.UTC(year, current - 1 + Number(step.dataset.calendarStep), 1));
    state.calendarMonth = target.toISOString().slice(0, 7);
    return void renderExplorer();
  }
  const deletion = event.target.closest("[data-delete]");
  if (deletion) {
    const itemPath = deletion.dataset.delete;
    const name = itemPath.split("/").pop();
    if (!window.confirm(`“${name}” 채팅 파일을 삭제하시겠습니까? 삭제 후 복구할 수 없습니다.`)) return;
    api(`/api/files?path=${encodeURIComponent(itemPath)}`, { method: "DELETE" })
      .then(() => {
        if (state.selectedFile === itemPath) state.selectedFile = "";
        toast(`${name} 삭제 완료`);
        loadFiles();
      })
      .catch((error) => toast(error.message));
  }
});
$("#check-cookies").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const health = await api("/api/cookie-status/check", { method: "POST" });
    renderCookieHealth(health);
    toast(`쿠키 상태: ${COOKIE_STATE_LABELS[health.state] || health.state}`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
async function loadMcpKeys() {
  $("#mcp-url").textContent = `${location.origin}/mcp`;
  try {
    const keys = await api("/api/mcp-keys");
    $("#mcp-keys").innerHTML = keys.length ? keys.map((key) => `
      <div class="mcp-key">
        <div><strong>${escapeHtml(key.name)}</strong>
          <small>발급 ${new Date(key.createdAt).toLocaleDateString("ko-KR")} · ${key.lastUsedAt ? `마지막 사용 ${new Date(key.lastUsedAt).toLocaleString("ko-KR")}` : "사용 기록 없음"}</small></div>
        <button type="button" class="danger-button" data-revoke-key="${escapeHtml(key.id)}" data-key-name="${escapeHtml(key.name)}">폐기</button>
      </div>`).join("") : `<div class="settings-empty">발급된 키가 없습니다.</div>`;
  } catch (error) {
    toast(error.message);
  }
}

$("#create-mcp-key").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const name = $("#mcp-key-name").value.trim();
  if (!name) { $("#mcp-key-name").focus(); toast("키 이름을 입력하세요."); return; }
  button.disabled = true;
  try {
    const created = await api("/api/mcp-keys", { method: "POST", body: JSON.stringify({ name }) });
    $("#mcp-key-name").value = "";
    $("#mcp-new-key-value").textContent = created.key;
    $("#mcp-new-key-command").textContent = `claude mcp add --transport http chzzk-chat ${location.origin}/mcp --header "Authorization: Bearer ${created.key}"`;
    $("#mcp-new-key").classList.remove("hidden");
    await loadMcpKeys();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#copy-mcp-key").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#mcp-new-key-value").textContent);
    toast("키를 복사했습니다.");
  } catch {
    toast("복사하지 못했습니다. 키를 직접 선택해 복사하세요.");
  }
});
$("#hide-mcp-key").addEventListener("click", () => {
  $("#mcp-new-key-value").textContent = "";
  $("#mcp-new-key-command").textContent = "";
  $("#mcp-new-key").classList.add("hidden");
});
$("#mcp-keys").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-revoke-key]");
  if (!button) return;
  if (!window.confirm(`“${button.dataset.keyName}” 키를 폐기하시겠습니까? 이 키를 쓰는 연결은 바로 끊깁니다.`)) return;
  try {
    await api(`/api/mcp-keys/${encodeURIComponent(button.dataset.revokeKey)}`, { method: "DELETE" });
    toast("키를 폐기했습니다.");
    await loadMcpKeys();
  } catch (error) {
    toast(error.message);
  }
});
$("#import-cookies").addEventListener("click", () => $("#cookie-file").click());
$("#cookie-file").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > 1024 * 1024) { toast("쿠키 파일이 너무 큽니다(1MB 이하만 읽습니다)."); return; }
  let result;
  try {
    result = window.parseCookieFile(await file.text());
  } catch {
    toast("쿠키 파일을 읽지 못했습니다.");
    return;
  }
  if (result.missing.length) {
    toast(`파일에서 ${result.missing.join(", ")} 값을 찾지 못했습니다. 네이버에 로그인한 상태로 chzzk.naver.com에서 내보냈는지 확인하세요.`);
    return;
  }
  $("#clear-credentials").checked = false;
  setCredentialsEditing(true);
  $("#nid-aut").value = result.NID_AUT;
  $("#nid-ses").value = result.NID_SES;
  const expiry = result.expiresAt ? ` 파일에 적힌 만료일은 ${new Date(result.expiresAt).toLocaleDateString("ko-KR")}입니다.` : "";
  $("#credential-help").textContent = `파일에서 두 값을 가져왔습니다.${expiry} 설정 저장 및 적용을 누르면 로그인 여부를 검증한 뒤 저장합니다.`;
  toast("쿠키 값을 채웠습니다. 설정 저장 및 적용을 눌러 주세요.");
});
$("#cookie-banner-open").addEventListener("click", () => selectTab("settings"));
$("#explorer-panel").addEventListener("change", (event) => {
  if (event.target.id !== "calendar-year") return;
  state.calendarMonth = `${event.target.value}-${state.calendarMonth.slice(5)}`;
  renderExplorer();
});
$("#log-period").addEventListener("click", (event) => {
  const button = event.target.closest("[data-days]");
  if (!button) return;
  logState.days = Number(button.dataset.days);
  $$("#log-period button").forEach((item) => item.classList.toggle("active", item === button));
  loadLogs();
});
$("#log-category").addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  logState.category = button.dataset.category;
  $$("#log-category button").forEach((item) => item.classList.toggle("active", item === button));
  loadLogs();
});
$("#log-filter-form").addEventListener("submit", (event) => { event.preventDefault(); loadLogs(); });
$("#log-level-filter").addEventListener("change", loadLogs);
$("#log-routine").addEventListener("change", loadLogs);
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
    offChatLimitMinutes: unlimited ? null : Number($("#off-chat-limit-minutes").value),
    webDeleteEnabled: $("#web-delete-enabled").checked
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
    if (state.deleteEnabled !== (settings.crawler.webDeleteEnabled !== false)) {
      state.deleteEnabled = settings.crawler.webDeleteEnabled !== false;
      loadFiles();
    }
    $("#nid-aut").disabled = false;
    $("#nid-ses").disabled = false;
    const validationMessage = settings.credentialValidation
      ? `${settings.credentialValidation.message}${settings.credentialValidation.nickname ? ` (${settings.credentialValidation.nickname})` : ""}`
      : "";
    $("#settings-message").textContent = validationMessage || `마지막 적용: ${new Date().toLocaleTimeString("ko-KR")}`;
    toast(validationMessage || successMessage);
    await loadStatus();
    setTimeout(loadCookieHealth, 1500);
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
  if (tab.dataset.tab === "analysis" && !state.selectedFile) toast("채팅 기록 보기에서 방송을 선택하세요.");
  selectTab(tab.dataset.tab);
}));

api("/api/auth/session")
  .then((session) => session.setupRequired ? showSetup() : session.authenticated ? showApp(session) : showLogin())
  .catch(() => showLogin());
