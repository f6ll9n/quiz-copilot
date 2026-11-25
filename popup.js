/* Quiz Copilot — popup */

const DEFAULTS = {
  enabled: false,
  autoPick: false,
  minConfidence: 0.6,
  endpoint: "http://localhost:1234/v1",
  model: "",
  apiKey: "",
};

const $ = (sel) => document.querySelector(sel);

const ui = {
  enabled: $("#enabled"),
  autoPick: $("#autoPick"),
  minConfidence: $("#minConfidence"),
  confOut: $("#confOut"),
  endpoint: $("#endpoint"),
  model: $("#model"),
  apiKey: $("#apiKey"),
  models: $("#models"),
  hint: $("#hint"),
  status: $("#status"),
  rescan: $("#rescan"),
  ask: $("#ask"),
  test: $("#test"),
  diag: $("#diag"),
  preset: $("#preset"),
  clearCache: $("#clearCache"),
};

const PRESETS = {
  lmstudio: "http://127.0.0.1:1234/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  github: "https://models.github.ai/inference",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  cerebras: "https://api.cerebras.ai/v1",
};

const PRESET_MODELS = {
  gemini: "gemini-3.5-flash-lite",
  github: "openai/gpt-4.1-mini",
  deepseek: "deepseek-chat",
  mistral: "mistral-small-latest",
};

let saveTimer = null;

init();

async function init() {
  const verEl = document.getElementById("ver");
  if (verEl) verEl.textContent = "v" + chrome.runtime.getManifest().version;

  const cfg = await chrome.storage.local.get(DEFAULTS);

  ui.enabled.checked = !!cfg.enabled;
  ui.autoPick.checked = !!cfg.autoPick;
  ui.minConfidence.value = String(cfg.minConfidence);
  ui.confOut.textContent = Math.round(cfg.minConfidence * 100) + "%";
  ui.endpoint.value = cfg.endpoint || DEFAULTS.endpoint;
  ui.model.value = cfg.model || "";
  ui.apiKey.value = cfg.apiKey || "";

  renderHint();

  ui.enabled.addEventListener("change", () => {
    save({ enabled: ui.enabled.checked });
    renderHint();
    if (ui.enabled.checked) tell("scan").catch(showError);
  });

  ui.autoPick.addEventListener("change", () => save({ autoPick: ui.autoPick.checked }));

  ui.minConfidence.addEventListener("input", () => {
    ui.confOut.textContent = Math.round(ui.minConfidence.value * 100) + "%";
    save({ minConfidence: Number(ui.minConfidence.value) });
  });

  for (const input of [ui.endpoint, ui.model, ui.apiKey]) {
    input.addEventListener("input", () => scheduleSave());
  }

  ui.rescan.addEventListener("click", async () => {
    setStatus("Сканирую страницу…");
    try {
      const resp = await tell("scan");
      if (resp && resp.ok) {
        setStatus(
          resp.count ? `Вопросов: ${resp.count} · подсказок: ${resp.hints}` : "Вопросы не найдены",
          resp.count ? "ok" : ""
        );
      } else {
        setStatus((resp && resp.error) || "Не получилось", "error");
      }
    } catch (e) {
      showError(e);
    }
  });

  ui.ask.addEventListener("click", async () => {
    setStatus("Спрашиваю модель…");
    try {
      const resp = await tell("ask-selection");
      if (resp && resp.ok) setStatus("Ответ показан на странице", "ok");
      else setStatus((resp && resp.error) || "Не получилось", "error");
    } catch (e) {
      showError(e);
    }
  });

  ui.test.addEventListener("click", testConnection);
  ui.diag.addEventListener("click", runDiagnostics);

  ui.clearCache.addEventListener("click", async () => {
    await chrome.storage.local.set({ qcCache: {} });
    setStatus("Кэш ответов очищен", "ok");
  });

  ui.preset.addEventListener("change", async () => {
    const url = PRESETS[ui.preset.value];
    if (!url) return;
    ui.endpoint.value = url;
    ui.model.value = PRESET_MODELS[ui.preset.value] || "";
    await save({ endpoint: url, model: ui.model.value });
    setStatus("Теперь вставьте API-ключ и нажмите «Проверить связь»");
  });
}

/* ---------- storage ---------- */

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    save({
      endpoint: ui.endpoint.value.trim() || DEFAULTS.endpoint,
      model: ui.model.value.trim(),
      apiKey: ui.apiKey.value.trim(),
    });
  }, 350);
}

