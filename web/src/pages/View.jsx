// Программа для участников (#/e/<адрес>) и предпросмотр черновика (#/preview/<токен>).
// «Сейчас / далее», поиск и фильтры, календарь, обновление без перезагрузки, копия на случай без связи.
import { useState, useEffect } from "preact/hooks";
import { api, errorText } from "../api.js";
import { EventHeader, Program, Item } from "../components/Program.jsx";
import { copyText, dayLabel, plural } from "../util.js";
import { nowIn, nowNext, todayIndex, searchItems, facets, readCache, writeCache, watchEvent, itemState } from "../public/live.js";

const FORMAT_LABEL = { oral: "очно", online: "онлайн", poster: "стенд" };

export function View({ url, preview, toast }) {
  const cacheKey = preview ? "" : url;
  const [data, setData] = useState(() => {
    const c = cacheKey ? readCache(cacheKey) : null;
    return c ? c.data : null;
  });
  const [offline, setOffline] = useState(0); // время копии, если сервер недоступен
  const [err, setErr] = useState("");
  const [, setClock] = useState(0);
  const [q, setQ] = useState("");
  const [f, setF] = useState({ section: "", room: "", format: "" });
  const [showF, setShowF] = useState(false);

  function load(notify) {
    return api("GET", url).then(r => {
      if (r.status !== 200) {
        setData(null);
        setErr(r.status === 404 ? (preview ? "Ссылка предпросмотра не найдена" : "Программа не найдена или ещё не опубликована") : errorText(r));
        return;
      }
      setData(r.json);
      setErr("");
      setOffline(0);
      if (cacheKey) writeCache(cacheKey, r.json);
      if (notify && toast) toast("Программа обновлена");
    }, e => {
      const c = cacheKey ? readCache(cacheKey) : null;
      if (c) setOffline(c.at); else setErr(e.message);
    });
  }
  useEffect(() => { load(false); }, [url]);
  // часы для «сейчас / далее»
  useEffect(() => {
    const t = setInterval(() => setClock(n => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  // изменения программы приходят сами
  const evId = data && data.event ? data.event.id : "";
  useEffect(() => {
    if (preview || !evId) return undefined;
    return watchEvent(evId, data.event, () => load(true));
  }, [evId]);

  if (err) return <div class="card msg"><p>{err}</p></div>;
  if (!data) return <p class="muted center">Загрузка…</p>;
  const program = data.program;
  const ev = data.event || {};
  const now = nowIn(program.event.timezone);
  const nn = nowNext(program, now);
  const fac = facets(program);
  const active = q.trim() || f.section || f.room || f.format;
  const pageUrl = location.origin + location.pathname + "#/e/" + (ev.slug || "");
  const icsPath = "/api/v1/events/" + (ev.slug || ev.id) + "/program.ics";
  const action = preview ? null : it => (
    <a class="btn" href={icsPath + "?item=" + encodeURIComponent(it.code)}>В календарь</a>
  );
  const setFilter = k => e => { const v = e.currentTarget.value; setF(prev => Object.assign({}, prev, { [k]: v })); };

  function share() {
    if (navigator.share) navigator.share({ title: program.event.title, url: pageUrl }).catch(() => {});
    else copyText(pageUrl).then(() => toast && toast("Ссылка скопирована"));
  }

  return (
    <div>
      {preview ? <p class="pill warn">Черновик — предпросмотр, программа ещё может измениться</p> : null}
      {offline ? <p class="pill warn">Нет связи — показана сохранённая копия от {new Date(offline).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}</p> : null}
      <div class="card glass">
        <EventHeader program={program} />
        {preview ? null : (
          <div>
            <div class="actions">
              {applyOpen(program.event, ev.slug) ? <a class="btn primary" href={"#/apply/" + ev.slug}>Подать заявку на доклад</a> : null}
              <button class="btn" onClick={share}>Поделиться</button>
              <a class="btn" href={"webcal://" + location.host + icsPath}>В календарь</a>
            </div>
            <p class="muted small cal-note">Подписка в календаре обновляется сама. <a href={icsPath} download={(ev.slug || "program") + ".ics"}>Скачать файл .ics</a> · <a href={"#/print/" + ev.slug + "/program"}>Версия для печати</a></p>
          </div>
        )}
      </div>
      <NowNext nn={nn} />
      <div class="search">
        <input type="search" aria-label="Поиск по программе" placeholder="Доклад, докладчик, организация" value={q}
          onInput={e => setQ(e.currentTarget.value)} />
        <button class={"btn" + (f.section || f.room || f.format ? " on" : "")} aria-expanded={showF} onClick={() => setShowF(!showF)}>Фильтры</button>
      </div>
      {showF ? (
        <div class="card filters">
          {program.sections.length ? (
            <label class="field"><span>Секция</span>
              <select value={f.section} onChange={setFilter("section")}>
                <option value="">все</option>
                {program.sections.map(s => <option key={s.no} value={String(s.no)}>{s.no}. {s.title}</option>)}
              </select>
            </label>
          ) : null}
          {fac.rooms.length > 1 ? (
            <label class="field"><span>Зал</span>
              <select value={f.room} onChange={setFilter("room")}>
                <option value="">все</option>
                {fac.rooms.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          ) : null}
          {fac.formats.length > 1 ? (
            <label class="field"><span>Форма участия</span>
              <select value={f.format} onChange={setFilter("format")}>
                <option value="">любая</option>
                {fac.formats.map(x => <option key={x} value={x}>{FORMAT_LABEL[x] || x}</option>)}
              </select>
            </label>
          ) : null}
          {active ? <button class="btn wide" onClick={() => { setQ(""); setF({ section: "", room: "", format: "" }); }}>Сбросить</button> : null}
        </div>
      ) : null}
      {active ? <Results list={searchItems(program, q, f)} program={program} now={now} action={action} />
        : <Program key={program.event.title} program={program} now={now} initialDay={todayIndex(program, now)} action={action} />}
    </div>
  );
}

function NowNext({ nn }) {
  if (!nn) return null;
  if (nn.before != null) {
    return nn.before <= 60 ? <p class="card nownext muted">До начала {nn.before} {plural(nn.before, "день", "дня", "дней")}</p> : null;
  }
  if (nn.over) return <p class="card nownext muted">Программа на сегодня завершена</p>;
  const row = x => (
    <li key={x.si + "-" + x.ii}>
      <span class="nn-time">{x.item.start}</span>
      <span class="nn-body"><b>{x.item.title}</b>
        <span class="muted">{[x.item.speaker, x.room].filter(Boolean).join(" · ")}</span></span>
    </li>
  );
  return (
    <div class="card glass nownext">
      {nn.now.length ? <div><div class="kicker">Сейчас</div><ul>{nn.now.map(row)}</ul></div> : null}
      {nn.next.length ? <div><div class="kicker">Далее</div><ul>{nn.next.map(row)}</ul></div> : null}
    </div>
  );
}

function Results({ list, program, now, action }) {
  const sections = {};
  program.sections.forEach(s => { sections[s.no] = s; });
  if (!list.length) return <p class="muted empty">Ничего не найдено</p>;
  const groups = [];
  list.forEach(x => {
    const g = groups.length && groups[groups.length - 1].di === x.di ? groups[groups.length - 1] : null;
    if (g) g.items.push(x); else groups.push({ di: x.di, day: x.day, items: [x] });
  });
  return (
    <div>
      <p class="muted found">Найдено: {list.length}</p>
      {groups.map(g => (
        <section key={g.di} class="card session">
          <div class="ses-head"><h3>{dayLabel(g.day.date)}</h3></div>
          <ul class="items">
            {g.items.map(x => <Item key={x.si + "-" + x.ii} it={Object.assign({}, x.item, { room: x.item.room || x.session.room })}
              sections={sections} action={action} state={itemState(g.day, x.item, now)} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}


/** Открыт ли приём заявок (точную проверку делает сервер на странице формы). */
function applyOpen(info, slug) {
  const ap = info.applications;
  if (!ap || ap.enabled === false || !slug) return false;
  return !ap.deadline || nowIn(info.timezone).date <= ap.deadline;
}
