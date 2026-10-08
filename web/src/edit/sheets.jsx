// Нижние листы конструктора: правка мероприятия, дня, заседания, элемента; перенос, проверки, версии, импорт.
// ctx: { doc, report, idx, commit(doc, note?), close(), open(sheet), goTo(path, focus), base, eventId, toast, people, rooms }
import { useState, useEffect } from "preact/hooks";
import M from "../../../shared/model.js";
import { api, errorText } from "../api.js";
import { dayLabel, shortDate } from "../util.js";
import { Program } from "../components/Program.jsx";
import {
  clone, applyItemForm, itemForm, duplicateItem, removeAt, moveItem, shiftSession, moveSession,
  addDay, setDay, parsePath, sessionSection,
} from "./ops.js";
import { readTable, findHeader, guessMapping, rowsToItems, FIELDS } from "./table.js";
import { Sheet, Field, Check, IssueList, bind } from "./ui.jsx";

export const TYPES = [["talk", "Доклад"], ["plenary", "Пленарный доклад"], ["break", "Перерыв"], ["lunch", "Обед"],
  ["ceremony", "Церемония"], ["activity", "Другое событие"]];
const TYPE_TITLE = { break: "Кофе-брейк", lunch: "Обед", ceremony: "Открытие" };
const FORMATS = [["", "не указана"], ["oral", "очно"], ["online", "онлайн"], ["poster", "стендовый"]];
const REG_OF = { talk: "talk_min", plenary: "plenary_min", break: "break_min", lunch: "lunch_min" };
const SOURCE = { ui: "интерфейс", api: "API", mcp: "MCP", import: "импорт" };

const trimOrDelete = (obj, form, keys) => keys.forEach(k => {
  const v = String(form[k] == null ? "" : form[k]).trim();
  if (v) obj[k] = v; else delete obj[k];
});
const badTime = v => v && !M.normTime(v);
const short = s => (s && s.length > 48 ? s.slice(0, 46) + "…" : s || "");

/** Где в программе запись отчёта: «7 октября, ср · Заседание №1 · s1-3 Название». */
export function where(doc, path) {
  const p = parsePath(path);
  const d = p.di != null ? doc.days[p.di] : null;
  if (!d) return "Мероприятие";
  const parts = [dayLabel(d.date)];
  const s = p.si != null ? d.sessions[p.si] : null;
  if (s) parts.push(s.title || "Заседание");
  const it = s && p.ii != null ? s.items[p.ii] : null;
  if (it) parts.push((it.code ? it.code + " " : "") + short(it.title));
  return parts.join(" · ");
}

/* ---------------- элемент ---------------- */

