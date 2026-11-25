/* Quiz Copilot — service worker.
   Общается с OpenAI-совместимым API (по умолчанию — локальный LM Studio).
   Умеет сам находить сервер: перебирает localhost/127.0.0.1 и типовые порты. */

const DEFAULTS = {
  enabled: false,
  autoPick: false,
  minConfidence: 0.6,
  endpoint: "http://localhost:1234/v1",
  model: "",
  apiKey: "",
  temperature: 0,
};

const PORT_CANDIDATES = [1234, 1235, 8080, 8000, 11434, 5000, 3000, 1337];
const REQUEST_TIMEOUT_MS = 60000;
const PROBE_TIMEOUT_MS = 2500;

/* ---------- lifecycle ---------- */

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(null);
  const patch = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in stored)) patch[key] = DEFAULTS[key];
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-quiz-copilot") return;
  const { enabled } = await chrome.storage.local.get({ enabled: false });
  await chrome.storage.local.set({ enabled: !enabled });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "solve":
          sendResponse(await solveQuestions(msg.payload));
          break;
        case "solveText":
          sendResponse(await solveText(msg.text));
          break;
        case "ping":
          sendResponse(await ping());
          break;
        default:
          sendResponse({ ok: false, error: "unknown message: " + (msg && msg.type) });
      }
    } catch (e) {
      sendResponse({ ok: false, error: toMessage(e) });
    }
  })();
  return true; // async response
});

/* ---------- prompts ---------- */

const SYSTEM_SOLVE = `Ты — ассистент для тренировочных тестов. Тебе дают вопросы и варианты ответов.
Отвечай строго одним JSON-объектом, без markdown, без комментариев:
{"answers":[{"id":"<id из запроса>","choices":[<номера правильных вариантов, с нуля>],"confidence":<0..1>,"why":"<одно короткое предложение на языке вопроса>"}]}
Правила:
- Если у вопроса "multi": true — верни все правильные индексы. Иначе ровно один.
- Индексы считаются от 0 в порядке переданного массива "options".
- Если данных реально не хватает — "choices": [] и "confidence": 0.
- Никаких пояснений вне JSON.`;

const SYSTEM_TEXT = `Ты помогаешь разобрать тестовый вопрос. Отвечай кратко и по делу, на языке вопроса.
Если в тексте есть варианты ответов — назови правильный и объясни в одном предложении.`;

/* ---------- endpoints ---------- */

function normEndpoint(value) {
  let s = String(value || DEFAULTS.endpoint).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  const parts = s.match(/^([^:]+:\/\/[^/]+)(\/.*)?$/i);
  if (parts && !parts[2]) s = parts[1] + "/v1";
  return s;
}

function candidateEndpoints(configured) {
  const out = [];
  const push = (url) => {
    const v = String(url || "").replace(/\/+$/, "");
    if (v && !out.includes(v)) out.push(v);
  };

  const base = normEndpoint(configured);
  push(base);

  let url;
  try {
    url = new URL(base);
  } catch (_) {
    return out;
  }

  // облачный endpoint: локальные порты перебирать незачем
  if (!isLocalHost(url.hostname)) return out;

  const hosts = [url.hostname];
  if (url.hostname === "localhost") hosts.push("127.0.0.1");
  else if (url.hostname === "127.0.0.1") hosts.push("localhost");

  const ports = [];
  if (url.port) ports.push(url.port);
  for (const port of PORT_CANDIDATES) if (!ports.includes(String(port))) ports.push(String(port));

  for (const host of hosts) {
    for (const port of ports) {
      const candidate = new URL(url.toString());
      candidate.hostname = host;
      candidate.port = port;
      push(candidate.toString());
    }
  }

  return out;
}

