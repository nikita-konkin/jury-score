// Ссылка-приглашение: предпросмотр черновика и вход в аккаунт (новый или существующий).
import { useState } from "preact/hooks";
import { api, errorText, login, setAuth, user } from "../api.js";
import { go, useLoad } from "../hooks.js";
import { EventHeader, Program } from "../components/Program.jsx";
import { shortDate } from "../util.js";

export function Claim({ token, toast }) {
  const res = useLoad(async () => {
    const r = await api("GET", "/api/v1/claim/" + encodeURIComponent(token));
    if (r.status !== 200) throw new Error(r.status === 410 ? "Срок приглашения истёк — попросите новую ссылку у того, кто её прислал"
      : r.status === 404 ? "Приглашение не найдено или уже использовано" : errorText(r));
    return r.json;
  }, [token]);
  const [mode, setMode] = useState(user() ? "me" : "new");
  const [form, setForm] = useState({ email: "", password: "", name: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const me = user();

  const set = k => e => setForm(Object.assign({}, form, { [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (mode === "login") {
        const l = await login(form.email.trim(), form.password);
        if (l.status !== 200) { setErr("Неверный e-mail или пароль"); return; }
      }
      const body = mode === "new" ? { email: form.email.trim(), password: form.password, name: form.name.trim() } : undefined;
      const r = await api("POST", "/api/v1/claim/" + encodeURIComponent(token), body);
      if (r.status !== 200) { setErr(errorText(r)); return; }
      setAuth(r.json.token, r.json.record);
      toast("Мероприятие в вашем аккаунте");
      go("/my/" + r.json.meta.event.id);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  if (res.loading) return <p class="muted center">Загрузка…</p>;
  if (res.error) return <div class="card msg"><h2>Приглашение</h2><p>{res.error}</p><a class="btn wide" href="#/">На главную</a></div>;
  const d = res.data;
  const st = d.program.days.reduce((n, x) => n + x.sessions.reduce((m, s) => m + s.items.length, 0), 0);

  return (
    <div>
      <div class="card claim glass">
        <p class="kicker">{d.co_owner ? "Приглашение в соавторы" : "Готовый черновик программы"}</p>
        <EventHeader program={d.program} />
        <p class="muted">
          {d.prepared_by ? <span>Подготовил: {d.prepared_by}. </span> : null}
          Элементов программы: {st}. Ссылка действует до {shortDate(d.invite_expires)}.
        </p>
        <form onSubmit={submit} class="claim-form">
          {me ? (
            <div class="seg">
              <button type="button" class={mode === "me" ? "on" : ""} onClick={() => setMode("me")}>Мой аккаунт</button>
              <button type="button" class={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>Новый</button>
            </div>
          ) : (
            <div class="seg">
              <button type="button" class={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>Новый аккаунт</button>
              <button type="button" class={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>У меня есть</button>
            </div>
          )}
          {mode === "me" ? <p class="muted">Принять в аккаунт <b>{me.email}</b>.</p> : (
            <div>
              {mode === "new" ? (
                <label class="field"><span>Имя</span><input value={form.name} onInput={set("name")} autocomplete="name" /></label>
              ) : null}
              <label class="field"><span>E-mail</span>
                <input type="email" required value={form.email} onInput={set("email")} autocomplete="email" inputmode="email" /></label>
              <label class="field"><span>{mode === "new" ? "Пароль (не короче 8 символов)" : "Пароль"}</span>
                <input type="password" required minlength={mode === "new" ? 8 : 1} value={form.password} onInput={set("password")}
                  autocomplete={mode === "new" ? "new-password" : "current-password"} /></label>
            </div>
          )}
          <p class="err" role="alert">{err}</p>
          <button class="btn primary" disabled={busy}>{busy ? "Подождите…" : d.co_owner ? "Стать соавтором" : "Забрать черновик"}</button>
        </form>
      </div>
      <h2 class="section-title">Предпросмотр</h2>
      <Program program={d.program} />
    </div>
  );
}