function ItemSheet({ ctx, di, si, ii, type }) {
  const ses = ctx.doc.days[di].sessions[si];
  const it = ii == null ? null : ses.items[ii];
  const [form, setForm] = useState(() => {
    const f = itemForm(it || { type: type || "talk" });
    if (!it && TYPE_TITLE[type]) f.title = TYPE_TITLE[type];
    if (!it && sessionSection(ses)) f.section = String(sessionSection(ses));
    return f;
  });
  const [err, setErr] = useState("");
  const set = bind(form, setForm);
  const isTalk = form.type === "talk" || form.type === "plenary";
  const regs = ctx.doc.event.regulations || M.DEFAULT_REGULATIONS;
  const defDur = regs[REG_OF[form.type] || "other_min"];
  const iss = ii == null ? null : ctx.idx["d" + di + "s" + si + "i" + ii];

  function apply(after) {
    if (!form.title.trim()) return setErr("Нужно название");
    if (badTime(form.start)) return setErr("Время начала — в формате ЧЧ:ММ");
    const f = Object.assign({}, form);
    if (!isTalk) { f.authors = ""; f.section = ""; f.format = ""; f.org = ""; f.city = ""; }
    if (f.type !== "talk") f.competitive = false;
    const next = clone(ctx.doc);
    const items = next.days[di].sessions[si].items;
    const item = applyItemForm(it, f);
    if (ii == null) items.push(item); else items[ii] = item;
    ctx.commit(next);
    if (after) after(next); else ctx.close();
  }

  const footer = ii == null
    ? <button class="btn primary" onClick={() => apply()}>Добавить</button>
    : (
      <div>
        <button class="btn primary" onClick={() => apply()}>Готово</button>
        <div class="actions">
          <button class="btn" onClick={() => apply(() => ctx.open({ kind: "moveItem", di, si, ii }))}>Перенести…</button>
          <button class="btn" onClick={() => { ctx.commit(duplicateItem(ctx.doc, di, si, ii)); ctx.close(); ctx.toast("Копия добавлена ниже"); }}>Копия</button>
          <button class="btn danger" onClick={() => { ctx.commit(removeAt(ctx.doc, { di, si, ii })); ctx.close(); ctx.toast("Удалено — можно отменить ↶"); }}>Удалить</button>
        </div>
      </div>
    );

  return (
    <Sheet title={ii == null ? "Новый элемент" : (it.code ? it.code + " · " : "") + "элемент"} onClose={ctx.close} footer={footer}>
      <IssueList list={iss && iss.list} />
      <Field label="Тип">
        <select value={form.type} onChange={set("type")}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      </Field>
      <Field label="Название"><textarea class="auto" rows={3} value={form.title} onInput={set("title")} /></Field>
      <Field label={isTalk ? "Докладчик" : "Ведущий"}>
        <input value={form.speaker} onInput={set("speaker")} list="people" autocomplete="off" />
      </Field>
      {isTalk ? (
        <div>
          <Field label="Авторы" hint="Через запятую: А. А. Иванов, Б. Б. Петров">
            <input value={form.authors} onInput={set("authors")} autocomplete="off" />
          </Field>
          <Field label="Организация"><input value={form.org} onInput={set("org")} /></Field>
          <Field label="Город"><input value={form.city} onInput={set("city")} /></Field>
          <div class="grid2">
            <Field label="Секция">
              <select value={form.section} onChange={set("section")}>
                <option value="">—</option>
                {ctx.doc.sections.map(s => <option key={s.no} value={String(s.no)}>{s.no}. {short(s.title)}</option>)}
              </select>
            </Field>
            <Field label="Форма участия">
              <select value={form.format} onChange={set("format")}>{FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </Field>
          </div>
          {form.type === "talk" ? <Check label="Участвует в конкурсе (оценивает жюри)" checked={form.competitive} onChange={set("competitive")} /> : null}
        </div>
      ) : null}
      <Check label="Весь день (без времени)" checked={form.all_day} onChange={set("all_day")} />
      {form.all_day ? null : (
        <div class="grid2">
          <Field label="Начало" hint={form.start ? "закреплено" : it && it.start ? `по порядку: ${it.start}` : "по порядку"}>
            <input type="time" value={form.start} onInput={set("start")} />
          </Field>
          <Field label="Минут" hint={`по регламенту: ${defDur}`}>
            <input type="number" inputmode="numeric" min="1" max="1440" value={form.duration} placeholder={String(defDur)} onInput={set("duration")} />
          </Field>
        </div>
      )}
      {form.start ? <button class="btn link" onClick={() => setForm(Object.assign({}, form, { start: "" }))}>Считать время по порядку</button> : null}
      <Field label="Зал" hint={ses.room ? `если не ${ses.room}` : ""}><input value={form.room} onInput={set("room")} list="rooms" autocomplete="off" /></Field>
      <Field label="Примечание"><input value={form.note} onInput={set("note")} /></Field>
      {it && it.extra ? <Field label="Данные вне схемы (сохраняются как есть)"><pre class="extra">{JSON.stringify(it.extra, null, 1)}</pre></Field> : null}
      <p class="err">{err}</p>
    </Sheet>
  );
}

function MoveItemSheet({ ctx, di, si, ii }) {
  const it = ctx.doc.days[di].sessions[si].items[ii];
  return (
    <Sheet title={"Перенести: " + short(it.title)} onClose={ctx.close}>
      {ctx.doc.days.map((d, dj) => (
        <div key={dj}>
          <p class="sheet-sub">{dayLabel(d.date)}</p>
          {d.sessions.length ? d.sessions.map((s, sj) => (
            <button key={sj} class="btn row" disabled={dj === di && sj === si} onClick={() => {
              ctx.commit(moveItem(ctx.doc, { di, si, ii }, { di: dj, si: sj }));
              ctx.close();
              ctx.toast(`Перенесено в «${s.title || "Заседание"}»`);
            }}>
              <b>{s.title || "Заседание"}</b><span class="muted">{[s.start, s.room].filter(Boolean).join(" · ")}</span>
            </button>
          )) : <p class="muted">нет заседаний</p>}
        </div>
      ))}
    </Sheet>
  );
}

/* ---------------- заседание ---------------- */

function SessionSheet({ ctx, di, si }) {
  const day = ctx.doc.days[di];
  const s = si == null ? null : day.sessions[si];
  const [form, setForm] = useState(() => {
    const f = {};
    ["title", "room", "start", "end", "chair", "cochair", "secretary"].forEach(k => { f[k] = s && s[k] ? s[k] : ""; });
    if (!s) f.title = "Заседание №" + (ctx.doc.days.reduce((n, d) => n + d.sessions.length, 0) + 1);
    return f;
  });
  const [err, setErr] = useState("");
  const set = bind(form, setForm);

  function apply() {
    if (badTime(form.start) || badTime(form.end)) return setErr("Время — в формате ЧЧ:ММ");
    const next = clone(ctx.doc);
    const list = next.days[di].sessions;
    const ses = s ? list[si] : { items: [] };
    trimOrDelete(ses, form, ["title", "room", "start", "end", "chair", "cochair", "secretary"]);
    if (s) { ctx.commit(next); ctx.close(); return; }
    list.push(ses);
    ctx.commit(next);
    ctx.goTo("/d/" + di + "/s/" + (list.length - 1));
  }
  function remove() {
    if (s.items.length && !window.confirm(`Удалить заседание «${s.title || "без названия"}» и ${s.items.length} элем.?`)) return;
    ctx.commit(removeAt(ctx.doc, { di, si }));
    ctx.goTo("/d/" + di);
    ctx.toast("Заседание удалено — можно отменить ↶");
  }
  const footer = s ? (
    <div>
      <button class="btn primary" onClick={apply}>Готово</button>
      <div class="actions">
        <button class="btn" disabled={si === 0} onClick={() => { ctx.commit(shiftSession(ctx.doc, di, si, -1)); ctx.goTo("/d/" + di + "/s/" + (si - 1)); }}>↑ Раньше</button>
        <button class="btn" disabled={si === day.sessions.length - 1} onClick={() => { ctx.commit(shiftSession(ctx.doc, di, si, 1)); ctx.goTo("/d/" + di + "/s/" + (si + 1)); }}>↓ Позже</button>
        {ctx.doc.days.length > 1 ? <button class="btn" onClick={() => ctx.open({ kind: "moveSession", di, si })}>В другой день…</button> : null}
        <button class="btn danger" onClick={remove}>Удалить</button>
      </div>
    </div>
  ) : <button class="btn primary" onClick={apply}>Добавить</button>;

  return (
    <Sheet title={s ? "Заседание" : "Новое заседание"} onClose={ctx.close} footer={footer}>
      <Field label="Название"><input value={form.title} onInput={set("title")} /></Field>
      <Field label="Зал"><input value={form.room} onInput={set("room")} list="rooms" autocomplete="off" /></Field>
      <div class="grid2">
        <Field label="Начало" hint="пусто — после предыдущего в этом зале"><input type="time" value={form.start} onInput={set("start")} /></Field>
        <Field label="Конец" hint="для проверки"><input type="time" value={form.end} onInput={set("end")} /></Field>
      </div>
      <Field label="Председатель"><input value={form.chair} onInput={set("chair")} list="people" autocomplete="off" /></Field>
      <Field label="Сопредседатель"><input value={form.cochair} onInput={set("cochair")} list="people" autocomplete="off" /></Field>
      <Field label="Секретарь"><input value={form.secretary} onInput={set("secretary")} list="people" autocomplete="off" /></Field>
      <p class="err">{err}</p>
    </Sheet>
  );
}

function MoveSessionSheet({ ctx, di, si }) {
  const s = ctx.doc.days[di].sessions[si];
  return (
    <Sheet title={"Перенести: " + (s.title || "заседание")} onClose={ctx.close}>
      {ctx.doc.days.map((d, dj) => (
        <button key={dj} class="btn row" disabled={dj === di} onClick={() => {
          ctx.commit(moveSession(ctx.doc, di, si, dj));
          ctx.goTo("/d/" + dj + "/s/" + d.sessions.length);
        }}>
          <b>{dayLabel(d.date)}</b><span class="muted">{d.title || ""}</span>
        </button>
      ))}
    </Sheet>
  );
}

/* ---------------- день ---------------- */

function DaySheet({ ctx, di }) {
  const d = di == null ? null : ctx.doc.days[di];
  const lastDate = ctx.doc.days.length ? ctx.doc.days[ctx.doc.days.length - 1].date : ctx.doc.event.date_from;
  const [form, setForm] = useState({ date: d ? d.date : nextDate(lastDate, !ctx.doc.days.length), title: d && d.title ? d.title : "" });
  const [err, setErr] = useState("");
  const set = bind(form, setForm);

  function apply() {
    const date = M.normDate(form.date);
    if (!date) return setErr("Нужна дата");
    if (ctx.doc.days.some((x, j) => j !== di && x.date === date)) return setErr("Такой день уже есть");
    const fields = { date };
    if (form.title.trim()) fields.title = form.title.trim();
    if (d) {
      const r = setDay(ctx.doc, di, fields);
      if (!fields.title) delete r.doc.days[r.di].title;
      ctx.commit(r.doc);
      if (r.di !== di) ctx.goTo("/d/" + r.di); else ctx.close();
    } else {
      const r = addDay(ctx.doc, fields);
      ctx.commit(r.doc);
      ctx.goTo("/d/" + r.di);
    }
  }
  function remove() {
    if (d.sessions.length && !window.confirm(`Удалить ${dayLabel(d.date)} и ${d.sessions.length} засед.?`)) return;
    ctx.commit(removeAt(ctx.doc, { di }));
    ctx.goTo("");
    ctx.toast("День удалён — можно отменить ↶");
  }
  const footer = d ? (
    <div>
      <button class="btn primary" onClick={apply}>Готово</button>
      <div class="actions"><button class="btn danger" disabled={ctx.doc.days.length < 2} onClick={remove}>Удалить день</button></div>
    </div>
  ) : <button class="btn primary" onClick={apply}>Добавить</button>;
  return (
    <Sheet title={d ? "День" : "Новый день"} onClose={ctx.close} footer={footer}>
      <Field label="Дата"><input type="date" value={form.date} onInput={set("date")} /></Field>
      <Field label="Подпись" hint="Например: «Выездное заседание»"><input value={form.title} onInput={set("title")} /></Field>
      <p class="err">{err}</p>
    </Sheet>
  );
}

function nextDate(iso, same) {
  const p = String(iso || "").split("-").map(Number);
  if (p.length !== 3 || !p[0]) return "";
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + (same ? 0 : 1)));
  return d.toISOString().slice(0, 10);
}

