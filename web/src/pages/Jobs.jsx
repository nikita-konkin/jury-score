// Обработка на своём компьютере (#/jobs/<id>): задачи для локального обработчика worker/ с LM Studio.
// Владелец ставит задачу с текстом материалов, обработчик на его ПК забирает её, когда компьютер включён;
// готовый результат проверен model.js — его можно посмотреть и применить новой версией программы.
import { useState, useEffect } from "preact/hooks";
import { api, errorText } from "../api.js";
import { useLoad } from "../hooks.js";
import { copyText, plural } from "../util.js";
import { Program } from "../components/Program.jsx";
import { readText } from "../edit/table.js";
import { sessionChoices } from "../apply/data.js";

const KIND = { program_from_text: "Программа целиком из текста", talks_from_text: "Доклады из текста — в заседание" };
const STATUS = {
  queued: ["в очереди", ""], running: ["обрабатывается", "warn"], done: ["готово", "ok"],
  failed: ["ошибка", "err"], cancelled: ["отменена", "muted"], applied: ["применена", "ok"],
};
const ago = pb => {
  if (!pb) return "";
  const min = Math.round((Date.now() - new Date(pb.replace(" ", "T")).getTime()) / 60000);
  return min < 1 ? "только что" : min < 60 ? `${min} ${plural(min, "минуту", "минуты", "минут")} назад`
    : new Date(pb.replace(" ", "T")).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
};

export function Jobs({ id, toast }) {
  const res = useLoad(async () => {
    const [j, p] = await Promise.all([
      api("GET", `/api/v1/events/${encodeURIComponent(id)}/jobs`),
      api("GET", `/api/v1/events/${encodeURIComponent(id)}/program`),
    ]);
    if (j.status !== 200) throw new Error(j.status === 404 ? "Мероприятие не найдено или нет доступа" : errorText(j));
    if (p.status !== 200) throw new Error(errorText(p));
    return { list: j.json, event: p.json.event, program: p.json.program };
  }, [id]);
  const busyJobs = res.data && res.data.list.jobs.some(j => j.status === "queued" || j.status === "running");
  // пока задача в очереди или в работе — обновляем список
  useEffect(() => {
    if (!busyJobs) return undefined;
    const t = setInterval(res.reload, 8000);
    return () => clearInterval(t);
  }, [busyJobs]);

  if (res.loading && !res.data) return <p class="muted center">Загрузка…</p>;
  if (res.error) return <div class="card msg"><p>{res.error}</p><a class="btn wide" href="#/">К списку</a></div>;
  const { list, event, program } = res.data;
  return (
    <div class="jobs">
      <a class="back" href={"#/my/" + event.id}>← {event.title.length > 28 ? "Назад" : event.title}</a>
      <div class="card glass">
        <h1 class="page-title">Обработка на своём компьютере</h1>
        <p class="muted">Заявки, письма и списки докладов разбирает модель в LM Studio на вашем компьютере — материалы не уходят во внешние сервисы.
          Обработчик сам забирает задачи, когда компьютер включён; результат проверяется и применяется только после вашего подтверждения.</p>
        <p class={"jobs-worker " + (list.worker_seen ? "ok" : "")}>{list.worker_seen ? "Компьютер был на связи " + ago(list.worker_seen) : "Компьютер ещё не подключён"}</p>
      </div>
      <Connect toast={toast} seen={list.worker_seen} />
      <NewJob event={event} toast={toast} done={res.reload} />
      <h2 class="section-title">Задачи{list.jobs.length ? ": " + list.jobs.length : ""}</h2>
      {list.jobs.length ? list.jobs.map(j => <JobCard key={j.id} j={j} event={event} program={program} toast={toast} reload={res.reload} />)
        : <p class="muted empty">Задач пока нет</p>}
    </div>
  );
}

