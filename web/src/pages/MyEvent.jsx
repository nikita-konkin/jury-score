// Своё мероприятие: программа, публикация, соавторы, версии, выгрузка и набор для чат-бота.
import { useState } from "preact/hooks";
import { api, errorText } from "../api.js";
import { useLoad } from "../hooks.js";
import { EventHeader, Program } from "../components/Program.jsx";
import { copyText, download, plural, shortDate } from "../util.js";
import { botKit } from "./FromJson.jsx";

const SOURCE = { ui: "интерфейс", api: "API", mcp: "MCP", import: "импорт" };

export function MyEvent({ id, toast }) {
  const res = useLoad(async () => {
    const r = await api("GET", `/api/v1/events/${encodeURIComponent(id)}/program`);
    if (r.status !== 200) throw new Error(r.status === 404 ? "Мероприятие не найдено или нет доступа" : errorText(r));
    return r.json;
  }, [id]);
  const versions = useLoad(async () => {
    const f = encodeURIComponent(`event="${id}"`);
    const r = await api("GET", `/api/collections/program_versions/records?perPage=50&sort=-no&filter=${f}&fields=id,no,source,note,created,stats`);
    return r.status === 200 ? r.json.items : [];
  }, [id]);
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);

  if (res.loading) return <p class="muted center">Загрузка…</p>;
  if (res.error) return <div class="card msg"><p>{res.error}</p><a class="btn wide" href="#/">К списку</a></div>;
  const { event, program } = res.data;
  const published = event.status === "published";
  const publicUrl = location.origin + location.pathname + "#/e/" + event.slug;

  async function act(fn) {
    setBusy(true);
    try { await fn(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  }
  const togglePublish = () => act(async () => {
    const r = await api("POST", `/api/v1/events/${event.id}/${published ? "unpublish" : "publish"}`);
    if (r.status !== 200) throw new Error(errorText(r));
    toast(published ? "Снято с публикации" : "Опубликовано");
    res.reload();
  });
  const coInvite = () => act(async () => {
    const r = await api("POST", `/api/v1/events/${event.id}/invite`);
    if (r.status !== 200) throw new Error(errorText(r));
    setInvite(r.json.invite_url);
    await copyText(r.json.invite_url).catch(() => {});
    toast("Ссылка для соавтора скопирована");
  });

  return (
    <div>
      <a class="back" href="#/">← Мои мероприятия</a>
      <div class="card glass">
        <EventHeader program={program} />
        <p class="muted">
          <span class={"badge " + event.status}>{published ? "опубликовано" : "черновик"}</span> · версия {event.version} · адрес: {event.slug}
        </p>
        <div class="actions">
          <a class="btn primary" href={"#/edit/" + event.id}>Редактировать программу</a>
          <button class="btn" disabled={busy} onClick={togglePublish}>{published ? "Снять с публикации" : "Опубликовать"}</button>
          {published ? <button class="btn" onClick={() => copyText(publicUrl).then(() => toast("Ссылка на программу скопирована"))}>Ссылка для участников</button> : null}
          <button class="btn" disabled={busy} onClick={coInvite}>Пригласить соавтора</button>
          <a class="btn" href={"#/print/" + event.id + "/program"}>Документы для печати</a>
          <a class="btn" href={"#/create/" + event.id}>Создать по образцу</a>
          <button class="btn" onClick={() => download(event.slug + ".program.json", JSON.stringify(program, null, 2) + "\n")}>Скачать JSON</button>
          <button class="btn" onClick={() => botKit(program).then(t => copyText(t)).then(() => toast("Набор для чат-бота скопирован"), e => toast(e.message))}>
            Набор для чат-бота
          </button>
        </div>
        {invite ? <p class="muted break">Ссылка для соавтора (14 дней, одноразовая): {invite}</p> : null}
      </div>
      <AppsPanel event={event} program={program} />
      <JuryPanel event={event} toast={toast} />
      <Program program={program} />
      {versions.data && versions.data.length ? (
        <details class="card versions">
          <summary>История версий ({versions.data.length})</summary>
          <ul>
            {versions.data.map(v => (
              <li key={v.id}>
                <b>№{v.no}</b> {shortDate(v.created)} · {SOURCE[v.source] || v.source}
                {v.stats ? ` · элементов: ${v.stats.items}` : ""}{v.note ? ` · ${v.note}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** Конкурс докладов: коды комиссии, ссылка для экспертов, новые коды, итоги. */
function JuryPanel({ event, toast }) {
  const jury = useLoad(async () => {
    const r = await api("GET", `/api/v1/events/${event.id}/jury`);
    if (r.status !== 200) throw new Error(errorText(r));
    return r.json;
  }, [event.id, event.version]);
  const [busy, setBusy] = useState(false);
  if (jury.loading || jury.error || !jury.data) return null;
  const j = jury.data;
  if (!j.enabled) {
    return (
      <details class="card versions">
        <summary>Конкурс докладов: выключен</summary>
        <p class="muted small">Чтобы эксперты могли оценивать доклады, задайте критерии оценки: «Редактировать программу» → «Мероприятие» → «Критерии жюри».</p>
      </details>
    );
  }
  const link = j.url + "/" + j.juror_code;
  async function reset(which) {
    const what = which === "juror" ? "код экспертов" : "код администратора";
    if (!window.confirm(`Выпустить новый ${what}? Старый перестанет работать, всем, кто им пользуется, придётся войти заново. Оценки сохранятся.`)) return;
    setBusy(true);
    try {
      const r = await api("POST", `/api/v1/events/${event.id}/jury`, { reset: which });
      if (r.status !== 200) throw new Error(errorText(r));
      toast("Новый " + what + " выпущен");
      jury.reload();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  }
  return (
    <details class="card versions jury-panel">
      <summary>Конкурс докладов: {j.talks} {plural(j.talks, "доклад", "доклада", "докладов")}, {j.jurors} {plural(j.jurors, "эксперт", "эксперта", "экспертов")}</summary>
      <p class="muted small">Эксперты входят по ссылке без аккаунта: вводят фамилию и код. Код администратора даёт итоги всех экспертов и удаление ошибочных оценок. Вам код не нужен — вы видите итоги как владелец.</p>
      <div class="jury-codes">
        <div><span>Код экспертов</span><code>{j.juror_code}</code></div>
        <div><span>Код администратора</span><code>{j.admin_code}</code></div>
      </div>
      <div class="actions">
        <button class="btn primary" onClick={() => copyText(link).then(() => toast("Ссылка для экспертов скопирована"), () => toast(link))}>Ссылка для экспертов</button>
        <a class="btn" href={"#/jury/" + event.slug}>Итоги</a>
        <a class="btn" href={"#/print/" + event.id + "/results"}>Итоги и дипломы для печати</a>
        <button class="btn" disabled={busy} onClick={() => reset("juror")}>Новый код экспертов</button>
        <button class="btn" disabled={busy} onClick={() => reset("admin")}>Новый код администратора</button>
      </div>
    </details>
  );
}

/** Заявки на доклады: сколько новых, переход к модерации. */
function AppsPanel({ event, program }) {
  const apps = useLoad(async () => {
    const r = await api("GET", `/api/v1/events/${event.id}/applications`);
    return r.status === 200 ? r.json : null;
  }, [event.id, event.version]);
  const d = apps.data;
  if (!d || (!program.event.applications && !d.applications.length)) return null;
  const fresh = d.applications.filter(a => a.status === "new").length;
  return (
    <a class="card btn-card" href={"#/applications/" + event.id}>
      <b>Заявки на доклады: {d.applications.length}{fresh ? `, новых ${fresh}` : ""}</b>
      <span class="muted small">{d.open ? "Приём открыт" + (d.deadline ? " до " + d.deadline.split("-").reverse().join(".") : "") : d.reason}</span>
    </a>
  );
}
