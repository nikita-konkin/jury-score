/* conf-kit · shared/feedback.js
 *
 * Обратная связь от чат-ботов и людей: проверка сообщения, вырезание контактов
 * и сравнение для группировки похожих сообщений. Как и model.js, работает в Node
 * и в goja (pb_hooks), поэтому синтаксис — ES2015.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ConfFeedback = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const KINDS = ["missing_feature", "schema_limitation", "bug", "unclear_docs", "validation_false_positive"];
  const AREAS = ["schema", "validate", "events", "invite", "documents", "jury", "mcp", "ui", "other"];
  const IMPACTS = ["blocker", "degraded", "nice_to_have"];
  const SOURCES = ["mcp", "api", "paste", "auto", "ui"];
  const LIMITS = { summary: 300, details: 5000, workaround: 2000, client: 200, model: 200 };

  const KIND_ALIASES = {
    "missing_feature": "missing_feature", "feature": "missing_feature", "feature_request": "missing_feature", "не хватает функции": "missing_feature",
    "schema_limitation": "schema_limitation", "schema": "schema_limitation", "ограничение схемы": "schema_limitation",
    "bug": "bug", "error": "bug", "ошибка": "bug",
    "unclear_docs": "unclear_docs", "docs": "unclear_docs", "документация": "unclear_docs",
    "validation_false_positive": "validation_false_positive", "false_positive": "validation_false_positive", "ложное срабатывание": "validation_false_positive",
  };
  const STOP = ["и", "в", "во", "на", "для", "не", "нет", "по", "с", "со", "к", "ко", "о", "об", "а", "что", "как", "это", "или", "из", "у", "при", "же", "бы", "ли",
    "the", "a", "an", "of", "to", "in", "for", "is", "are", "no", "not", "and", "or", "with", "on", "by", "be"];

  const clean = s => (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);

  /** Вырезает e-mail и телефоны: обратная связь не должна содержать ПДн участников. */
  function scrub(s) {
    if (s == null) return "";
    return String(s)
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[e-mail]")
      .replace(/(?:\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g, "[телефон]")
      .replace(/\+\d[\d\s()-]{8,}\d/g, "[телефон]");
  }

  function cut(s, max) { return s.length > max ? s.slice(0, max - 1) + "…" : s; }

  /** Основы слов для сравнения: нижний регистр, без стоп-слов, первые 5 букв. */
  function signature(text) {
    const words = clean(text).toLowerCase().replace(/ё/g, "е").split(/[^a-zа-я0-9_]+/);
    const out = {};
    words.forEach(w => {
      if (w.length < 2 || STOP.indexOf(w) >= 0) return;
      out[w.slice(0, 5)] = true;
    });
    return Object.keys(out).sort();
  }

  /** Сходство двух сигнатур (коэффициент Жаккара, 0…1). */
  function similarity(a, b) {
    if (!a.length && !b.length) return 1;
    const set = {};
    a.forEach(x => { set[x] = 1; });
    let inter = 0;
    b.forEach(x => { if (set[x] === 1) { inter++; set[x] = 2; } });
    const union = a.length + b.length - inter;
    return union ? inter / union : 0;
  }

  /** Лучшая группа среди кандидатов того же kind и area; null, если похожих нет. */
  function bestGroup(sig, groups, threshold) {
    let best = null, score = threshold == null ? 0.5 : threshold;
    groups.forEach(g => {
      const s = similarity(sig, g.signature || []);
      if (s >= score) { best = g; score = s; }
    });
    return best;
  }

  /**
   * Проверяет и нормализует сообщение. Возвращает { item, errors }.
   * Контакты вырезаются, длинные поля обрезаются, неизвестная область → other.
   */
  function normalizeFeedback(input) {
    const errors = [];
    if (!isObj(input)) return { item: null, errors: ["Ожидается JSON-объект { kind, area, summary, details, … }"] };
    const kind = KIND_ALIASES[clean(input.kind).toLowerCase()];
    if (!kind) errors.push(`kind: одно из ${KINDS.join(", ")}`);
    let area = clean(input.area).toLowerCase();
    const context = isObj(input.context) ? JSON.parse(scrub(JSON.stringify(input.context))) : {};
    if (AREAS.indexOf(area) < 0) {
      if (area) context.area_original = cut(scrub(area), 100);
      area = "other";
    }
    const summary = cut(clean(scrub(input.summary)), LIMITS.summary);
    if (!summary) errors.push("summary: одна строка — чего не хватило или что пошло не так");
    let details = input.details;
    if (isObj(details) || Array.isArray(details)) details = JSON.stringify(details, null, 1);
    let impact = clean(input.impact).toLowerCase();
    if (impact && IMPACTS.indexOf(impact) < 0) impact = "";
    const item = {
      kind: kind || "",
      area: area,
      summary: summary,
      details: cut(scrub(details == null ? "" : String(details)).trim(), LIMITS.details),
      workaround: cut(clean(scrub(input.workaround)), LIMITS.workaround),
      impact: impact,
      context: context,
      client: cut(clean(input.client), LIMITS.client),
      model: cut(clean(input.model), LIMITS.model),
    };
    return { item: errors.length ? null : item, errors: errors };
  }

  /** Автоматическое сообщение по предупреждениям EXTRA_USED: каких полей не хватает в схеме. */
  function fromExtraWarnings(report) {
    const out = [];
    const seen = {};
    (report && report.warnings || []).forEach(w => {
      if (w.code !== "EXTRA_USED" || !w.fields) return;
      // путь без индексов: days[0].sessions[1].items[3].extra → items
      const level = w.path.replace(/\[\d+\]/g, "").replace(/\.extra$/, "").split(".").pop() || "event";
      w.fields.forEach(f => {
        const k = level + ":" + f;
        if (seen[k]) return;
        seen[k] = true;
        out.push({
          kind: "schema_limitation",
          area: "schema",
          summary: `Нет поля «${f}» у ${level} — данные сохранены в extra`,
          details: `Пример пути: ${w.path}`,
          workaround: "extra",
          impact: "nice_to_have",
          context: { level: level, field: f },
        });
      });
    });
    return out;
  }

  return {
    KINDS: KINDS, AREAS: AREAS, IMPACTS: IMPACTS, SOURCES: SOURCES, LIMITS: LIMITS,
    scrub: scrub, signature: signature, similarity: similarity, bestGroup: bestGroup,
    normalizeFeedback: normalizeFeedback, fromExtraWarnings: fromExtraWarnings,
  };
});
