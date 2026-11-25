/* Quiz Copilot — content script.
   Ищет вопросы теста в DOM, отправляет их в service worker и рисует подсказки. */
(() => {
  if (window.__qcInjected) return;
  window.__qcInjected = true;

  const DEFAULTS = { enabled: false, autoPick: false, minConfidence: 0.6 };
  const CTRL = 'input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]';
  const CHUNK_SIZE = 10; // меньше запросов — больше экономии дневной квоты

  const state = Object.assign({}, DEFAULTS);

  let questions = [];
  let answers = new Map(); // id -> { choices, confidence, why }
  let badges = [];
  let picked = new Set();
  let lastSignature = "";
  let scanning = false;
  let queued = false;

  let host = null;
  let shadow = null;
  let marksEl = null;
  let tipEl = null;
  let pillEl = null;
  let cardEl = null;
  let rafPending = false;
  let domTimer = null;
  let observer = null;

  const idMap = new WeakMap();
  let idSeq = 1;

  boot();

  async function boot() {
    try {
      Object.assign(state, await chrome.storage.local.get(DEFAULTS));
    } catch (_) {
      /* storage may be unavailable on some pages */
    }

    chrome.storage.onChanged.addListener(onStorageChange);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    window.addEventListener("scroll", schedulePosition, { passive: true, capture: true });
    window.addEventListener("resize", schedulePosition, { passive: true });

    if (state.enabled) {
      startObserver();
      scheduleScan(400);
    }
  }

  /* ============================ settings ============================ */

  function onStorageChange(changes, area) {
    if (area !== "local") return;
    const wasEnabled = state.enabled;
    for (const key of Object.keys(changes)) {
      if (key in state) state[key] = changes[key].newValue;
    }
    if (!wasEnabled && state.enabled) {
      startObserver();
      scheduleScan(200);
    }
    if (wasEnabled && !state.enabled) {
      clearAll();
    }
  }

  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (!msg || !msg.type) return;

    if (msg.type === "scan") {
      runScan(true)
        .then(() => sendResponse({ ok: true, count: questions.length, hints: countHints() }))
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    if (msg.type === "clear") {
      clearAll();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "ask-selection") {
      askSelection().then(sendResponse);
      return true;
    }
    if (msg.type === "state") {
      sendResponse({ ok: true, enabled: state.enabled, count: questions.length, hints: countHints() });
      return;
    }
    if (msg.type === "diagnose") {
      sendResponse(diagnostics());
      return;
    }
  }

  /* Что именно видит расширение на странице — для разбора «ничего не найдено». */
  function diagnostics() {
    const controls = document.querySelectorAll(CTRL);
    const keys = new Set();
    let radio = 0;
    let checkbox = 0;

    for (const el of controls) {
      const kind = isCheckish(el) ? "checkbox" : "radio";
      if (kind === "checkbox") checkbox++;
      else radio++;
      const key = groupKey(el, kind);
      if (key) keys.add(key);
    }

    const found = extractQuestions();
    return {
      ok: true,
      url: location.href,
      frame: window.top === window ? "top" : "iframe",
      controls: controls.length,
      visibleControls: Array.prototype.filter.call(controls, isVisible).length,
      radio,
      checkbox,
      groups: keys.size,
      questions: found.length,
      generic: found.filter((q) => q.id.charAt(0) === "g").length,
      sample: found.slice(0, 3).map((q) => ({
        stem: q.stem.slice(0, 140),
        options: q.options.slice(0, 5),
      })),
    };
  }

  /* ============================ scanning ============================ */

  let scanTimer = null;
  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => runScan(false), delay || 800);
  }

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(() => {
      if (!state.enabled) return;
      clearTimeout(domTimer);
      domTimer = setTimeout(() => {
        if (!state.enabled) return;
        const found = extractQuestions();
        // если вопросов не нашли — тоже пересканируем: контент мог подгрузиться позже
        if (!found.length || signatureOf(found) !== lastSignature) scheduleScan(300);
      }, 900);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function runScan(force) {
    if (!state.enabled && !force) return;
    if (scanning) {
      queued = true;
      return;
    }
    scanning = true;
    let completed = false;

    try {
      const found = extractQuestions();
      const sig = signatureOf(found);

      if (!force && sig === lastSignature) return;
      lastSignature = sig;

      questions = found;
      answers = new Map();
      picked = new Set();
      clearBadges();

      if (!found.length) {
        if (force) setPill("Quiz Copilot: вопросы на странице не найдены");
        return;
      }

      // повторно за тот же вопрос не платим: берём из локального кэша
      const cache = await loadCache();
      const pending = [];
      for (const q of found) {
        const hit = cache[cacheKey(q)];
        if (hit && hit.choices && hit.choices.length) answers.set(q.id, hit);
        else pending.push(q);
      }

      if (answers.size) {
        paint();
        updatePill();
      }

      if (!pending.length) {
        completed = true;
        return;
      }

      setPill(`Quiz Copilot: ${found.length} вопр. · думаю…`, "busy");

      for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
        const chunk = pending.slice(i, i + CHUNK_SIZE);
        let resp;
        try {
          resp = await chrome.runtime.sendMessage({
            type: "solve",
            payload: chunk.map((q) => ({
              id: q.id,
              question: q.stem,
              options: q.options,
              multi: q.multi,
            })),
          });
        } catch (e) {
          throw new Error(
            "Расширение обновилось — перезагрузите страницу (F5). " + ((e && e.message) || "")
          );
        }

        if (!resp) throw new Error("Фоновый скрипт не ответил");
        if (!resp.ok) throw new Error(resp.error || "ошибка запроса");

        const fresh = {};
        for (const a of resp.answers || []) {
          answers.set(a.id, a);
          const source = chunk.find((x) => x.id === a.id);
          if (source && a.choices && a.choices.length) {
            fresh[cacheKey(source)] = {
              choices: a.choices,
              confidence: a.confidence,
              why: a.why,
            };
          }
        }
        await saveCache(fresh);

        paint();
        updatePill();
      }

      if (state.enabled && state.autoPick) autoPick();
      completed = true;
    } catch (e) {
      setPill("Quiz Copilot: " + shortError(e), "error");
    } finally {
      scanning = false;
      if (completed && questions.length) updatePill();
      if (queued) {
        queued = false;
        scheduleScan(1500);
      }
    }
  }

  /* ---------- кэш ответов (экономит дневную квоту) ---------- */

  function cacheKey(q) {
    return (q.stem + "||" + q.options.join("|")).slice(0, 500);
  }

  async function loadCache() {
    try {
      const stored = await chrome.storage.local.get({ qcCache: {} });
      return stored.qcCache || {};
    } catch (_) {
      return {};
    }
  }

  async function saveCache(patch) {
    if (!Object.keys(patch).length) return;
    try {
      const stored = await chrome.storage.local.get({ qcCache: {} });
      const next = Object.assign({}, stored.qcCache || {}, patch);
      const keys = Object.keys(next);
      if (keys.length > 400) {
        for (const key of keys.slice(0, keys.length - 400)) delete next[key];
      }
      await chrome.storage.local.set({ qcCache: next });
    } catch (_) {
      /* ignore */
    }
  }

  function countHints() {
    let n = 0;
    for (const a of answers.values()) n += (a.choices || []).length;
    return n;
  }

  function signatureOf(list) {
    return list.map((q) => q.stem + "||" + q.options.join("|")).join("###");
  }

  /* ============================ extraction ============================ */

  function extractQuestions() {
    const groups = new Map();

    for (const el of document.querySelectorAll(CTRL)) {
      if (el.disabled) continue;
      const kind = isCheckish(el) ? "checkbox" : "radio";
      const key = groupKey(el, kind);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(el);
    }

    const out = [];
    let n = 1;

    for (const elements of groups.values()) {
      if (elements.length < 2) continue;

      const rows = [];
      const seen = new Set();
      for (const el of elements) {
        const row = rowFor(el);
        if (!row || seen.has(row)) continue;
        seen.add(row);
        rows.push(row);
      }
      if (rows.length < 2) continue;

      // сам input может быть скрыт кастомным CSS — ориентируемся на видимость строки
      const visibleRows = rows.filter(isVisible);
      if (visibleRows.length < 2) continue;

      const labels = visibleRows.map(labelOf);
      if (labels.filter((l) => l.length > 0).length < 2) continue;

      const container = containerFor(visibleRows);
      const stem = stemFrom(container, labels);

      out.push({
        id: "q" + n++,
        stem,
        options: labels.map((l, i) => l || "вариант " + (i + 1)),
        multi: elements.some(isCheckish),
        rows: visibleRows,
      });
    }

    // ни одного input на странице — пробуем найти кликабельные варианты (кастомные виджеты)
    if (!out.length) {
      for (const q of extractGenericQuestions()) out.push(q);
    }

    // схлопываем дубликаты (иногда один и тот же блок ловится дважды)
    const unique = [];
    const sigs = new Set();
    for (const q of out) {
      const s = q.stem + "|" + q.options.join("|");
      if (sigs.has(s)) continue;
      sigs.add(s);
      unique.push(q);
    }
    return unique;
  }

  function isCheckish(el) {
    const t = String(el.getAttribute("type") || el.getAttribute("role") || "").toLowerCase();
    return t === "checkbox";
  }

  function groupKey(el, kind) {
    const name = el.getAttribute("name");
    if (name) return kind + "|name|" + name;

    const group = el.closest('[role="radiogroup"],[role="group"],[role="listbox"]');
    if (group) return kind + "|aria|" + stableId(group);

    let p = el.parentElement;
    for (let i = 0; i < 4 && p && p !== document.body; i++) {
      if (p.querySelectorAll(CTRL).length >= 2) return kind + "|dom|" + stableId(p);
      p = p.parentElement;
    }
    return null;
  }

  function stableId(el) {
    if (!idMap.has(el)) idMap.set(el, idSeq++);
    return idMap.get(el);
  }

  function rowFor(el) {
    // обёртка <label><input>…</label> — самый надёжный вариант, но только если в ней есть текст
    const wrap = el.closest("label");
    if (wrap && textOf(wrap).trim().length > 1) return wrap;

    const id = el.getAttribute("id");
    if (id && window.CSS && CSS.escape) {
      const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lab) return lab;
    }
    if (wrap) return wrap;

    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++) {
      if (p.querySelectorAll(CTRL).length > 1) break;
      const text = textOf(p).trim();
      if (text.length > 1) return p;
      p = p.parentElement;
    }
    return el.closest("div,li,td,span") || el;
  }

  function labelOf(row) {
    let text = textOf(row).replace(/\s+/g, " ").trim();
    if (!text && row.getAttribute) text = (row.getAttribute("aria-label") || "").trim();
    return text.slice(0, 400);
  }

  /* Резервный путь: варианты — не input, а кликабельные div/li/button.
     Включается только если на странице вообще нет radio/checkbox. */
  const OPTION_HINT =
    "[role='radio'],[role='checkbox'],[role='option'],[role='button'],button," +
    '[class*="option"],[class*="answer"],[class*="variant"],[class*="choice"]';

  function extractGenericQuestions() {
    const out = [];
    const usedParents = new Set();

    for (const el of document.querySelectorAll(OPTION_HINT)) {
      if (!el.isConnected) continue;
      if (
        el.closest(
          "nav,header,footer,[role='navigation'],[role='menu'],[role='menubar'],[role='tablist']"
        )
      )
        continue;

      const parent = el.parentElement;
      if (!parent || usedParents.has(parent)) continue;

      // соседи того же тега с теми же классами = варианты одного вопроса
      const siblings = Array.prototype.filter.call(
        parent.children,
        (c) =>
          c.tagName === el.tagName &&
          typeof c.className === "string" &&
          c.className === el.className &&
          !c.querySelector("input,textarea,select")
      );

      if (siblings.length < 2 || siblings.length > 10) continue;
      if (!siblings.every(isVisible)) continue;
      if (!siblings.every(looksClickable)) continue;

      const texts = siblings.map((s) => textOf(s).replace(/\s+/g, " ").trim());
      if (texts.some((t) => t.length < 1 || t.length > 220)) continue;

      usedParents.add(parent);

      const container = containerFor(siblings);
      const stem = stemFrom(container, texts);
      if (stem.length < 4) continue;

      out.push({
        id: "g" + (out.length + 1),
        stem,
        options: texts,
        multi: false,
        rows: siblings,
      });
    }

    return out;
  }

  function looksClickable(el) {
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (["radio", "checkbox", "option", "button", "tab"].includes(role)) return true;
    if (["BUTTON", "A", "LI", "LABEL"].includes(el.tagName)) return true;
    return getComputedStyle(el).cursor === "pointer";
  }

  function containerFor(rows) {
    let container = lca(rows);
    if (!container) return document.body;

    const optionsLength = rows.reduce((sum, r) => sum + textOf(r).trim().length, 0);
    for (let i = 0; i < 3; i++) {
      if (textOf(container).trim().length > optionsLength + 6) break;
      if (!container.parentElement) break;
      container = container.parentElement;
    }
    return container;
  }

  function stemFrom(container, labels) {
    let raw = textOf(container);
    const first = labels.find((l) => l && l.length > 1);

    if (first) {
      const idx = raw.indexOf(first);
      if (idx > 0) raw = raw.slice(0, idx);
    }

    raw = raw.replace(/\s+/g, " ").trim();

    if (raw.length < 4 && container) {
      const prev = container.previousElementSibling;
      const alt = prev ? textOf(prev).replace(/\s+/g, " ").trim() : "";
      if (alt.length > 3) raw = alt.slice(-600);
    }

    if (raw.length > 1000) raw = "…" + raw.slice(-1000);
    return raw;
  }

  function lca(nodes) {
    if (!nodes.length) return null;
    let node = nodes[0];
    while (node && !nodes.every((n) => node === n || node.contains(n))) {
      node = node.parentElement;
    }
    return node || document.body;
  }

  function textOf(el) {
    if (!el) return "";
    if (el.innerText != null) return el.innerText;
    return el.textContent || "";
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  /* ============================ overlay ============================ */

  const OVERLAY_CSS = `
    :host { all: initial; }
    .marks { position: absolute; inset: 0; }
    .mark {
      position: absolute; width: 20px; height: 20px; border-radius: 50%;
      border: 0; padding: 0; margin: 0; cursor: pointer;
      background: #10b981; color: #052e22; font: 700 12px/1 -apple-system, "Segoe UI", Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 2px 8px rgba(0,0,0,.35), 0 0 0 2px rgba(255,255,255,.7);
      pointer-events: auto; opacity: .95;
      transition: transform .12s ease, opacity .12s ease;
    }
    .mark:hover { transform: scale(1.18); opacity: 1; }
    .mark.unsure { background: #f59e0b; color: #2b1a00; }
    .tip {
      position: absolute; max-width: 300px; background: #0b1220; color: #e5e7eb;
      border: 1px solid #1f2937; border-radius: 10px; padding: 8px 10px;
      font: 400 12px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 10px 30px rgba(0,0,0,.45); pointer-events: none;
    }
    .tip b { display: block; color: #fff; margin-bottom: 2px; }
    .tip .conf { display: block; color: #94a3b8; font-size: 11px; }
    .tip p { margin: 6px 0 0; color: #cbd5e1; }
    .pill {
      position: fixed; right: 12px; bottom: 12px; max-width: min(520px, 70vw);
      background: rgba(11,18,32,.94); color: #e5e7eb; border: 1px solid #1f2937;
      border-radius: 12px; padding: 7px 12px; text-align: left;
      font: 500 12px/1.2 -apple-system, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,.4); pointer-events: none;
    }
    .pill[data-kind="error"] { color: #fca5a5; border-color: #7f1d1d; }
    .card {
      position: fixed; right: 12px; top: 12px; width: 340px; max-height: 62vh; overflow: auto;
      background: #0b1220; color: #e5e7eb; border: 1px solid #1f2937; border-radius: 14px;
      padding: 12px 14px 14px;
      font: 400 13px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 20px 50px rgba(0,0,0,.5); pointer-events: auto;
    }
    .card h4 { margin: 0 0 6px; font-size: 12px; color: #6ee7b7; letter-spacing: .04em; text-transform: uppercase; }
    .card pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
    .card button {
      position: absolute; top: 6px; right: 8px; background: none; border: 0; color: #94a3b8;
      font-size: 18px; line-height: 1; cursor: pointer; padding: 4px;
    }
    .card button:hover { color: #fff; }
  `;

  function ensureOverlay() {
    if (shadow) return shadow;

    host = document.createElement("div");
    host.id = "__quiz_copilot_overlay";
    host.style.cssText =
      "all:initial;position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483646;pointer-events:none;";

    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      "<style>" +
      OVERLAY_CSS +
      '</style><div class="marks"></div><div class="tip" hidden></div><div class="pill" hidden></div>';

    marksEl = shadow.querySelector(".marks");
    tipEl = shadow.querySelector(".tip");
    pillEl = shadow.querySelector(".pill");

    (document.documentElement || document.body).appendChild(host);
    return shadow;
  }

  function paint() {
    ensureOverlay();
    clearBadges();

    for (const q of questions) {
      const a = answers.get(q.id);
      if (!a || !a.choices || !a.choices.length) continue;

      const sure = (a.confidence == null ? 0.5 : a.confidence) >= state.minConfidence;
      for (const idx of a.choices) {
        const row = q.rows[idx];
        if (!row) continue;
        badges.push(makeBadge(q, idx, a, sure));
      }
    }

    positionBadges();
  }

  function makeBadge(question, index, answer, sure) {
    const el = document.createElement("button");
    el.className = "mark" + (sure ? "" : " unsure");
    el.textContent = sure ? "✓" : "?";
    el.type = "button";

    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectRow(question, index);
    });
    el.addEventListener("mouseenter", () => showTip(el, question, index, answer));
    el.addEventListener("mouseleave", hideTip);

    marksEl.appendChild(el);
    return { el, row: question.rows[index], question, index, answer };
  }

  function positionBadges() {
    if (!shadow) return;
    for (const badge of badges) {
      const rect = badge.row.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        badge.el.style.display = "none";
        continue;
      }
      badge.el.style.display = "";
      const size = 20;
      const top = rect.top + Math.min(rect.height, 40) / 2 - size / 2;
      badge.el.style.left = Math.max(4, rect.left - size - 6) + "px";
      badge.el.style.top = top + "px";
    }
  }

  function schedulePosition() {
    if (rafPending || !badges.length) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      positionBadges();
    });
  }

  function showTip(badgeEl, question, index, answer) {
    if (!tipEl) return;
    const pct = Math.round((answer.confidence == null ? 0.5 : answer.confidence) * 100);
    tipEl.innerHTML =
      "<b>" +
      escapeHtml(question.options[index] || "") +
      '</b><span class="conf">уверенность ' +
      pct +
      "%</span>" +
      (answer.why ? "<p>" + escapeHtml(answer.why) + "</p>" : "");
    tipEl.hidden = false;

    const r = badgeEl.getBoundingClientRect();
    const width = 300;
    tipEl.style.left = Math.max(8, Math.min(window.innerWidth - width - 12, r.left + 26)) + "px";
    tipEl.style.top = Math.min(window.innerHeight - 140, r.top + 26) + "px";
  }

  function hideTip() {
    if (tipEl) tipEl.hidden = true;
  }

  function clearBadges() {
    if (marksEl) marksEl.textContent = "";
    badges = [];
    hideTip();
  }

  function clearAll() {
    clearBadges();
    questions = [];
    answers = new Map();
    picked = new Set();
    lastSignature = "";
    if (pillEl) pillEl.hidden = true;
    if (cardEl) {
      cardEl.remove();
      cardEl = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function setPill(text, kind) {
    ensureOverlay();
    pillEl.textContent = text;
    pillEl.dataset.kind = kind || "";
    pillEl.hidden = false;
  }

  function updatePill() {
    const hints = countHints();
    const solved = questions.filter((q) => answers.has(q.id)).length;
    setPill(
      scanning
        ? `Quiz Copilot: решаю ${solved}/${questions.length} · подсказок ${hints}`
        : `Quiz Copilot: вопросов ${questions.length} · подсказок ${hints}`
    );
  }

  /* ============================ actions ============================ */

  function selectRow(question, index) {
    const row = question.rows[index];
    if (!row) return;

    const control =
      row.matches && row.matches(CTRL)
        ? row
        : row.querySelector(CTRL);

    if (control) {
      control.focus({ preventScroll: true });
      if ("checked" in control && control.checked) return;
      control.click();
    } else {
      row.click();
    }
  }

  function autoPick() {
    for (const q of questions) {
      if (picked.has(q.id)) continue;
      const a = answers.get(q.id);
      if (!a || !a.choices || !a.choices.length) continue;
      if ((a.confidence == null ? 0.5 : a.confidence) < state.minConfidence) continue;

      picked.add(q.id);
      for (const idx of a.choices) selectRow(q, idx);
    }
  }

  async function askSelection() {
    const selected = (window.getSelection() ? window.getSelection().toString() : "" ).trim();
    if (selected.length < 3) {
      return { ok: false, error: "Сначала выделите текст вопроса на странице" };
    }

    setPill("Quiz Copilot: спрашиваю модель…", "busy");
    try {
      const resp = await chrome.runtime.sendMessage({ type: "solveText", text: selected });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || "нет ответа");
      showCard(resp.text);
      if (pillEl) pillEl.hidden = true;
      return { ok: true };
    } catch (e) {
      const error = shortError(e);
      setPill("Quiz Copilot: " + error, "error");
      return { ok: false, error };
    }
  }

  function showCard(text) {
    ensureOverlay();
    if (cardEl) cardEl.remove();

    cardEl = document.createElement("div");
    cardEl.className = "card";
    cardEl.innerHTML =
      "<h4>Ответ модели</h4><button title=\"Закрыть\">×</button><pre></pre>";
    cardEl.querySelector("pre").textContent = text;
    cardEl.querySelector("button").addEventListener("click", () => {
      cardEl.remove();
      cardEl = null;
    });
    shadow.appendChild(cardEl);
  }

  /* ============================ utils ============================ */

  function shortError(e) {
    const msg = String((e && e.message) || e || "ошибка");
    return msg.length > 160 ? msg.slice(0, 160) + "…" : msg;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // доступно из popup через chrome.scripting.executeScript (тот же isolated world)
  try {
    window.__qcReport = diagnostics;
  } catch (_) {
    /* ignore */
  }
})();
