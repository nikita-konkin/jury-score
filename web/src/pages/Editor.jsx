// Конструктор программы. Телефон: мероприятие → день → заседание → элементы, правка в нижних листах.
// Десктоп (от 900 px): дерево дней и заседаний слева, листы — боковой панелью, перетаскивание мышью,
// горячие клавиши и предпросмотр печатной программы справа.
// Правка идёт в копии документа; проверка и время считаются тут же (ConfModel.normalize),
// «Сохранить» отправляет документ целиком с base_version. Несохранённое лежит в localStorage.
import { useState, useEffect, useRef } from "preact/hooks";
import M from "../../../shared/model.js";
import { api, errorText } from "../api.js";
import { useWide, useHtmlClass } from "../hooks.js";
import { dayLabel, dateRange, plural } from "../util.js";
import { issueIndex, shiftItem, moveItem, peopleOf, roomsOf } from "../edit/ops.js";
import { ProgramDoc } from "../print/Print.jsx";
import { renderSheet, TYPES } from "../edit/sheets.jsx";
import { Issues, Datalist } from "../edit/ui.jsx";

const DRAFT = id => "conf_edit_" + id;
const TYPE_SHORT = {};
TYPES.forEach(([v, l]) => { TYPE_SHORT[v] = l; });

function readDraft(id) {
  try { return JSON.parse(localStorage.getItem(DRAFT(id)) || "null"); } catch (e) { return null; }
}
function writeDraft(id, d) {
  try {
    if (d) localStorage.setItem(DRAFT(id), JSON.stringify(d)); else localStorage.removeItem(DRAFT(id));
  } catch (e) { /* нет места или приватный режим — правка живёт до перезагрузки */ }
}

let pendingFocus = null; // элемент, к которому прокрутить после перехода из списка проверок