function Connect({ toast, seen }) {
  const keys = useLoad(async () => {
    const r = await api("GET", "/api/v1/worker-keys");
    return r.status === 200 ? r.json.keys : [];
  }, []);
  const [fresh, setFresh] = useState("");
  const [busy, setBusy] = useState(false);
  const active = (keys.data || []).filter(k => !k.revoked);
  const cmd = key => `node worker/worker.mjs --server ${location.origin} --key ${key}`;
  async function create() {
    setBusy(true);
    try {
      const r = await api("POST", "/api/v1/worker-keys", { name: "мой компьютер" });
      if (r.status !== 201) throw new Error(errorText(r));
      setFresh(r.json.key);
      keys.reload();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  }
  async function revoke(prefix) {
    if (!window.confirm("Отозвать ключ? Обработчик с этим ключом перестанет получать задачи.")) return;
    const r = await api("POST", `/api/v1/worker-keys/${prefix}/revoke`, {});
    if (r.status !== 200) return toast(errorText(r));
    toast("Ключ отозван");
    keys.reload();
  }
  return (
    <details class="card versions" open={!seen && !active.length}>
      <summary>Подключить компьютер</summary>
      <ol class="jobs-steps">
        <li>Установите Node.js 18 или новее и LM Studio, загрузите в LM Studio модель и включите сервер (порт 1234).</li>
        <li>Скачайте conf-kit: нужны папки <code>worker</code> и <code>shared</code>.</li>
        <li>Получите ключ и выполните команду в папке conf-kit. Окно можно свернуть: задачи обрабатываются, пока компьютер включён.</li>
      </ol>
      {fresh ? (
        <div class="jobs-key">
          <p class="pill warn">Ключ показывается один раз — скопируйте команду сейчас.</p>
          <pre class="extra">{cmd(fresh)}</pre>
          <button class="btn primary" onClick={() => copyText(cmd(fresh)).then(() => toast("Команда скопирована"), () => {})}>Скопировать команду</button>
        </div>
      ) : <button class="btn" disabled={busy} onClick={create}>Получить ключ обработчика</button>}
      {active.length ? (
        <ul class="ver-list">
          {active.map(k => (
            <li key={k.prefix}>
              <div><b>{k.name}</b><br /><span class="muted small">ck_{k.prefix}_… · {k.last_used ? "на связи " + ago(k.last_used) : "ещё не подключался"}</span></div>
              <button class="btn danger" onClick={() => revoke(k.prefix)}>Отозвать</button>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

function NewJob({ event, toast, done }) {
  const [kind, setKind] = useState("talks_from_text");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  function file(e) {
    const f = e.currentTarget.files && e.currentTarget.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        setText(readText(f.name, new Uint8Array(r.result)));
        if (!title) setTitle(f.name.replace(/\.\w+$/, ""));
      } catch (x) { toast(x.message); }
    };
    r.readAsArrayBuffer(f);
    e.currentTarget.value = "";
  }
  async function submit() {
    if (!text.trim()) return toast("Вставьте текст или выберите файл");
    setBusy(true);
    try {
      const r = await api("POST", `/api/v1/events/${event.id}/jobs`, { kind, title: title.trim(), note: note.trim(), text });
      if (r.status !== 201) throw new Error(r.json.message || errorText(r));
      toast("Задача поставлена в очередь");
      setText(""); setTitle(""); setNote("");
      done();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  }
  return (
    <details class="card versions">
      <summary>Новая задача</summary>
      <label class="field"><span>Что сделать</span>
        <select value={kind} onChange={e => setKind(e.currentTarget.value)}>
          {Object.keys(KIND).map(k => <option key={k} value={k}>{KIND[k]}</option>)}
        </select>
      </label>
      <p class="muted small">{kind === "program_from_text"
        ? "Из информационного письма или черновика программы получится программа целиком. При применении она заменит текущую."
        : "Из заявок или списка докладов получатся доклады без контактов — их можно добавить в выбранное заседание."}</p>
      <label class="field"><span>Название задачи</span><input value={title} onInput={e => setTitle(e.currentTarget.value)} maxlength={200} /></label>
      <label class="field"><span>Текст материалов</span>
        <textarea rows={6} value={text} onInput={e => setText(e.currentTarget.value)} placeholder="Вставьте текст или выберите файл" />
      </label>
      <label class="btn file">Файл: .docx, .txt, .md, .csv<input type="file" accept=".docx,.txt,.md,.csv" onChange={file} /></label>
      <label class="field"><span>Пожелание для модели</span><input value={note} onInput={e => setNote(e.currentTarget.value)} maxlength={1000} placeholder="Например: секцию 3 не включать" /></label>
      <button class="btn primary wide" disabled={busy} onClick={submit}>{busy ? "Отправка…" : "Поставить в очередь"}</button>
    </details>
  );
}

function JobCard({ j, event, program, toast, reload }) {
  const [full, setFull] = useState(null);
  const [busy, setBusy] = useState(false);
  const st = STATUS[j.status] || [j.status, ""];
  const sc = sessionChoices(program, full && full.result && full.result.items && full.result.items[0] ? full.result.items[0].section : 0);
  const [target, setTarget] = useState("");
  async function open() {
    if (full) return setFull(null);
    const r = await api("GET", `/api/v1/events/${event.id}/jobs/${j.id}`);
    if (r.status !== 200) return toast(errorText(r));
    setFull(r.json);
  }
  async function act(body, ok) {
    setBusy(true);
    try {
      const r = await api("POST", `/api/v1/events/${event.id}/jobs/${j.id}`, body);
      if (r.status !== 200) throw new Error(r.json.message || errorText(r));
      toast(ok(r.json));
      setFull(null);
      reload();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  }
  const apply = () => {
    if (j.kind === "program_from_text") {
      if (!window.confirm("Заменить программу результатом целиком? Текущая останется в истории версий. Оценки жюри привязаны к кодам докладов — после замены проверьте их.")) return;
      return act({ action: "apply" }, r => "Программа заменена — версия " + r.version);
    }
    const t = sc.list[target === "" ? sc.def : +target];
    return act({ action: "apply", day: t.day, session: t.session }, r => "Доклады добавлены — версия " + r.version);
  };
  const s = j.stats;
  return (
    <article class={"card job job-" + j.status}>
      <div class="app-head"><span>{KIND[j.kind] || j.kind}</span><span class={"badge job-" + j.status}>{st[0]}</span></div>
      <h3 class="app-title">{j.title}</h3>
      <p class="muted small">
        поставлена {ago(j.created)}{j.finished_at ? " · обработана " + ago(j.finished_at) : ""}{j.model ? " · " + j.model : ""}
        {j.applied_version ? " · версия " + j.applied_version : ""}
      </p>
      {s ? <p class="small">{s.items != null && s.days == null ? `Докладов: ${s.items}` : `Дней: ${s.days}, заседаний: ${s.sessions}, элементов: ${s.items}`}</p> : null}
      {j.error ? <p class="small job-error">{j.error}</p> : null}
      {full ? (
        <div class="app-panel">
          {full.result && full.result.items ? (
            <ol class="job-items">{full.result.items.map((it, i) => <li key={i}><b>{it.title}</b>{it.speaker ? " — " + it.speaker : ""}{it.section ? ", секция " + it.section : ""}</li>)}</ol>
          ) : null}
          {full.result && full.result.program ? <div class="job-program"><Program program={full.result.program} /></div> : null}
          {full.report && full.report.errors && full.report.errors.length ? (
            <ul class="job-errors">{full.report.errors.slice(0, 10).map((x, i) => <li key={i}>{x.path}: {x.message}</li>)}</ul>
          ) : null}
          {j.status === "done" && j.kind === "talks_from_text" && sc.list.length ? (
            <label class="field"><span>Заседание</span>
              <select value={target === "" ? String(sc.def) : target} onChange={e => setTarget(e.currentTarget.value)}>
                {sc.list.map((x, i) => <option key={i} value={String(i)}>{x.label}</option>)}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
      <div class="actions">
        {j.status === "done" || j.status === "failed" ? <button class="btn" onClick={open}>{full ? "Свернуть" : "Посмотреть"}</button> : null}
        {j.status === "done" && (j.kind === "program_from_text" || full) ? (
          <button class="btn primary" disabled={busy} onClick={apply}>{j.kind === "program_from_text" ? "Заменить программу" : "Добавить в заседание"}</button>
        ) : null}
        {["queued", "running", "done", "failed"].indexOf(j.status) >= 0 ? (
          <button class="btn" disabled={busy} onClick={() => act({ action: "cancel" }, () => "Задача отменена")}>Отменить</button>
        ) : null}
      </div>
    </article>
  );
}
