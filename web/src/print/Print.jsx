// Печатные документы (#/print/<id>/<вид>): программа, таблички «на дверь», протоколы секций, сертификаты.
// На экране — лист A4 в масштабе ширины телефона; «Печать / PDF» — печать браузера с @page, «Word» — .docx.
import { useState, useEffect, useRef } from "preact/hooks";
import { api, errorText, user } from "../api.js";
import { useLoad, go } from "../hooks.js";
import { download } from "../util.js";
import { programRows, protocols, doors, certificates, datesLine, dayHeading } from "./data.js";
import { docx, programBlocks, protocolBlocks } from "./docx.js";

const KINDS = [
  ["program", "Программа", false],
  ["doors", "На дверь", true],
  ["protocols", "Протоколы", false],
  ["certificates", "Сертификаты", true],
];
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function Print({ id, kind, toast }) {
  const res = useLoad(async () => {
    const r = await api("GET", `/api/v1/events/${encodeURIComponent(id)}/program`);
    if (r.status !== 200) throw new Error(r.status === 404 ? "Мероприятие не найдено или нет доступа" : errorText(r));
    return r.json;
  }, [id]);
  const [day, setDay] = useState("");
  const wrap = useRef(null);
  const inner = useRef(null);
  const k = KINDS.find(x => x[0] === kind) || KINDS[0];
  const landscape = k[2];

  // масштаб листа под ширину экрана; при печати сбрасывается стилями @media print
  useEffect(() => {
    function fit() {
      if (!wrap.current || !inner.current) return;
      const s = Math.min(1, wrap.current.clientWidth / inner.current.offsetWidth);
      inner.current.style.transform = `scale(${s})`;
      wrap.current.style.height = Math.ceil(inner.current.offsetHeight * s) + "px";
    }
    fit();
    const t = setTimeout(fit, 100); // после загрузки шрифтов
    window.addEventListener("resize", fit);
    return () => { clearTimeout(t); window.removeEventListener("resize", fit); };
  });

  if (res.loading) return <p class="muted center">Загрузка…</p>;
  if (res.error) return <div class="card msg"><p>{res.error}</p><a class="btn wide" href="#/">К списку</a></div>;
  const { event, program } = res.data;
  const mine = !!user();
  const name = (event.slug || "program") + "-" + k[0];

  function word() {
    const blocks = k[0] === "protocols" ? protocolBlocks(program, day) : programBlocks(program);
    download(name + ".docx", docx(blocks), DOCX);
    if (toast) toast("Файл Word скачан");
  }

  let body;
  if (k[0] === "doors") body = <Doors list={doors(program, day)} />;
  else if (k[0] === "protocols") body = <Protocols list={protocols(program, day)} program={program} />;
  else if (k[0] === "certificates") body = <Certificates list={certificates(program, day)} program={program} />;
  else body = <ProgramDoc program={program} />;

  return (
    <div class="print-page">
      <style>{`@page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 12mm 12mm 12mm 15mm; }`}</style>
      <div class="no-print">
        <a class="back" href={mine ? "#/my/" + event.id : "#/e/" + event.slug}>← {event.title.length > 28 ? "Назад" : event.title}</a>
        <div class="seg print-kinds" role="tablist">
          {KINDS.map(([v, label]) => (
            <button key={v} role="tab" aria-selected={v === k[0]} class={v === k[0] ? "on" : ""} onClick={() => go(`/print/${id}/${v}`)}>{label}</button>
          ))}
        </div>
        {k[0] !== "program" && program.days.length > 1 ? (
          <label class="field"><span>День</span>
            <select value={day} onChange={e => setDay(e.currentTarget.value)}>
              <option value="">все дни</option>
              {program.days.map((d, i) => <option key={d.date} value={String(i)}>{dayHeading(d.date)}</option>)}
            </select>
          </label>
        ) : null}
        <div class="actions">
          <button class="btn primary" onClick={() => window.print()}>Печать / PDF</button>
          {k[0] === "program" || k[0] === "protocols" ? <button class="btn" onClick={word}>Word</button> : null}
        </div>
        <p class="muted small">Лист A4{landscape ? ", альбомный" : ""}. На телефоне: «Печать / PDF» → «Сохранить как PDF» или «Поделиться».</p>
      </div>
      <div class="print-scale" ref={wrap}>
        <div class={"print-doc" + (landscape ? " landscape" : "")} ref={inner}>{body}</div>
      </div>
    </div>
  );
}

