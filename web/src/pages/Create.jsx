// Новое мероприятие: пустая программа на даты или копия своего мероприятия «по образцу».
import { useState } from "preact/hooks";
import M from "../../../shared/model.js";
import { api, errorText, user } from "../api.js";
import { go, useLoad } from "../hooks.js";
import { blankProgram, fromTemplate, daysBetween, shiftDate } from "../edit/ops.js";
import { Field, Check, bind } from "../edit/ui.jsx";
import { Report } from "../components/Program.jsx";

export function Create({ from, toast }) {
  const src = useLoad(async () => {
    if (!from) return null;
    const r = await api("GET", `/api/v1/events/${encodeURIComponent(from)}/program`);
    if (r.status !== 200) throw new Error(errorText(r));
    return r.json.program;
  }, [from]);
  const [form, setForm] = useState({ title: "", date_from: "", date_to: "", city: "", venue: "", keepTalks: false });
  const [err, setErr] = useState("");
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = bind(form, setForm);

  if (!user()) return <div class="card msg"><p>Войдите, чтобы создать мероприятие.</p><a class="btn wide" href="#/">Войти</a></div>;
  if (src.loading) return <p class="muted center">Загрузка…</p>;
  if (src.error) return <div class="card msg"><p>{src.error}</p><a class="btn wide" href="#/">К списку</a></div>;
  const tpl = src.data;
  const tplFrom = tpl ? tpl.event.date_from || (tpl.days[0] && tpl.days[0].date) : "";
  const shift = tpl && form.date_from ? daysBetween(tplFrom, form.date_from) : null;

  async function submit(e) {
    e.preventDefault();
    setErr(""); setReport(null);
    if (!form.title.trim()) return setErr("Нужно название");
    if (!M.normDate(form.date_from)) return setErr("Нужна дата начала");
    let program;
    try {
      program = tpl ? fromTemplate(tpl, { title: form.title.trim(), date_from: form.date_from, keepTalks: form.keepTalks })
        : blankProgram({ title: form.title.trim(), date_from: form.date_from, date_to: form.date_to, city: form.city.trim(), venue: form.venue.trim() });
    } catch (x) { return setErr(x.message); }
    const check = M.normalize(program);
    if (!check.report.ok) { setReport(check.report); return setErr("В программе есть ошибки"); }
    setBusy(true);
    try {
      const note = tpl ? `по образцу «${tpl.event.title}»` : "создано вручную";
      const r = await api("POST", "/api/v1/events", { program: check.doc, note });
      if (r.status !== 201) throw new Error(errorText(r));
      toast("Мероприятие создано");
      go("/edit/" + r.json.event.id);
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  }

  return (
    <div>
      <a class="back" href={from ? "#/my/" + from : "#/"}>← Назад</a>
      <form class="card glass" onSubmit={submit}>
        <h1 class="page-title">{tpl ? "По образцу" : "Новое мероприятие"}</h1>
        {tpl ? <p class="muted">Копия «{tpl.event.title}»: заседания, залы, перерывы и регламент. Даты сдвигаются вместе с началом.</p>
          : <p class="muted">Дни создадутся сами по датам. Заседания и доклады добавите в конструкторе.</p>}
        <Field label="Название"><input value={form.title} onInput={set("title")} required /></Field>
        <div class="grid2">
          <Field label="Начало"><input type="date" value={form.date_from} onInput={set("date_from")} required /></Field>
          {tpl ? (
            <Field label="Окончание"><input disabled value={tpl.event.date_to && shift != null ? shiftDate(tpl.event.date_to, shift) : "—"} /></Field>
          ) : <Field label="Окончание"><input type="date" value={form.date_to} onInput={set("date_to")} /></Field>}
        </div>
        {tpl ? (
          <Check label="Перенести доклады и председателей" checked={form.keepTalks} onChange={set("keepTalks")} />
        ) : (
          <div>
            <Field label="Город"><input value={form.city} onInput={set("city")} /></Field>
            <Field label="Место проведения"><input value={form.venue} onInput={set("venue")} /></Field>
          </div>
        )}
        <p class="err">{err}</p>
        <button class="btn primary" disabled={busy}>{busy ? "Создание…" : "Создать и открыть конструктор"}</button>
      </form>
      {report ? <div class="card"><Report report={report} /></div> : null}
    </div>
  );
}