async function probe(base, apiKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(base + "/models", { headers: authHeaders(apiKey), signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return { base, models: (data.data || []).map((m) => m.id) };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function discover(apiKey) {
  const cfg = await getConfig();
  const candidates = candidateEndpoints(cfg.endpoint);
  const results = await Promise.all(candidates.map((base) => probe(base, apiKey || cfg.apiKey)));
  const alive = results.filter(Boolean);
  if (!alive.length) return null;

  const withChat = alive.find((r) => r.models.some(isChatModel));
  return Object.assign({}, withChat || alive[0], { alive });
}

function isLocalHost(host) {
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(String(host || ""));
}

function isChatModel(id) {
  const s = String(id);
  // tts/image/veo/live — не чатовые модели, их нельзя звать в /chat/completions
  return !/embed|rerank|whisper|clip|tts|image|imagen|veo|lyria|aqa|live|robotics|guard/i.test(s);
}

/* Чем больше баллов — тем более подходящая модель для ответов на вопросы. */
function scoreModel(id) {
  const s = String(id);
  if (!isChatModel(s)) return -1;

  let score = 0;
  if (/flash/i.test(s)) score += 3;
  else if (/pro/i.test(s)) score += 2.5;
  else score += 1;

  if (/lite/i.test(s)) score -= 1;
  if (/preview|experimental|exp-/i.test(s)) score -= 0.5;

  const version = s.match(/(\d+(?:\.\d+)?)/);
  if (version) score += Math.min(parseFloat(version[1]), 9) / 10;

  return score;
}

/* ---------- API ---------- */

async function getConfig() {
  return chrome.storage.local.get(DEFAULTS);
}

function authHeaders(apiKey) {
  const h = { "Content-Type": "application/json" };
  if (apiKey) h.Authorization = "Bearer " + apiKey;
  return h;
}

function httpError(status, txt) {
  if (/User location is not supported/i.test(txt)) {
    return new Error(
      "Google блокирует Gemini API из этого региона (User location is not supported). " +
        "Включите VPN или выберите другого провайдера в «Подключении к модели»."
    );
  }
  if (status === 401 || status === 403) {
    return new Error(
      `Сервер не принял ключ (HTTP ${status}). Проверьте API-ключ в настройках расширения.`
    );
  }
  return new Error(`HTTP ${status}: ${String(txt || "").slice(0, 300)}`);
}

async function listModels(base, apiKey) {
  let res;
  try {
    res = await fetch(base + "/models", { headers: authHeaders(apiKey) });
  } catch (e) {
    throw new TypeError("Failed to fetch");
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw httpError(res.status, txt);
  }
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}

async function firstModel(base, apiKey) {
  const all = await listModels(base, apiKey);
  const chat = all.filter(isChatModel);

  if (!all.length) {
    throw new Error(
      "Сервер найден, но в LM Studio не загружена ни одна модель. " +
        "Откройте LM Studio → Developer → выберите чат-модель → Load, затем повторите."
    );
  }
  if (!chat.length) {
    throw new Error(
      "В LM Studio загружена только embedding-модель (" +
        all.join(", ") +
        "). Для ответов нужна чат-модель: загрузите её во вкладке Developer."
    );
  }
  // берём самую подходящую чатовую модель (не tts/imagen/veo), начиная с gemini-*
  const gemini = chat.filter((id) => /gemini/i.test(id));
  const pool = gemini.length ? gemini : chat;
  return pool.slice().sort((a, b) => scoreModel(b) - scoreModel(a))[0];
}

/* Если модель переименовали/сняли с обслуживания — пробуем найти живую сами. */
const MODEL_FALLBACKS = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash"];

/* Цепочка: основная — lite (500/день), запасные — если она упрётся в лимит. */
const MODEL_CHAIN = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash"];

const RETRYABLE_STATUS = [500, 502, 503, 504];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanModelName(value) {
  return String(value || "").trim().replace(/^models\//, "");
}

async function chatOnce(base, cfg, messages, canRetry, attempt) {
  const tryNo = attempt || 0;
  const model = cleanModelName(cfg.model) || (await firstModel(base, cfg.apiKey));

  const body = {
    model,
    messages,
    temperature: Number(cfg.temperature) || 0,
    stream: false,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: authHeaders(cfg.apiKey),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new Error(
        `Модель не ответила за ${REQUEST_TIMEOUT_MS / 1000} с. Попробуйте модель поменьше или проверьте, что она загружена.`
      );
    }
    throw new TypeError("Failed to fetch");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");

    // 503 «high demand» и прочие временные сбои — повторяем с паузой
    if (RETRYABLE_STATUS.indexOf(res.status) >= 0 && tryNo < 2) {
      await sleep(1200 * (tryNo + 1));
      return chatOnce(base, cfg, messages, canRetry, tryNo + 1);
    }

    // квота кончилась — переключаемся на модель с бóльшим дневным лимитом
    if (res.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(txt)) {
      if (canRetry !== false) {
        const alt = MODEL_CHAIN.find((m) => m !== model);
        if (alt) {
          try {
            const text = await chatOnce(base, Object.assign({}, cfg, { model: alt }), messages, false);
            await chrome.storage.local.set({ model: alt });
            return text;
          } catch (_) {
            /* запасная тоже не смогла — ниже покажем ошибку */
          }
        }
      }

      throw new Error(
        "Лимит Gemini исчерпан (RPM/RPD) для «" +
          model +
          "». Подождите минуту (если это RPM) или завтрашнего обновления квоты."
      );
    }

    // если после повторов всё ещё 5xx — пробуем запасную модель
    if (RETRYABLE_STATUS.indexOf(res.status) >= 0) {
      if (canRetry !== false) {
        const alt = MODEL_CHAIN.find((m) => cleanModelName(m) !== model);
        if (alt) {
          try {
            const text = await chatOnce(base, Object.assign({}, cfg, { model: alt }), messages, false);
            await chrome.storage.local.set({ model: alt });
            return text;
          } catch (_) {
            /* запасная тоже не ответила — покажем ошибку ниже */
          }
        }
      }

      throw new Error(
        "Модель «" +
          model +
          "» перегружена (HTTP " +
          res.status +
          "). Это временно — повторите через минуту или смените модель в настройках."
      );
    }

    const geoBlocked = /User location is not supported/i.test(txt);

    // модель не та / устарела / не умеет чат — ищем рабочую
    const modelProblem =
      !geoBlocked &&
      (res.status === 404 || res.status === 400) &&
      /model|generateContent|not supported|unsupported|invalid argument/i.test(txt);

    if (canRetry !== false && modelProblem) {
      const candidates = [];
      try {
        const all = await listModels(base, cfg.apiKey);
        const ranked = all
          .filter(isChatModel)
          .sort((a, b) => scoreModel(b) - scoreModel(a));
        for (const id of ranked) {
          const name = cleanModelName(id);
          if (name !== model && !candidates.includes(name)) candidates.push(name);
        }
      } catch (_) {
        /* /models недоступен — идём по жёсткому списку ниже */
      }
      for (const name of MODEL_FALLBACKS) {
        if (name !== model && !candidates.includes(name)) candidates.push(name);
      }

      const tried = [];
      let lastError = null;

      for (const name of candidates.slice(0, 6)) {
        tried.push(name);
        try {
          const text = await chatOnce(base, Object.assign({}, cfg, { model: name }), messages, false);
          await chrome.storage.local.set({ model: name });
          return text;
        } catch (err) {
          lastError = err;
        }
      }

      throw new Error(
        `Ни одна модель не ответила (пробовал: ${tried.join(", ")}). ` +
          `Последняя ошибка: ${(lastError && lastError.message) || "—"}. ` +
          "Откройте «Подключение к модели» → «Проверить связь» и выберите модель из списка."
      );
    }

    throw httpError(res.status, txt);
  }

  const data = await res.json();
  const message = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const content = (message.content || message.reasoning_content || "").trim();
  if (!content) throw new Error("Модель вернула пустой ответ");
  return content;
}

async function callLLM(messages) {
  const cfg = await getConfig();
  const base = normEndpoint(cfg.endpoint);

  try {
    return await chatOnce(base, cfg, messages, true);
  } catch (e) {
    if (!isNetworkError(e)) throw e;

    // сервер мог переехать на другой порт/host — поищем и повторим
    const found = await discover(cfg.apiKey);
    if (!found) {
      throw new Error(connectionHint(base));
    }

    await chrome.storage.local.set({ endpoint: found.base });
    return chatOnce(found.base, cfg, messages, true);
  }
}

function isNetworkError(e) {
  if (!e) return false;
  if (e.name === "TypeError") return true;
  return /failed to fetch|network ?error|load failed|connection refused/i.test(
    String(e.message || e)
  );
}

/* ---------- handlers ---------- */

async function solveQuestions(payload) {
  if (!Array.isArray(payload) || !payload.length) {
    return { ok: true, answers: [] };
  }

  const text = await callLLM([
    { role: "system", content: SYSTEM_SOLVE },
    { role: "user", content: "Вопросы:\n" + JSON.stringify(payload) },
  ]);

  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.answers)) {
    throw new Error("Модель вернула не JSON: " + text.slice(0, 200));
  }

  const answers = parsed.answers.map((a) => ({
    id: String(a && a.id != null ? a.id : ""),
    choices: normalizeChoices(a && a.choices),
    confidence:
      a && typeof a.confidence === "number" && isFinite(a.confidence)
        ? Math.max(0, Math.min(1, a.confidence))
        : 0.5,
    why: a && typeof a.why === "string" ? a.why.slice(0, 400) : "",
  }));

  return { ok: true, answers };
}

async function solveText(text) {
  const trimmed = String(text || "").trim();
  if (trimmed.length < 3) return { ok: false, error: "Пустой текст" };

  const answer = await callLLM([
    { role: "system", content: SYSTEM_TEXT },
    { role: "user", content: trimmed.slice(0, 6000) },
  ]);

  return { ok: true, text: answer };
}

async function ping() {
  const cfg = await getConfig();
  const base = normEndpoint(cfg.endpoint);

  const direct = await probe(base, cfg.apiKey);
  if (direct) return Object.assign({ ok: true, previous: base }, describe(direct, base));

  const found = await discover(cfg.apiKey);
  if (found) {
    await chrome.storage.local.set({ endpoint: found.base });
    return Object.assign({ ok: true, switched: true, previous: base }, describe(found, base));
  }

  return { ok: false, error: connectionHint(base) };
}

function connectionHint(base) {
  let host = "";
  try {
    host = new URL(base).hostname;
  } catch (_) {
    /* ignore */
  }

  if (host && !isLocalHost(host)) {
    return (
      "Нет связи с " +
      base +
      ". Проверьте интернет, адрес API и ключ в настройках расширения («Подключение к модели»)."
    );
  }

  return (
    "Не отвечает сервер модели (" +
    base +
    "). Откройте LM Studio → Developer → Start Server. " +
    "Если он уже запущен — проверьте адрес в настройках расширения."
  );
}

function describe(found, previous) {
  const chat = (found.models || []).filter(isChatModel);
  const message = chat.length
    ? null
    : "Сервер отвечает, но чат-модель не загружена (вижу только: " +
      ((found.models || []).join(", ") || "ничего") +
      "). LM Studio → Developer → Load model.";

  return {
    endpoint: found.base,
    previous,
    models: found.models || [],
    chatModels: chat,
    message,
  };
}

/* ---------- helpers ---------- */

function normalizeChoices(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let v of raw) {
    if (typeof v === "string") {
      const s = v.trim();
      if (/^[A-Za-z]$/.test(s)) v = s.toUpperCase().charCodeAt(0) - 65;
      else v = Number(s);
    }
    if (Number.isInteger(v) && v >= 0 && !out.includes(v)) out.push(v);
  }
  return out;
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    /* fall through */
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

function toMessage(e) {
  if (!e) return "неизвестная ошибка";
  return String(e.message || e);
}