export function Editor({ id, sub, toast }) {
  const [st, setSt] = useState(null); // { event, base, doc, report, dirty, past, note }
  const [loadErr, setLoadErr] = useState("");
  const [stale, setStale] = useState(null); // черновик от старой версии
  const [conflict, setConflict] = useState(0);
  const [saving, setSaving] = useState(false);
  const [order, setOrder] = useState(false);
  const [sheet, setSheet] = useState(null);
  const sheetRef = useRef(null);
  const wide = useWide();
  useHtmlClass("page-wide", wide);
  const [preview, setPreview] = useState(() => readPref("conf_ed_preview"));
  const dragRef = useRef(null); // перетаскиваемый элемент { di, si, ii }
  const [dropAt, setDropAt] = useState("");
  const keys = useRef({});

  async function load(dropDraft) {
    setLoadErr("");
    const r = await api("GET", `/api/v1/events/${encodeURIComponent(id)}/program`).catch(e => ({ status: 0, json: { message: e.message } }));
    if (r.status !== 200) return setLoadErr(r.status === 404 ? "Мероприятие не найдено или нет доступа" : errorText(r));
    const ev = r.json.event;
    const res = M.normalize(r.json.program);
    let next = { event: ev, base: ev.version, doc: res.doc, report: res.report, dirty: false, past: [], note: "" };
    const draft = dropDraft ? null : readDraft(ev.id);
    if (dropDraft) writeDraft(ev.id, null);
    if (draft && draft.base === ev.version) {
      const d = M.normalize(draft.doc);
      next = Object.assign(next, { doc: d.doc, report: d.report, dirty: true, note: draft.note || "" });
      toast("Восстановлены несохранённые изменения");
    } else if (draft) setStale(draft);
    setConflict(0);
    setSt(next);
  }
  useEffect(() => { load(); }, [id]);

  // предупреждение при закрытии вкладки (черновик пишется сразу в commit)
  useEffect(() => {
    if (!st || !st.dirty) return undefined;
    const warn = e => { e.preventDefault(); e.returnValue = ""; return ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [st && st.dirty]);

  // «Назад» на телефоне закрывает лист, а не уходит со страницы
  useEffect(() => {
    const on = () => { if (sheetRef.current) { sheetRef.current = null; setSheet(null); } };
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  useEffect(() => {
    const cls = document.documentElement.classList;
    if (sheet) cls.add("noscroll"); else cls.remove("noscroll");
    return () => cls.remove("noscroll");
  }, [!!sheet]);

  const base = "/edit/" + id;
  const p = parseSub(sub);
  const bar = st && (st.dirty || conflict);
  useEffect(() => {
    const cls = document.documentElement.classList;
    if (bar) cls.add("has-bar"); else cls.remove("has-bar");
    return () => cls.remove("has-bar");
  }, [!!bar]);

  // горячие клавиши: Ctrl+S, Ctrl+Z (вне полей ввода), Esc, Alt+↑/↓ — элемент в фокусе выше или ниже
  useEffect(() => {
    const on = e => {
      const k = keys.current;
      const key = String(e.key || "").toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const field = /^(input|textarea|select)$/i.test((e.target && e.target.tagName) || "");
      if (mod && !e.altKey && (key === "s" || key === "ы")) { e.preventDefault(); if (k.save) k.save(); }
      else if (mod && !e.shiftKey && (key === "z" || key === "я") && !field) { e.preventDefault(); if (k.undo) k.undo(); }
      else if (key === "escape" && sheetRef.current) { e.preventDefault(); if (k.close) k.close(); }
      else if (e.altKey && !mod && (key === "arrowup" || key === "arrowdown") && !field && k.shift) {
        if (k.shift(key === "arrowup" ? -1 : 1)) e.preventDefault();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // прокрутка к элементу после перехода из проверки
  useEffect(() => {
    if (pendingFocus == null) return;
    const el = document.getElementById("ed-it-" + pendingFocus);
    pendingFocus = null;
    if (el) { el.scrollIntoView(); el.className += " flash"; }
  });

  if (loadErr) return <div class="card msg"><p>{loadErr}</p><button class="btn wide" onClick={() => load()}>Повторить</button><a class="btn wide" href="#/">К списку</a></div>;
  if (!st) return <p class="muted center">Загрузка…</p>;

  const doc = st.doc;
  const idx = issueIndex(st.report);

  // черновик пишется сразу, а не в эффекте: правка не теряется, даже если вкладку закрыли мгновенно
  function change(next) {
    writeDraft(next.event.id, { base: next.base, doc: next.doc, note: next.note, at: Date.now() });
    setSt(next);
  }
  function commit(input, note) {
    const r = M.normalize(input);
    change(Object.assign({}, st, { doc: r.doc, report: r.report, dirty: true, past: st.past.concat([st.doc]).slice(-30), note: note || st.note }));
  }
  function undo() {
    if (!st.past.length) return;
    const prev = st.past[st.past.length - 1];
    const r = M.normalize(prev);
    change(Object.assign({}, st, { doc: r.doc, report: r.report, dirty: true, past: st.past.slice(0, -1) }));
  }
  function open(s) {
    if (!sheetRef.current) { try { history.pushState({ sheet: 1 }, ""); } catch (e) { /* без истории лист закрывается кнопкой */ } }
    sheetRef.current = s;
    setSheet(s);
  }
  function close() {
    if (!sheetRef.current) return;
    sheetRef.current = null;
    setSheet(null);
    if (history.state && history.state.sheet) history.back();
  }
  /** Переход внутри конструктора из листа: запись листа в истории заменяется новым адресом. */
  function goTo(path, focus) {
    const hadSheet = !!sheetRef.current;
    if (focus != null) pendingFocus = focus;
    const target = "#" + base + path;
    if (location.hash === target) return close();
    sheetRef.current = null;
    setSheet(null);
    if (hadSheet && history.state && history.state.sheet) location.replace(target);
    else if (location.hash !== target) location.hash = target;
  }
  async function save(force) {
    setSaving(true);
    try {
      const body = { program: doc, base_version: force ? conflict : st.base };
      if (st.note) body.note = st.note;
      const r = await api("PUT", `/api/v1/events/${st.event.id}/program`, body);
      if (r.status === 200) {
        writeDraft(st.event.id, null);
        setConflict(0);
        setSt(Object.assign({}, st, { event: r.json.event, base: r.json.event.version, dirty: false, note: "" }));
        toast(`Сохранено — версия ${r.json.event.version}`);
      } else if (r.status === 409) {
        setConflict(r.json.version || 0);
      } else if (r.status === 422 && r.json.report) {
        setSt(Object.assign({}, st, { report: r.json.report }));
        toast("Сервер нашёл ошибки — программа не сохранена");
      } else toast(errorText(r));
    } catch (e) { toast(e.message); } finally { setSaving(false); }
  }

  // перетаскивание мышью на десктопе: порядок в заседании и перенос в другое заседание через дерево слева
  const dnd = wide ? {
    start(e, from) {
      dragRef.current = from;
      try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "item"); } catch (x) { /* Firefox требует setData */ }
    },
    end() { dragRef.current = null; setDropAt(""); },
    overItem(e, di, si, ii) {
      if (!dragRef.current) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      const at = [di, si, ii, e.clientY > r.top + r.height / 2 ? "a" : "b"].join(":");
      if (at !== dropAt) setDropAt(at);
    },
    dropItem(e, di, si, ii) {
      e.preventDefault();
      const from = dragRef.current;
      dragRef.current = null;
      setDropAt("");
      if (!from) return;
      const r = e.currentTarget.getBoundingClientRect();
      let to = ii + (e.clientY > r.top + r.height / 2 ? 1 : 0);
      const same = from.di === di && from.si === si;
      if (same && from.ii < to) to--;
      if (same && from.ii === to) return;
      commit(moveItem(doc, from, { di, si, ii: to }));
    },
    overSession(e, di, si) {
      if (!dragRef.current) return;
      e.preventDefault();
      if (dropAt !== di + ":" + si) setDropAt(di + ":" + si);
    },
    dropSession(e, di, si) {
      e.preventDefault();
      const from = dragRef.current;
      dragRef.current = null;
      setDropAt("");
      if (!from || (from.di === di && from.si === si)) return;
      commit(moveItem(doc, from, { di, si }));
      toast("Перенесено: " + (doc.days[di].sessions[si].title || "заседание") + ", " + dayLabel(doc.days[di].date));
    },
    mark(di, si, ii) {
      const k = di + ":" + si + ":" + ii;
      return dropAt === k + ":b" ? " drop-before" : dropAt === k + ":a" ? " drop-after" : "";
    },
    over: dropAt,
  } : null;

  keys.current = {
    save() {
      if (sheetRef.current) return toast("Сначала нажмите «Готово» или закройте лист");
      if (!st.dirty) return toast("Изменений нет");
      if (st.report.errors.length) return open({ kind: "checks" });
      if (!saving) save(false);
    },
    undo, close,
    shift(dir) {
      const li = document.activeElement && document.activeElement.closest ? document.activeElement.closest("li.ed-it") : null;
      if (!li || p.si == null) return false;
      const ii = +li.id.replace("ed-it-", "");
      const n = doc.days[p.di].sessions[p.si].items.length;
      if (ii + dir < 0 || ii + dir >= n) return true;
      commit(shiftItem(doc, p.di, p.si, ii, dir));
      setTimeout(() => { const b = document.querySelector("#ed-it-" + (ii + dir) + " .ed-open"); if (b) b.focus(); }, 0);
      return true;
    },
  };
  const togglePreview = () => { const v = !preview; setPreview(v); writePref("conf_ed_preview", v); };

  const ctx = { doc, report: st.report, idx, commit, close, open, goTo, toast, base: st.base, eventId: st.event.id, dnd };
  const errors = st.report.errors.length;
  let body;
  if (p.si != null && doc.days[p.di] && doc.days[p.di].sessions[p.si]) body = <SessionLevel ctx={ctx} di={p.di} si={p.si} order={order} setOrder={setOrder} base={base} />;
  else if (p.di != null && doc.days[p.di]) body = <DayLevel ctx={ctx} di={p.di} base={base} />;
  else body = <EventLevel ctx={ctx} st={st} />;

  return (
    <div class={"editor" + (wide ? " desk" + (preview ? " with-preview" : "") : "")}>
      {wide ? <Tree ctx={ctx} p={p} base={base} preview={preview} togglePreview={togglePreview} /> : null}
      <div class="ed-main">
      {stale ? (
        <div class="pill warn">
          Есть несохранённые правки к версии {stale.base}, а сейчас версия {st.base}.
          <div class="actions">
            <button class="btn" onClick={() => { commit(stale.doc, stale.note); setStale(null); }}>Открыть мои правки</button>
            <button class="btn" onClick={() => { writeDraft(st.event.id, null); setStale(null); }}>Удалить их</button>
          </div>
        </div>
      ) : null}
      {body}
      </div>
      {wide && preview ? <PrintPreview doc={doc} id={st.event.id} /> : null}
      <Datalist id="people" values={peopleOf(doc)} />
      <Datalist id="rooms" values={roomsOf(doc)} />
      {bar ? (
        <div class="savebar glass">
          {conflict ? (
            <div class="savebar-msg">
              Программу изменили в другом месте (версия {conflict}).
              <div class="actions">
                <button class="btn" onClick={() => { if (window.confirm("Отменить свои правки и загрузить свежую версию?")) load(true); }}>Загрузить свежую</button>
                <button class="btn" disabled={saving} onClick={() => save(true)}>Сохранить поверх</button>
              </div>
            </div>
          ) : (
            <div class="savebar-row">
              <button class="btn icon" aria-label="Отменить последнее действие" disabled={!st.past.length} onClick={undo}>↶</button>
              {errors ? (
                <button class="btn grow err-btn" onClick={() => open({ kind: "checks" })}>Ошибок: {errors} — исправить</button>
              ) : (
                <button class="btn primary grow" disabled={saving} onClick={() => save(false)}>{saving ? "Сохранение…" : "Сохранить"}</button>
              )}
            </div>
          )}
        </div>
      ) : null}
      {renderSheet(sheet, ctx)}
    </div>
  );
}

function parseSub(sub) {
  const m = /^\/?d\/(\d+)(?:\/s\/(\d+))?$/.exec(sub || "");
  return m ? { di: +m[1], si: m[2] == null ? null : +m[2] } : {};
}

function count(n, forms) { return n + " " + plural(n, forms[0], forms[1], forms[2]); }

/* ---------------- мероприятие ---------------- */

function EventLevel({ ctx, st }) {
  const { doc, idx } = ctx;
  const ev = doc.event;
  const all = idx.all;
  return (
    <div>
      <a class="back" href={"#/my/" + st.event.id}>← К мероприятию</a>
      <div class="card glass">
        <div class="kicker">Конструктор · версия {st.base}{st.dirty ? " + правки" : ""}</div>
        <header class="ev-head">
          <h1>{ev.title}</h1>
          <p class="muted">{[dateRange(ev.date_from, ev.date_to), ev.venue, ev.city].filter(Boolean).join(" · ")}</p>
        </header>
        <div class="actions">
          <button class="btn" onClick={() => ctx.open({ kind: "event" })}>Название, даты, регламент</button>
          <button class="btn" onClick={() => ctx.open({ kind: "preview" })}>Как увидят участники</button>
        </div>
      </div>
      <button class={"card ed-row " + (all && all.err ? "has-err" : all ? "has-warn" : "ok")} onClick={() => ctx.open({ kind: "checks" })}>
        <b>Проверка</b>
        <span class="muted">{all ? `ошибок: ${all.err}, предупреждений: ${all.warn}` : "ошибок нет"}</span>
        <Issues x={all} />
      </button>
      <h2 class="section-title">Дни</h2>
      {doc.days.map((d, di) => {
        const items = d.sessions.reduce((n, s) => n + s.items.length, 0);
        return (
          <a key={d.date} class="card ed-row" href={"#/edit/" + ctx.eventId + "/d/" + di}>
            <b>{dayLabel(d.date)}{d.title ? " · " + d.title : ""}</b>
            <span class="muted">{count(d.sessions.length, ["заседание", "заседания", "заседаний"])}, {count(items, ["элемент", "элемента", "элементов"])}</span>
            <Issues x={idx["d" + di]} />
          </a>
        );
      })}
      <button class="btn wide" onClick={() => ctx.open({ kind: "day" })}>+ День</button>
      <h2 class="section-title">Ещё</h2>
      <button class="card ed-row" onClick={() => ctx.open({ kind: "sections" })}>
        <b>Секции</b><span class="muted">{doc.sections.length ? count(doc.sections.length, ["секция", "секции", "секций"]) : "нет"}</span>
      </button>
      <button class="card ed-row" onClick={() => ctx.open({ kind: "people" })}>
        <b>Люди</b><span class="muted">докладчики, авторы, председатели; разное написание</span>
      </button>
      <button class="card ed-row" onClick={() => ctx.open({ kind: "versions" })}>
        <b>История версий</b><span class="muted">открыть и вернуть прежнюю</span>
      </button>
    </div>
  );
}

/* ---------------- день ---------------- */

function DayLevel({ ctx, di, base }) {
  const d = ctx.doc.days[di];
  return (
    <div>
      <a class="back" href={"#" + base}>← {ctx.doc.event.title.length > 30 ? "Мероприятие" : ctx.doc.event.title}</a>
      <div class="row-between">
        <h1 class="page-title">{dayLabel(d.date)}{d.title ? <small class="muted"> · {d.title}</small> : null}</h1>
        <button class="btn" onClick={() => ctx.open({ kind: "day", di })}>Изменить</button>
      </div>
      {d.sessions.length ? d.sessions.map((s, si) => {
        const last = s.items.length ? s.items[s.items.length - 1] : null;
        const end = last && !last.all_day ? last.end : s.end;
        return (
          <a key={si} class="card ed-row" href={"#" + base + "/d/" + di + "/s/" + si}>
            <b>{s.title || "Заседание"}</b>
            <span class="muted">{[s.start && end ? s.start + "–" + end : s.start, s.room].filter(Boolean).join(" · ")}</span>
            <span class="muted">{count(s.items.length, ["элемент", "элемента", "элементов"])}</span>
            <Issues x={ctx.idx["d" + di + "s" + si]} />
          </a>
        );
      }) : <p class="muted empty">Заседаний пока нет</p>}
      <button class="btn wide" onClick={() => ctx.open({ kind: "session", di })}>+ Заседание</button>
    </div>
  );
}

/* ---------------- заседание ---------------- */

function SessionLevel({ ctx, di, si, order, setOrder, base }) {
  const s = ctx.doc.days[di].sessions[si];
  const dnd = ctx.dnd;
  const people = [s.chair && "Председатель: " + s.chair, s.cochair && "Сопредседатель: " + s.cochair, s.secretary && "Секретарь: " + s.secretary].filter(Boolean);
  return (
    <div>
      <a class="back" href={"#" + base + "/d/" + di}>← {dayLabel(ctx.doc.days[di].date)}</a>
      <button class="card ed-head" onClick={() => ctx.open({ kind: "session", di, si })}>
        <b>{s.title || "Заседание"}</b>
        <span class="muted">{[s.start, s.room].filter(Boolean).join(" · ") || "время и зал не заданы"}</span>
        {people.map(x => <span key={x} class="ses-person">{x}</span>)}
        <span class="edit-hint">Изменить</span>
      </button>
      <div class="row-between">
        <h2 class="section-title flat">{count(s.items.length, ["элемент", "элемента", "элементов"])}</h2>
        {s.items.length > 1 ? <button class={"btn" + (order ? " on" : "")} aria-pressed={order} onClick={() => setOrder(!order)}>{order ? "Готово" : "Порядок"}</button> : null}
      </div>
      <ul class="ed-items card">
        {s.items.map((it, ii) => {
          const x = ctx.idx["d" + di + "s" + si + "i" + ii];
          const cls = "ed-it" + (x && x.err ? " has-err" : x ? " has-warn" : "");
          const person = it.speaker || (it.authors || []).join(", ");
          return (
            <li key={(it.code || "") + ii} id={"ed-it-" + ii} class={cls + (dnd && !order ? dnd.mark(di, si, ii) : "")}
              draggable={!!dnd && !order} onDragStart={dnd && !order ? e => dnd.start(e, { di, si, ii }) : undefined}
              onDragEnd={dnd ? dnd.end : undefined} onDragOver={dnd ? e => dnd.overItem(e, di, si, ii) : undefined}
              onDrop={dnd ? e => dnd.dropItem(e, di, si, ii) : undefined}>
              {order ? (
                <div class="ed-order">
                  <span class="ed-title">{it.title}</span>
                  <button class="btn icon" aria-label="Выше" disabled={ii === 0} onClick={() => ctx.commit(shiftItem(ctx.doc, di, si, ii, -1))}>↑</button>
                  <button class="btn icon" aria-label="Ниже" disabled={ii === s.items.length - 1} onClick={() => ctx.commit(shiftItem(ctx.doc, di, si, ii, 1))}>↓</button>
                </div>
              ) : (
                <button class="ed-open" onClick={() => ctx.open({ kind: "item", di, si, ii })}>
                  <span class={"it-time" + (it.anchor ? " pinned" : "")} title={it.anchor ? "время закреплено" : "по порядку"}>{it.all_day ? "день" : it.start || "—"}</span>
                  <span class="it-body">
                    <span class="it-title">{it.type !== "talk" ? <span class="tag">{TYPE_SHORT[it.type]}</span> : null}{it.title}</span>
                    {person ? <span class="it-people">{person}</span> : null}
                    {x ? <span class="it-note">{x.list[0].message}</span> : null}
                  </span>
                  <Issues x={x} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div class="actions">
        <button class="btn" onClick={() => ctx.open({ kind: "item", di, si, ii: null, type: "talk" })}>+ Доклад</button>
        <button class="btn" onClick={() => ctx.open({ kind: "item", di, si, ii: null, type: "break" })}>+ Перерыв</button>
        <button class="btn" onClick={() => ctx.open({ kind: "item", di, si, ii: null, type: "activity" })}>+ Другое</button>
        <button class="btn" onClick={() => ctx.open({ kind: "import", di, si })}>Из таблицы…</button>
      </div>
    </div>
  );
}

function readPref(k) { try { return localStorage.getItem(k) === "1"; } catch (e) { return false; } }
function writePref(k, v) { try { localStorage.setItem(k, v ? "1" : "0"); } catch (e) { /* приватный режим */ } }

/* ---------------- десктоп: дерево программы и предпросмотр печати ---------------- */

function Dot({ x }) {
  return x ? <i class={"tr-dot " + (x.err ? "err" : "warn")} title={x.err ? "есть ошибки" : "есть предупреждения"} /> : null;
}

function Tree({ ctx, p, base, preview, togglePreview }) {
  const { doc, idx, dnd } = ctx;
  return (
    <nav class="ed-tree card" aria-label="Программа по дням и заседаниям">
      <a class={"tr-ev" + (p.di == null ? " on" : "")} href={"#" + base}>{doc.event.title}<Dot x={idx.all} /></a>
      {doc.days.map((d, di) => (
        <div key={d.date} class="tr-day">
          <a class={"tr-row" + (p.di === di && p.si == null ? " on" : "")} href={"#" + base + "/d/" + di}>
            <b>{dayLabel(d.date)}</b><Dot x={idx["d" + di]} />
          </a>
          {d.sessions.map((s, si) => (
            <a key={si} href={"#" + base + "/d/" + di + "/s/" + si}
              class={"tr-row tr-ses" + (p.di === di && p.si === si ? " on" : "") + (dnd && dnd.over === di + ":" + si ? " drop" : "")}
              onDragOver={e => dnd.overSession(e, di, si)} onDrop={e => dnd.dropSession(e, di, si)}>
              <span>{s.start ? <span class="tr-time">{s.start}</span> : null}{s.title || "Заседание"}</span>
              <small>{[s.room, s.items.length + " эл."].filter(Boolean).join(" · ")}</small>
              <Dot x={idx["d" + di + "s" + si]} />
            </a>
          ))}
        </div>
      ))}
      <div class="tr-foot">
        <button class={"btn" + (preview ? " on" : "")} aria-pressed={preview} onClick={togglePreview}>Предпросмотр печати</button>
        <p class="muted small">Ctrl+S — сохранить, Ctrl+Z — отменить, Esc — закрыть лист, Alt+↑/↓ — сдвинуть элемент.
          Элементы можно перетаскивать мышью: внутри заседания и на заседание в этом списке.</p>
      </div>
    </nav>
  );
}

function PrintPreview({ doc, id }) {
  const wrap = useRef(null);
  const inner = useRef(null);
  useEffect(() => {
    function fit() {
      if (!wrap.current || !inner.current) return;
      const s = Math.min(1, wrap.current.clientWidth / inner.current.offsetWidth);
      inner.current.style.transform = "scale(" + s + ")";
      wrap.current.style.height = Math.ceil(inner.current.offsetHeight * s) + "px";
    }
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  });
  return (
    <aside class="ed-preview card" aria-label="Предпросмотр печатной программы">
      <div class="row-between"><b>Как будет напечатано</b><a href={"#/print/" + id + "/program"}>Документы</a></div>
      <div class="print-scale" ref={wrap}>
        <div class="print-doc" ref={inner}><ProgramDoc program={doc} /></div>
      </div>
    </aside>
  );
}
