// Своё мероприятие: программа, публикация, соавторы, версии, выгрузка и набор для чат-бота.
import { useState } from "preact/hooks";
import { api, errorText } from "../api.js";
import { useLoad } from "../hooks.js";
import { EventHeader, Program } from "../components/Program.jsx";
import { copyText, download, shortDate } from "../util.js";
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
          <a class="btn" href={"#/create/" + event.id}>Создать по образцу</a>
          <button class="btn" onClick={() => download(event.slug + ".program.json", JSON.stringify(program, null, 2) + "\n")}>Скачать JSON</button>
          <button class="btn" onClick={() => botKit(program).then(t => copyText(t)).then(() => toast("Набор для чат-бота скопирован"), e => toast(e.message))}>
            Набор для чат-бота
          </button>
        </div>
        {invite ? <p class="muted break">Ссылка для соавтора (14 дней, одноразовая): {invite}</p> : null}
      </div>
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