/* ---------------- мероприятие, секции ---------------- */

function EventSheet({ ctx }) {
  const ev = ctx.doc.event;
  const regs = Object.assign({}, M.DEFAULT_REGULATIONS, ev.regulations || {});
  const jury = ev.jury || {};
  const [form, setForm] = useState(() => {
    const f = {};
    ["title", "subtitle", "date_from", "date_to", "city", "venue", "organizer"].forEach(k => { f[k] = ev[k] || ""; });
    Object.keys(M.DEFAULT_REGULATIONS).forEach(k => { f[k] = String(regs[k]); });
    f.jury = !!jury.enabled || !!(jury.criteria && jury.criteria.length);
    f.criteria = (jury.criteria || []).join("\n");
    f.scale_max = String(jury.scale_max || 5);
    return f;
  });
  const [err, setErr] = useState("");
  const set = bind(form, setForm);
  const REG_LABEL = { talk_min: "Доклад", plenary_min: "Пленарный", break_min: "Перерыв", lunch_min: "Обед", other_min: "Прочее" };

  function apply() {
    if (!form.title.trim()) return setErr("Нужно название");
    if (!M.normDate(form.date_from)) return setErr("Нужна дата начала");
    const next = clone(ctx.doc);
    const e = next.event;
    trimOrDelete(e, form, ["title", "subtitle", "date_from", "date_to", "city", "venue", "organizer"]);
    e.regulations = {};
    for (const k of Object.keys(M.DEFAULT_REGULATIONS)) {
      const n = parseInt(form[k], 10);
      if (!(n >= 1 && n <= 600)) return setErr("Длительности регламента — от 1 до 600 минут");
      e.regulations[k] = n;
    }
    const criteria = form.criteria.split("\n").map(x => x.trim()).filter(Boolean);
    if (form.jury) e.jury = { enabled: true, criteria, scale_max: parseInt(form.scale_max, 10) || 5 };
    else delete e.jury;
    ctx.commit(next);
    ctx.close();
  }
  return (
    <Sheet title="Мероприятие" onClose={ctx.close} footer={<button class="btn primary" onClick={apply}>Готово</button>}>
      <Field label="Название"><textarea class="auto" rows={2} value={form.title} onInput={set("title")} /></Field>
      <Field label="Подзаголовок"><input value={form.subtitle} onInput={set("subtitle")} /></Field>
      <div class="grid2">
        <Field label="Начало"><input type="date" value={form.date_from} onInput={set("date_from")} /></Field>
        <Field label="Окончание"><input type="date" value={form.date_to} onInput={set("date_to")} /></Field>
      </div>
      <Field label="Город"><input value={form.city} onInput={set("city")} /></Field>
      <Field label="Место проведения"><input value={form.venue} onInput={set("venue")} /></Field>
      <Field label="Организатор"><input value={form.organizer} onInput={set("organizer")} /></Field>
      <p class="sheet-sub">Регламент, минут</p>
      <p class="muted small">Действует на новые элементы и на те, у которых длительность не задана.</p>
      <div class="grid2">
        {Object.keys(M.DEFAULT_REGULATIONS).map(k => (
          <Field key={k} label={REG_LABEL[k] || k}><input type="number" inputmode="numeric" min="1" max="600" value={form[k]} onInput={set(k)} /></Field>
        ))}
      </div>
      <p class="sheet-sub">Конкурс докладов</p>
      <Check label="Жюри оценивает доклады" checked={form.jury} onChange={set("jury")} />
      {form.jury ? (
        <div>
          <Field label="Критерии" hint="По одному в строке"><textarea class="auto" rows={4} value={form.criteria} onInput={set("criteria")} /></Field>
          <Field label="Максимальный балл"><input type="number" inputmode="numeric" min="1" max="100" value={form.scale_max} onInput={set("scale_max")} /></Field>
        </div>
      ) : null}
      <p class="err">{err}</p>
    </Sheet>
  );
}