async function save(patch) {
  await chrome.storage.local.set(patch);
}

function renderHint() {
  ui.hint.textContent = ui.enabled.checked ? "Включён — ищу вопросы" : "Выключен";
}

/* ---------- content script ---------- */

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("Нет активной вкладки");
  if (tab.url && !/^https?:/i.test(tab.url)) {
    throw new Error("На этой странице расширение не работает (chrome:// и служебные страницы)");
  }
  return tab;
}

async function tell(type) {
  const tab = await activeTab();

  try {
    return await chrome.tabs.sendMessage(tab.id, { type });
  } catch (_) {
    /* content script ещё не в странице — внедрим вручную */
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(tab.id, { type });
  } catch (_) {
    throw new Error("Не удалось подключиться к странице. Обновите её (F5) или откройте обычный сайт.");
  }
}

/* ---------- diagnostics ---------- */

async function runDiagnostics() {
  setStatus("Смотрю, что видно на странице…");

  try {
    const tab = await activeTab();
    const reports = await frameReports(tab);
    console.log("Quiz Copilot diagnostics:", reports);

    if (!reports.length) {
      setStatus("Content script не отвечает — обновите страницу (F5)", "error");
      return;
    }

    const total = reports.reduce((n, r) => n + (r.questions || 0), 0);
    const best = reports.slice().sort((a, b) => (b.questions || 0) - (a.questions || 0))[0];

    if (total > 0) {
      setStatus(`кадров ${reports.length} · вопросов ${total} — всё видно`, "ok");
      return;
    }

    setStatus(
      `не нашёл: inputs ${best.controls} (radio ${best.radio}, check ${best.checkbox}) · ` +
        `групп ${best.groups} · кадров ${reports.length}`,
      "error"
    );
  } catch (e) {
    showError(e);
  }
}

async function frameReports(tab) {
  const probe = () =>
    chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => (typeof window.__qcReport === "function" ? window.__qcReport() : null),
    });

  let results = [];
  try {
    results = await probe();
  } catch (_) {
    results = [];
  }

  if (!results.some((r) => r && r.result)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["content.js"],
      });
      results = await probe();
    } catch (_) {
      return [];
    }
  }

  return results.map((r) => r && r.result).filter(Boolean);
}

/* ---------- connection ---------- */

async function testConnection() {
  const endpoint = ui.endpoint.value.trim() || DEFAULTS.endpoint;

  try {
    // разрешение спрашиваем сразу после клика — так требует Chrome
    const granted = await ensureHostPermission(endpoint);
    if (!granted) {
      setStatus("Нужно разрешение на доступ к этому адресу", "error");
      return;
    }

    setStatus("Проверяю соединение…", "");
    await save({ endpoint, model: ui.model.value.trim(), apiKey: ui.apiKey.value.trim() });

    const resp = await chrome.runtime.sendMessage({ type: "ping" });

    if (resp && resp.ok) {
      if (resp.endpoint) {
        ui.endpoint.value = resp.endpoint;
        await save({ endpoint: resp.endpoint });
      }
      fillModels(resp.chatModels || []);

      const chat = resp.chatModels || [];
      if (!chat.length) {
        setStatus(resp.message || "Сервер отвечает, но чат-модели нет", "error");
        return;
      }

      const where = resp.switched ? "нашёл на " + resp.endpoint + " · " : "";
      const shown = chat.slice(0, 3).join(", ") + (chat.length > 3 ? " и ещё " + (chat.length - 3) : "");
      setStatus(where + shown, "ok");
    } else {
      setStatus((resp && resp.error) || "Нет связи", "error");
    }
  } catch (e) {
    showError(e);
  }
}

async function ensureHostPermission(endpoint) {
  let origin;
  try {
    origin = new URL(endpoint).origin + "/*";
  } catch (_) {
    throw new Error("Некорректный адрес endpoint");
  }
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (_) {
    return false;
  }
}

function fillModels(models) {
  ui.models.textContent = "";
  for (const id of models) {
    const opt = document.createElement("option");
    opt.value = id;
    ui.models.appendChild(opt);
  }
}

/* ---------- ui helpers ---------- */

function setStatus(text, kind) {
  ui.status.textContent = text || "";
  ui.status.dataset.kind = kind || "";
}

function showError(e) {
  setStatus(String((e && e.message) || e || "ошибка"), "error");
}