function ProgramDoc({ program }) {
  const ev = program.event;
  return (
    <div class="pd-flow pd-program">
      <header class="pd-title">
        <h1>{ev.title}</h1>
        {ev.subtitle ? <p>{ev.subtitle}</p> : null}
        <p>{[datesLine(ev.date_from, ev.date_to), ev.venue, ev.city ? "г. " + ev.city.replace(/^г\.\s*/, "") : ""].filter(Boolean).join(" · ")}</p>
      </header>
      {programRows(program).map((d, di) => (
        <section key={d.date} class={"pd-day" + (di ? " pd-break" : "")}>
          <h2>{d.heading}{d.title ? " · " + d.title : ""}</h2>
          {d.sessions.map((s, si) => (
            <div key={si} class="pd-session">
              <h3>{s.session.title || "Заседание"}</h3>
              {s.session.chair ? <p class="pd-person">Председатель: {s.session.chair}</p> : null}
              {s.session.cochair ? <p class="pd-person">Сопредседатель: {s.session.cochair}</p> : null}
              {s.session.secretary ? <p class="pd-person">Ученый секретарь: {s.session.secretary}</p> : null}
              {s.place ? <p class="pd-person"><b>Место:</b> {s.place}</p> : null}
              {s.rows.map((r, ri) => {
                if (r.kind === "section" || r.kind === "plenary-head") return <h4 key={ri}>{r.text}</h4>;
                if (r.kind === "talk") {
                  return (
                    <div key={ri} class="pd-talk">
                      <div class="pd-time">{r.time}</div>
                      <div class="pd-text">
                        {r.authors ? <p class="pd-authors">{r.authors}</p> : null}
                        <p class="pd-name">{r.item.title}</p>
                        {r.speaker ? <p class="pd-speaker">{r.speaker}</p> : null}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={ri} class={"pd-talk pd-" + r.kind}>
                    <div class="pd-time">{r.time}</div>
                    <div class="pd-text"><p class="pd-name">{r.text}{r.place ? <span> ({r.place})</span> : null}</p></div>
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function Doors({ list }) {
  if (!list.length) return <div class="pd-page"><p>Нет заседаний</p></div>;
  return list.map((x, i) => (
    <div key={i} class="pd-page pd-door">
      <p class="pd-door-day">{x.dayText}{x.time ? " · " + x.time : ""}</p>
      <h1 class="pd-door-room">{x.room}</h1>
      <h2 class="pd-door-title">{x.session.title || "Заседание"}</h2>
      <table class={"pd-door-list" + (x.rows.length > 14 ? " dense" : "")}>
        <tbody>
          {x.rows.map((r, j) => (
            <tr key={j} class={r.type === "break" || r.type === "lunch" ? "pause" : ""}>
              <td class="t">{r.time}</td><td class="w">{r.who}</td><td>{r.title}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ));
}

function Protocols({ list, program }) {
  if (!list.length) return <div class="pd-page"><p>Нет докладов</p></div>;
  return list.map((p, i) => (
    <div key={i} class="pd-page pd-protocol">
      <h1>ПРОТОКОЛ</h1>
      <h2>заседания {p.title}</h2>
      <p class="pd-center">{program.event.title}</p>
      <p class="pd-center">{[p.day.date.split("-").reverse().join("."), p.place].filter(Boolean).join(", ")}</p>
      <table class="pd-table">
        <thead><tr><th>№</th><th>ФИО докладчика</th><th>Тема доклада</th><th>Место работы</th><th>Форма участия</th><th>Примечание</th></tr></thead>
        <tbody>
          {p.rows.map(r => <tr key={r.no}><td>{r.no}</td><td>{r.speaker}</td><td>{r.title}</td><td>{r.org}</td><td>{r.format}</td><td /></tr>)}
        </tbody>
      </table>
      <p class="pd-sign">Председатель ____________________ {p.chair ? `/ ${p.chair} /` : ""}</p>
      <p class="pd-sign">Секретарь ____________________ {p.secretary ? `/ ${p.secretary} /` : ""}</p>
    </div>
  ));
}

function Certificates({ list, program }) {
  const ev = program.event;
  if (!list.length) return <div class="pd-page"><p>Нет докладчиков</p></div>;
  return list.map((c, i) => (
    <div key={i} class="pd-page pd-cert">
      <p class="pd-cert-event">{ev.title}</p>
      <h1>СЕРТИФИКАТ</h1>
      <p class="pd-cert-sub">участника</p>
      <p class="pd-cert-name">{c.name}</p>
      <p>выступил(а) с докладом</p>
      <p class="pd-cert-title">«{c.title}»</p>
      <p class="pd-cert-when">{[datesLine(ev.date_from, ev.date_to), ev.city ? "г. " + ev.city.replace(/^г\.\s*/, "") : ""].filter(Boolean).join(", ")}</p>
      <p class="pd-sign">Председатель оргкомитета ____________________</p>
    </div>
  ));
}