function SectionsSheet({ ctx }) {
  const [list, setList] = useState(() => clone(ctx.doc.sections));
  const used = {};
  ctx.doc.days.forEach(d => d.sessions.forEach(s => s.items.forEach(it => { if (it.section) used[it.section] = (used[it.section] || 0) + 1; })));
  const edit = (i, k) => e => { const next = clone(list); next[i][k] = k === "no" ? parseInt(e.currentTarget.value, 10) || "" : e.currentTarget.value; setList(next); };
  function apply() {
    const next = clone(ctx.doc);
    next.sections = list.filter(s => String(s.title || "").trim() && s.no >= 1).map(s => {
      const out = { no: s.no, title: s.title.trim() };
      if (s.short && s.short.trim()) out.short = s.short.trim();
      return out;
    });
    ctx.commit(next);
    ctx.close();
  }
  return (
    <Sheet title="Секции" onClose={ctx.close} footer={<button class="btn primary" onClick={apply}>Готово</button>}>
      {list.map((s, i) => (
        <div key={i} class="sec-row">
          <input class="sec-no" type="number" inputmode="numeric" min="1" aria-label="Номер" value={s.no} onInput={edit(i, "no")} />
          <textarea class="auto" rows={2} aria-label="Название секции" value={s.title} onInput={edit(i, "title")} />
          <button class="btn icon" aria-label="Удалить секцию" onClick={() => setList(list.filter((x, j) => j !== i))}>✕</button>
          {used[s.no] ? <small class="hint">докладов: {used[s.no]}</small> : null}
        </div>
      ))}
      <button class="btn wide" onClick={() => setList(list.concat([{ no: list.reduce((m, s) => Math.max(m, +s.no || 0), 0) + 1, title: "" }]))}>+ Секция</button>
    </Sheet>
  );
}

