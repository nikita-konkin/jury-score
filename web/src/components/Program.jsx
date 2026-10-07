// Программа мероприятия для чтения: дни вкладками, заседания карточками, элементы списком.
import { useState } from "preact/hooks";
import { dayLabel, dateRange, weekday } from "../util.js";

const TYPE_LABEL = { break: "Перерыв", lunch: "Обед", ceremony: "Церемония", activity: "Событие" };
const FORMAT_LABEL = { online: "онлайн", poster: "стенд" };

export function EventHeader({ program }) {
  const ev = program.event;
  return (
    <header class="ev-head">
      <h1>{ev.title}</h1>
      {ev.subtitle ? <p class="muted">{ev.subtitle}</p> : null}
      <p class="muted">{[dateRange(ev.date_from, ev.date_to), ev.venue, ev.city].filter(Boolean).join(" · ")}</p>
    </header>
  );
}

function Item({ it, sections }) {
  const isTalk = it.type === "talk" || it.type === "plenary";
  const people = isTalk ? (it.authors && it.authors.length ? it.authors : [it.speaker]).filter(Boolean) : [];
  return (
    <li class={"it it-" + it.type}>
      <div class="it-time">{it.all_day ? "весь день" : it.start}</div>
      <div class="it-body">
        <div class="it-title">
          {it.type === "plenary" ? <span class="tag">пленарный</span> : null}
          {!isTalk && TYPE_LABEL[it.type] && it.title !== TYPE_LABEL[it.type] ? <span class="tag">{TYPE_LABEL[it.type]}</span> : null}
          {it.title}
        </div>
        {people.length ? (
          <div class="it-people">
            {people.map((p, i) => <span key={i} class={p === it.speaker && people.length > 1 ? "spk" : ""}>{i ? ", " : ""}{p}</span>)}
          </div>
        ) : it.speaker ? <div class="it-people">{it.speaker}</div> : null}
        {it.org || it.city ? <div class="it-org">{[it.org, it.city].filter(Boolean).join(", ")}</div> : null}
        <div class="it-meta">
          {it.code && isTalk ? <span class="code">{it.code}</span> : null}
          {it.section && sections[it.section] ? <span>Секция {it.section}</span> : null}
          {FORMAT_LABEL[it.format] ? <span class="fmt">{FORMAT_LABEL[it.format]}</span> : null}
          {it.room ? <span>{it.room}</span> : null}
          {!it.all_day && it.end ? <span>до {it.end}</span> : null}
        </div>
        {it.note ? <div class="it-note">{it.note}</div> : null}
      </div>
    </li>
  );
}

function Session({ s, sections }) {
  const last = s.items.length ? s.items[s.items.length - 1] : null;
  const end = last && !last.all_day ? last.end : s.end;
  return (
    <section class="card session">
      <div class="ses-head">
        <h3>{s.title || "Заседание"}</h3>
        <div class="muted">{[s.start && end ? `${s.start}–${end}` : s.start, s.room].filter(Boolean).join(" · ")}</div>
        {s.chair ? <div class="ses-person">Председатель: {s.chair}</div> : null}
        {s.cochair ? <div class="ses-person">Сопредседатель: {s.cochair}</div> : null}
        {s.secretary ? <div class="ses-person">Секретарь: {s.secretary}</div> : null}
      </div>
      <ul class="items">{s.items.map((it, i) => <Item key={it.code || i} it={it} sections={sections} />)}</ul>
    </section>
  );
}

export function Program({ program }) {
  const [day, setDay] = useState(0);
  const sections = {};
  program.sections.forEach(s => { sections[s.no] = s; });
  const d = program.days[Math.min(day, program.days.length - 1)];
  return (
    <div class="program">
      {program.days.length > 1 ? (
        <div class="seg glass days" role="tablist">
          {program.days.map((x, i) => (
            <button key={x.date} role="tab" aria-label={dayLabel(x.date)} aria-selected={i === day} class={i === day ? "on" : ""} onClick={() => setDay(i)}>
              {dayLabel(x.date, false)}<small>{weekday(x.date)}</small>
            </button>
          ))}
        </div>
      ) : null}
      {d ? (
        <div>
          {d.title ? <p class="day-title">{d.title}</p> : null}
          {d.sessions.length ? d.sessions.map((s, i) => <Session key={i} s={s} sections={sections} />)
            : <p class="muted empty">В этот день заседаний нет</p>}
        </div>
      ) : <p class="muted empty">В программе пока нет дней</p>}
      {program.sections.length ? (
        <details class="card sections">
          <summary>Секции ({program.sections.length})</summary>
          <ol>{program.sections.map(s => <li key={s.no} value={s.no}>{s.title}</li>)}</ol>
        </details>
      ) : null}
    </div>
  );
}

/** Отчёт проверки: ошибки и предупреждения с путём. */
export function Report({ report }) {
  if (!report) return null;
  const rows = report.errors.map(e => ["err", e]).concat((report.warnings || []).map(w => ["warn", w]));
  const st = report.stats || {};
  return (
    <div class="report">
      <p class={report.ok ? "ok" : "bad"}>
        {report.ok ? "Ошибок нет" : `Ошибок: ${report.errors.length} — программа не сохранится, пока их не исправить`}
        {report.warnings && report.warnings.length ? `; предупреждений: ${report.warnings.length}` : ""}
      </p>
      {st.items ? <p class="muted">Дней: {st.days}, заседаний: {st.sessions}, элементов: {st.items}, докладов: {st.talks}</p> : null}
      {rows.length ? (
        <ul class="report-list">
          {rows.slice(0, 50).map(([lvl, e], i) => (
            <li key={i} class={lvl}><b>{e.message}</b><small>{e.code}{e.path ? " · " + e.path : ""}</small></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
