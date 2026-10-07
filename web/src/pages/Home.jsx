// Главная: вход и список своих мероприятий.
import { useState } from "preact/hooks";
import { api, errorText, login, setAuth, user } from "../api.js";
import { useLoad } from "../hooks.js";
import { dateRange } from "../util.js";

export function Home({ toast, refresh }) {
  const me = user();
  return me ? <MyEvents me={me} toast={toast} refresh={refresh} /> : <Login refresh={refresh} />;
}

function Login({ refresh }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await login(email.trim(), password);
      if (r.status !== 200) setErr(r.status === 400 ? "Неверный e-mail или пароль" : errorText(r));
      else refresh();
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  }
  return (
    <div class="card glass panel">
      <h1>Программы мероприятий</h1>
      <p class="muted">Вход для организаторов. Аккаунт появляется, когда вы принимаете ссылку-приглашение на черновик программы.</p>
      <form onSubmit={submit}>
        <label class="field"><span>E-mail</span>
          <input type="email" required value={email} onInput={e => setEmail(e.target.value)} autocomplete="email" inputmode="email" /></label>
        <label class="field"><span>Пароль</span>
          <input type="password" required value={password} onInput={e => setPassword(e.target.value)} autocomplete="current-password" /></label>
        <p class="err" role="alert">{err}</p>
        <button class="btn primary" disabled={busy}>{busy ? "Вход…" : "Войти"}</button>
      </form>
    </div>
  );
}

function MyEvents({ me, refresh }) {
  const list = useLoad(async () => {
    const filter = encodeURIComponent(`owners.id ?= "${me.id}"`);
    const r = await api("GET", `/api/collections/events/records?perPage=100&sort=-updated&filter=${filter}&fields=id,slug,title,date_from,date_to,status,version`);
    if (r.status !== 200) throw new Error(errorText(r));
    return r.json.items;
  }, [me.id]);
  return (
    <div>
      <div class="row-between">
        <h1 class="page-title">Мои мероприятия</h1>
        <button class="btn" onClick={() => { setAuth(null); refresh(); }}>Выйти</button>
      </div>
      <a class="btn primary wide" href="#/new">Создать из ответа чат-бота</a>
      {list.loading ? <p class="muted center">Загрузка…</p> : list.error ? <p class="err">{list.error}</p> : (
        list.data.length ? (
          <ul class="ev-list">
            {list.data.map(ev => (
              <li key={ev.id}>
                <a class="card ev-row" href={"#/my/" + ev.id}>
                  <b>{ev.title}</b>
                  <span class="muted">{dateRange(ev.date_from, ev.date_to)}</span>
                  <span class={"badge " + ev.status}>{ev.status === "published" ? "опубликовано" : "черновик"} · версия {ev.version}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : <p class="muted center">Мероприятий пока нет. Попросите чат-бот собрать программу или откройте ссылку-приглашение.</p>
      )}
    </div>
  );
}