/* ---------------- проверки, версии, импорт, предпросмотр ---------------- */

function ChecksSheet({ ctx }) {
  const rows = ctx.report.errors.concat(ctx.report.warnings.filter(w => w.code !== "EXTRA_USED"));
  return (
    <Sheet title={`Проверка: ошибок ${ctx.report.errors.length}`} onClose={ctx.close}>
      {rows.length ? (
        <ul class="report-list">
          {rows.map((e, i) => {
            const p = parsePath(e.path);
            const target = p.di == null ? null : p.si == null ? "/d/" + p.di : "/d/" + p.di + "/s/" + p.si;
            const focus = p.ii != null ? p.ii : null;
            return (
              <li key={i} class={e.level === "error" ? "err" : "warn"}>
                <button class="link-row" onClick={() => (target == null ? ctx.open({ kind: "event" }) : ctx.goTo(target, focus))}>
                  <b>{e.message}</b><small>{where(ctx.doc, e.path)}</small>
                </button>
              </li>
            );
          })}
        </ul>
      ) : <p class="muted">Ошибок и предупреждений нет.</p>}
    </Sheet>
  );
}

function VersionsSheet({ ctx }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(0);
  useEffect(() => {
    api("GET", `/api/v1/events/${ctx.eventId}/versions`).then(r => {
      if (r.status === 200) setList(r.json.versions); else setErr(errorText(r));
    }, e => setErr(e.message));
  }, []);
  async function restore(no) {
    setBusy(no);
    try {
      const r = await api("GET", `/api/v1/events/${ctx.eventId}/versions/${no}`);
      if (r.status !== 200) throw new Error(errorText(r));
      ctx.commit(r.json.program, `Откат к версии ${no}`);
      ctx.close();
      ctx.toast(`Версия ${no} открыта — сохраните, чтобы вернуть её`);
    } catch (e) { setErr(e.message); } finally { setBusy(0); }
  }
  return (
    <Sheet title="История версий" onClose={ctx.close}>
      {err ? <p class="err">{err}</p> : null}
      {!list ? <p class="muted">Загрузка…</p> : (
        <ul class="ver-list">
          {list.map(v => (
            <li key={v.no}>
              <div>
                <b>№{v.no}</b> <span class="muted">{shortDate(v.created)} · {SOURCE[v.source] || v.source}{v.author ? " · " + v.author : v.api_key ? " · " + v.api_key : ""}</span>
                <div class="muted small">{v.stats && v.stats.items != null ? `элементов: ${v.stats.items}` : ""}{v.note ? " · " + v.note : ""}</div>
              </div>
              {v.no === ctx.base ? <span class="badge">текущая</span>
                : <button class="btn" disabled={!!busy} onClick={() => restore(v.no)}>{busy === v.no ? "…" : "Открыть"}</button>}
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result));
    fr.onerror = () => reject(new Error("Не удалось прочитать файл"));
    fr.readAsArrayBuffer(file);
  });
}

function ImportSheet({ ctx, di, si }) {
  const ses = ctx.doc.days[di].sessions[si];
  const [tbl, setTbl] = useState(null); // { name, rows, header, mapping }
  const [section, setSection] = useState("");
  const [fallback, setFallback] = useState(sessionSection(ses) ? String(sessionSection(ses)) : "");
  const [err, setErr] = useState("");

  async function pick(e) {
    const file = e.currentTarget.files && e.currentTarget.files[0];
    if (!file) return;
    setErr("");
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("Файл больше 10 МБ");
      const rows = readTable(file.name, await readFile(file));
      if (!rows.length) throw new Error("В таблице нет строк");
      const header = findHeader(rows);
      const mapping = header >= 0 ? guessMapping(rows[header]) : rows[0].map(() => "");
      setTbl({ name: file.name, rows, header, mapping });
    } catch (x) {
      setTbl(null);
      setErr(x.message);
    }
  }
  const data = tbl ? tbl.rows.slice(tbl.header + 1) : [];
  const items = tbl ? rowsToItems(data, tbl.mapping, { sections: ctx.doc.sections, section: section ? +section : null }) : [];
  const width = tbl ? tbl.rows.reduce((m, r) => Math.max(m, r.length), 0) : 0;
  const cols = [];
  for (let i = 0; i < width; i++) cols.push(i);
  const setMap = i => e => { const m = tbl.mapping.slice(); while (m.length < width) m.push(""); m[i] = e.currentTarget.value; setTbl(Object.assign({}, tbl, { mapping: m })); };

  function apply() {
    const next = clone(ctx.doc);
    const list = next.days[di].sessions[si].items;
    const sec = parseInt(fallback, 10);
    items.forEach(it => { if (sec && !it.section && it.type === "talk") it.section = sec; list.push(it); });
    ctx.commit(next, `Импорт: ${tbl.name}`);
    ctx.close();
    ctx.toast(`Добавлено докладов: ${items.length}`);
  }
  return (
    <Sheet title="Доклады из таблицы" onClose={ctx.close}
      footer={tbl ? <button class="btn primary" disabled={!items.length || tbl.mapping.indexOf("title") < 0} onClick={apply}>
        {tbl.mapping.indexOf("title") < 0 ? "Укажите столбец с названием" : `Добавить ${items.length} в «${short(ses.title || "заседание")}»`}
      </button> : null}>
      <p class="muted small">Таблица заявок или программы: .xlsx, .csv или .docx. Каждая строка — доклад. E-mail и телефоны не переносятся.</p>
      <label class="btn wide file">
        {tbl ? "Другой файл" : "Выбрать файл"}
        <input type="file" accept=".xlsx,.csv,.txt,.docx" onChange={pick} />
      </label>
      {err ? <p class="err">{err}</p> : null}
      {tbl ? (
        <div>
          <p class="muted">{tbl.name}: строк с данными — {data.length}{tbl.header >= 0 ? ", заголовок узнан" : ", заголовок не найден — укажите столбцы"}</p>
          {cols.map(i => (
            <Field key={i} label={(tbl.header >= 0 ? tbl.rows[tbl.header][i] : "") || `Столбец ${i + 1}`} hint={short((data[0] || [])[i] || "")}>
              <select value={tbl.mapping[i] || ""} onChange={setMap(i)}>
                <option value="">не переносить</option>
                {FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </Field>
          ))}
          {tbl.mapping.indexOf("section") >= 0 ? (
            <Field label="Только секция">
              <select value={section} onChange={e => setSection(e.currentTarget.value)}>
                <option value="">все строки</option>
                {ctx.doc.sections.map(s => <option key={s.no} value={String(s.no)}>{s.no}. {short(s.title)}</option>)}
              </select>
            </Field>
          ) : null}
          {ctx.doc.sections.length && items.some(it => !it.section) ? (
            <Field label="Секция для строк без секции">
              <select value={fallback} onChange={e => setFallback(e.currentTarget.value)}>
                <option value="">без секции</option>
                {ctx.doc.sections.map(s => <option key={s.no} value={String(s.no)}>{s.no}. {short(s.title)}</option>)}
              </select>
            </Field>
          ) : null}
          {items.length ? (
            <div class="card preview-list">
              {items.slice(0, 5).map((it, i) => <p key={i}><b>{short(it.title)}</b><br /><span class="muted">{it.speaker || (it.authors || []).join(", ")}</span></p>)}
              {items.length > 5 ? <p class="muted">… и ещё {items.length - 5}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

function PreviewSheet({ ctx }) {
  return <Sheet title="Как увидят участники" onClose={ctx.close}><Program program={ctx.doc} /></Sheet>;
}

export function renderSheet(sheet, ctx) {
  if (!sheet) return null;
  const k = sheet.kind;
  const key = JSON.stringify(sheet);
  if (k === "item") return <ItemSheet key={key} ctx={ctx} di={sheet.di} si={sheet.si} ii={sheet.ii} type={sheet.type} />;
  if (k === "moveItem") return <MoveItemSheet key={key} ctx={ctx} di={sheet.di} si={sheet.si} ii={sheet.ii} />;
  if (k === "session") return <SessionSheet key={key} ctx={ctx} di={sheet.di} si={sheet.si} />;
  if (k === "moveSession") return <MoveSessionSheet key={key} ctx={ctx} di={sheet.di} si={sheet.si} />;
  if (k === "day") return <DaySheet key={key} ctx={ctx} di={sheet.di} />;
  if (k === "event") return <EventSheet key={key} ctx={ctx} />;
  if (k === "sections") return <SectionsSheet key={key} ctx={ctx} />;
  if (k === "checks") return <ChecksSheet key={key} ctx={ctx} />;
  if (k === "versions") return <VersionsSheet key={key} ctx={ctx} />;
  if (k === "import") return <ImportSheet key={key} ctx={ctx} di={sheet.di} si={sheet.si} />;
  if (k === "preview") return <PreviewSheet key={key} ctx={ctx} />;
  return null;
}
