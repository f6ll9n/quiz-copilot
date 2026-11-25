/* Заглушка chrome.* для харнессов — чтобы content.js работал вне расширения. */
(() => {
  const qs = new URLSearchParams(location.search);
  const overrides = {
    enabled: !qs.has("off"),
    autoPick: qs.has("auto"),
    minConfidence: 0.6,
  };

  const listeners = {};
  window.__qcListeners = listeners;

  window.chrome = {
    storage: {
      local: {
        get: (defaults) => Promise.resolve(Object.assign({}, defaults, overrides)),
        set: () => Promise.resolve(),
      },
      onChanged: { addListener: () => {} },
    },
    runtime: {
      onMessage: {
        addListener: (fn) => {
          listeners.message = fn;
        },
      },
      sendMessage: (msg) =>
        new Promise((resolve) => {
          if (qs.has("fail")) {
            setTimeout(() => resolve({ ok: false, error: "мок: LM Studio не отвечает" }), 40);
            return;
          }
          if (msg.type === "solve") {
            const answers = msg.payload.map((q) => ({
              id: q.id,
              choices: q.multi ? [0, 2] : [Math.min(1, q.options.length - 1)],
              confidence: 0.82,
              why: "Мок-ответ (вариантов: " + q.options.length + ")",
            }));
            setTimeout(() => resolve({ ok: true, answers }), 50);
            return;
          }
          if (msg.type === "solveText") {
            setTimeout(() => resolve({ ok: true, text: "Мок-текстовый ответ" }), 20);
            return;
          }
          resolve({ ok: true });
        }),
    },
  };

  window.__qcScan = () =>
    listeners.message && listeners.message({ type: "scan" }, null, (r) => console.log("scan ->", r));
})();
