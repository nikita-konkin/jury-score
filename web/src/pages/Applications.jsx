// Заявки на доклады для владельца (#/applications/<id>): контакты, решение по заявке, выгрузка CSV.
// «Принять» добавляет доклад в выбранное заседание — сервер сохраняет новую версию программы.
import { useState } from "preact/hooks";
import { api, errorText } from "../api.js";
import { useLoad, useWide, useHtmlClass } from "../hooks.js";
import { copyText, download } from "../util.js";

import { STATUS, FORMAT, sessionChoices, applicationsCsv } from "../apply/data.js";

const FILTERS = [["new", "Новые"], ["accepted", "Принятые"], ["rejected", "Отклонённые"], ["all", "Все"]];
const when = pb => (pb ? new Date(pb.replace(" ", "T")).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

export function Applications({ id, toast }) {
  const res = useLoad(async () => {
    const [a, p] = await Promise.all([
      api("GET", `/api/v1/events/${encodeURIComponent(id)}/applications`),
      api("GET", `/api/v1/events/${encodeURIComponent(id)}/program`),
    ]);
    if (a.status !== 200) throw new Error(a.status === 404 ? "Мероприятие не найдено или нет доступа" : errorText(a));
    if (p.status !== 200) throw new Error(errorText(p));
    return { list: a.json, event: p.json.event, program: p.json.program };
  }, [id]);
  const [filter, setFilter] = useState("new");
  const [open, setOpen] = useState(null); // { id, mode: "accept" | "reject" }
  const [busy, setBusy] = useState(false);
  const wide = useWide();
  useHtmlClass("page-wide", wide);

  if (res.loading && !res.data) return <p class="muted center">Загрузка…</p>;
  if (res.error) return <div class="card msg"><p>{res.error}</p><a class="btn wide" href="#/">К списку</a></div>;
  const { list, event, program } = res.data;
  const apps = list.applications;
  const count = st => apps.filter(a => a.status === st).length;
  const shown = filter === "all" ? apps : apps.filter(a => a.status === filter);
  let draft = false;
  try { draft = !!localStorage.getItem("conf_edit_" + event.id); } catch (e) { /* приватный режим */ }

  async function decide(a, body, okText) {
    setBusy(true);
    try {
      const r = await api("POST", `/api/v1/events/${event.id}/applications/${a.id}`, body);
      if (r.status !== 200) throw new Error(r.json.message || errorText(r));
      toast(okText(r.json));
      setOpen(null);
      res.reload();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  }

  return (
    <div class="apps">
      <a class="back" href={"#/my/" + event.id}>← {event.title.length > 28 ? "Назад" : event.title}</a>
      <div class="card glass">
        <h1 class="page-title">Заявки на доклады</h1>
        <p class="muted">{list.open ? "Приём открыт" + (list.deadline ? " до " + list.deadline.split("-").reverse().join(".") : "") : list.reason}
          {" · "}всего {apps.length}, новых {count("new")}</p>
        {draft ? <p class="pill warn">В конструкторе есть несохранённые правки этой программы. Сохраните их до приёма заявок — иначе при сохранении появится конфликт версий.</p> : null}
        <div class="actions">
          <button class="btn" onClick={() => copyText(list.url).then(() => toast("Ссылка на форму скопирована"), () => toast(list.url))}>Ссылка на форму</button>
          <button class="btn" disabled={!apps.length} onClick={() => download((event.slug || "event") + "-заявки.csv", applicationsCsv(apps), "text/csv;charset=utf-8")}>⬇ CSV</button>
        </div>
      </div>
      <div class="seg" role="tablist" aria-label="Заявки">
        {FILTERS.map(([v, label]) => (
          <button key={v} role="tab" aria-selected={filter === v} class={filter === v ? "on" : ""} onClick={() => setFilter(v)}>
            {label}{v !== "all" && count(v) ? " " + count(v) : ""}
          </button>
        ))}
      </div>
      {!shown.length ? <p class="muted empty">{apps.length ? "Здесь заявок нет" : "Заявок пока нет. Отправьте участникам ссылку на форму."}</p> : null}
      {wide && shown.length ? (
        <div class="card table-wrap">
          <table class="wtable apps-table">
            <thead>
              <tr><th class="num">№</th><th>Статус</th><th>Докладчик</th><th>Доклад</th><th class="num">Секц.</th><th>Контакты</th><th>Подана</th><th /></tr>
            </thead>
            <tbody>
              {shown.map(a => (
                <AppRow key={a.id} a={a} program={program} event={event} busy={busy}
                  mode={open && open.id === a.id ? open.mode : ""} setMode={m => setOpen(m ? { id: a.id, mode: m } : null)}
                  accept={(t) => decide(a, { action: "accept", day: t.day, session: t.session }, r => `Доклад добавлен в программу: ${r.item.code}, версия ${r.version}`)}
                  reject={(reason) => decide(a, { action: "reject", reason }, () => "Заявка отклонена")}
                  reset={() => decide(a, { action: "reset" }, () => "Заявка снова на рассмотрении")} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {wide ? null : shown.map(a => (
        <AppCard key={a.id} a={a} program={program} event={event} busy={busy}
          mode={open && open.id === a.id ? open.mode : ""} setMode={m => setOpen(m ? { id: a.id, mode: m } : null)}
          accept={(t) => decide(a, { action: "accept", day: t.day, session: t.session }, r => `Доклад добавлен в программу: ${r.item.code}, версия ${r.version}`)}
          reject={(reason) => decide(a, { action: "reject", reason }, () => "Заявка отклонена")}
          reset={() => decide(a, { action: "reset" }, () => "Заявка снова на рассмотрении")} />
      ))}
    </div>
  );
}

function AppCard({ a, program, event, busy, mode, setMode, accept, reject, reset }) {
  const sec = a.section ? program.sections.find(s => s.no === a.section) : null;
  return (
    <article class={"card app-card app-" + a.status}>
      <div class="app-head"><span>№{a.no} · {when(a.created)}</span><span class={"badge app-" + a.status}>{STATUS[a.status] || a.status}</span></div>
      <h3 class="app-title">{a.title}</h3>
      <p class="app-who">{a.speaker}{a.format ? " · " + (FORMAT[a.format] || a.format) : ""}</p>
      {a.authors.length > 1 || (a.authors.length && a.authors[0] !== a.speaker) ? <p class="muted small">Авторы: {a.authors.join(", ")}</p> : null}
      {sec ? <p class="muted small">Секция {sec.no}. {sec.title}</p> : null}
      {a.org || a.city ? <p class="muted small">{[a.org, a.city].filter(Boolean).join(", ")}</p> : null}
      {a.email || a.phone ? (
        <p class="app-contacts small">
          {a.email ? <a href={"mailto:" + a.email}>{a.email}</a> : null}
          {a.phone ? <a href={"tel:" + a.phone.replace(/[^\d+]/g, "")}>{a.phone}</a> : null}
        </p>
      ) : null}
      {a.note ? <p class="app-note small">{a.note}</p> : null}
      {a.status === "accepted" ? <p class="small">В программе: <b>{a.item_code}</b> · <a href={"#/edit/" + event.id}>открыть в конструкторе</a></p> : null}
      {a.status === "rejected" && a.reason ? <p class="small">Причина: {a.reason}</p> : null}
      {a.status === "withdrawn" ? <p class="muted small">Участник отозвал заявку, его контакты удалены.{a.item_code ? ` Доклад ${a.item_code} остался в программе — уберите его в конструкторе.` : ""}</p> : null}

      <Decision a={a} program={program} busy={busy} mode={mode} setMode={setMode} accept={accept} reject={reject} reset={reset} />
    </article>
  );
}

/** Строка таблицы заявок на широком экране; решение раскрывается строкой ниже. */
function AppRow({ a, program, event, busy, mode, setMode, accept, reject, reset }) {
  const sec = a.section ? program.sections.find(x => x.no === a.section) : null;
  return [
    <tr key="r" class={"app-" + a.status}>
      <td class="num">{a.no}</td>
      <td><span class={"badge app-" + a.status}>{STATUS[a.status] || a.status}</span></td>
      <td><b>{a.speaker}</b>{a.org || a.city ? <span class="muted small">{[a.org, a.city].filter(Boolean).join(", ")}</span> : null}</td>
      <td>{a.title}{a.note ? <span class="muted small">{a.note}</span> : null}
        {a.status === "accepted" ? <span class="small">В программе: <b>{a.item_code}</b> · <a href={"#/edit/" + event.id}>в конструктор</a></span> : null}
        {a.status === "rejected" && a.reason ? <span class="small">Причина: {a.reason}</span> : null}</td>
      <td class="num" title={sec ? sec.title : ""}>{a.section || ""}</td>
      <td class="small">{a.email ? <a href={"mailto:" + a.email}>{a.email}</a> : null}{a.phone ? <span>{a.phone}</span> : null}</td>
      <td class="small">{when(a.created)}</td>
      <td>{mode ? null : <Decision a={a} program={program} busy={busy} mode="" setMode={setMode} accept={accept} reject={reject} reset={reset} />}</td>
    </tr>,
    mode ? (
      <tr key="d" class="app-decide"><td colSpan={8}>
        <Decision a={a} program={program} busy={busy} mode={mode} setMode={setMode} accept={accept} reject={reject} reset={reset} />
      </td></tr>
    ) : null,
  ];
}

/** Решение по заявке: кнопки или открытая панель «принять» / «отклонить». */
function Decision({ a, program, busy, mode, setMode, accept, reject, reset }) {
  const sc = sessionChoices(program, a.section);
  const [target, setTarget] = useState(String(sc.def));
  const [reason, setReason] = useState("");
  return mode === "accept" ? (
    <div class="app-panel">
      {sc.list.length ? (
        <label class="field"><span>Заседание</span>
          <select value={target} onChange={e => setTarget(e.currentTarget.value)}>
            {sc.list.map((s, i) => <option key={i} value={String(i)}>{s.label}</option>)}
          </select>
        </label>
      ) : <p class="pill warn">В программе нет заседаний: добавьте день и заседание в конструкторе.</p>}
      <div class="actions">
        <button class="btn primary" disabled={busy || !sc.list.length} onClick={() => accept(sc.list[+target])}>Добавить в программу</button>
        <button class="btn" onClick={() => setMode("")}>Отмена</button>
      </div>
    </div>
  ) : mode === "reject" ? (
    <div class="app-panel">
      <label class="field"><span>Причина — увидит участник</span>
        <textarea class="auto" rows={2} maxlength={1000} value={reason} onInput={e => setReason(e.currentTarget.value)} />
      </label>
      <div class="actions">
        <button class="btn danger" disabled={busy} onClick={() => reject(reason.trim())}>Отклонить заявку</button>
        <button class="btn" onClick={() => setMode("")}>Отмена</button>
      </div>
    </div>
  ) : (
    <div class="actions">
      {a.status === "new" ? <button class="btn primary" onClick={() => setMode("accept")}>Принять…</button> : null}
      {a.status === "new" ? <button class="btn" onClick={() => setMode("reject")}>Отклонить…</button> : null}
      {a.status === "accepted" || a.status === "rejected" ? (
        <button class="btn" disabled={busy} onClick={() => (a.status !== "accepted" || window.confirm(`Вернуть заявку на рассмотрение? Доклад ${a.item_code} останется в программе — при необходимости уберите его в конструкторе.`)) && reset()}>
          Вернуть на рассмотрение
        </button>
      ) : null}
    </div>
  );
}
