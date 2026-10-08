// Заявка на доклад (#/apply/<адрес>) и своя заявка по ссылке (#/apply/<адрес>/<токен>).
// Аккаунт не нужен: после отправки участник получает ссылку на заявку — по ней виден статус и можно отозвать заявку.
import { useState, useRef } from "preact/hooks";
import { api } from "../api.js";
import { useLoad } from "../hooks.js";
import { copyText, dateRange } from "../util.js";

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* приватный режим */ } },
};
const MINE = "conf_apply_mine";
const EMPTY = { speaker: "", authors: "", title: "", section: "", format: "oral", org: "", city: "", email: "", phone: "", note: "" };
export const APP_STATUS = { new: ["на рассмотрении", ""], accepted: ["принята", "ok"], rejected: ["отклонена", "err"], withdrawn: ["отозвана", "muted"] };
const FORMAT = { oral: "очно", online: "онлайн", poster: "стендовый" };

export function Apply({ slug, token, toast }) {
  return token ? <MyApplication slug={slug} token={token} toast={toast} /> : <ApplyForm slug={slug} toast={toast} />;
}

function ApplyForm({ slug, toast }) {
  const info = useLoad(async () => {
    const r = await api("GET", `/api/apply/${encodeURIComponent(slug)}`);
    if (r.status === 404) throw new Error("Мероприятие не найдено");
    if (!r.json.ok) throw new Error(r.json.message || "Не удалось загрузить форму");
    return r.json;
  }, [slug]);
  const kDraft = "conf_apply_draft_" + slug;
  const [form, setForm] = useState(() => Object.assign({}, EMPTY, LS.get(kDraft, {})));
  const [trap, setTrap] = useState("");
  const [consent, setConsent] = useState(false);
  const [err, setErr] = useState({ field: "", message: "" });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const shown = useRef(Date.now());
  const mine = LS.get(MINE, []).filter(x => x.slug === slug);

  if (info.loading) return <p class="muted center">Загрузка…</p>;
  if (info.error) return <div class="card msg"><p>{info.error}</p></div>;
  const d = info.data;
  const head = (
    <div>
      <div class="kicker">Заявка на доклад</div>
      <h1>{d.title}</h1>
      <p class="muted">{[dateRange(d.date_from, d.date_to), d.city, d.venue].filter(Boolean).join(" · ")}</p>
    </div>
  );
  const mineList = mine.length ? (
    <div class="card">
      <b>Ваши заявки с этого устройства</b>
      <ul class="plain">{mine.map(x => <li key={x.token}><a href={`#/apply/${slug}/${x.token}`}>№{x.no} — {x.title}</a></li>)}</ul>
    </div>
  ) : null;

  if (done) {
    return (
      <div class="card glass panel apply-done">
        {head}
        <h2 class="apply-ok">✓ Заявка{done.no ? " №" + done.no : ""} отправлена</h2>
        <p>Оргкомитет рассмотрит её и примет решение. Статус заявки — по ссылке ниже. Сохраните её: по ней же заявку можно отозвать.</p>
        {done.url ? <p class="break small apply-link">{done.url}</p> : null}
        <div class="actions">
          {done.url ? <button class="btn primary" onClick={() => copyText(done.url).then(() => toast && toast("Ссылка скопирована"), () => {})}>Скопировать ссылку</button> : null}
          {done.token ? <a class="btn" href={`#/apply/${slug}/${done.token}`}>Открыть заявку</a> : null}
          <button class="btn" onClick={() => { setDone(null); setForm(Object.assign({}, EMPTY)); setConsent(false); shown.current = Date.now(); }}>Ещё одна заявка</button>
        </div>
      </div>
    );
  }
  if (!d.open) {
    return (
      <div>
        <div class="card glass panel">{head}<p class="pill warn">{d.reason}</p></div>
        {mineList}
      </div>
    );
  }

  const set = k => e => {
    const next = Object.assign({}, form, { [k]: e.currentTarget.value });
    setForm(next);
    LS.set(kDraft, next);
    if (err.field === k) setErr({ field: "", message: "" });
  };
  const field = (k, label, input, hint) => (
    <label class={"field" + (err.field === k ? " bad" : "")}>
      <span>{label}</span>
      {input}
      {err.field === k ? <small class="hint bad-text" role="alert">{err.message}</small> : hint ? <small class="hint">{hint}</small> : null}
    </label>
  );

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr({ field: "", message: "" });
    try {
      const body = Object.assign({}, form, { section: form.section ? +form.section : "", consent: consent, website: trap, elapsed: Date.now() - shown.current });
      const r = await api("POST", `/api/apply/${encodeURIComponent(slug)}`, body);
      if (r.status === 201 && r.json.ok) {
        LS.del(kDraft);
        if (r.json.token) LS.set(MINE, LS.get(MINE, []).concat([{ slug, token: r.json.token, no: r.json.no, title: form.title.trim() }]).slice(-20));
        setDone(r.json);
        window.scrollTo(0, 0);
        return;
      }
      setErr({ field: r.json.field || "", message: r.json.message || "Не удалось отправить заявку" });
      const el = r.json.field && document.getElementById("ap-" + r.json.field);
      if (el) el.focus();
    } catch (x) {
      setErr({ field: "", message: x.message + ". Заполненные поля сохранены — отправьте ещё раз." });
    } finally { setBusy(false); }
  }

  return (
    <div>
      <form class="card glass apply-form" onSubmit={submit} novalidate>
        {head}
        {d.note ? <p class="apply-note">{d.note}</p> : null}
        {d.deadline ? <p class="muted small">Заявки принимаются до {d.deadline.split("-").reverse().join(".")} включительно.</p> : null}
        {field("speaker", "Докладчик — фамилия и инициалы *",
          <input id="ap-speaker" value={form.speaker} onInput={set("speaker")} autocomplete="name" maxlength={200} />)}
        {field("authors", "Авторы", <textarea id="ap-authors" class="auto" rows={2} value={form.authors} onInput={set("authors")} />,
          "По одному в строке, вместе с докладчиком. Пусто — только докладчик")}
        {field("title", "Название доклада *", <textarea id="ap-title" class="auto" rows={3} value={form.title} onInput={set("title")} maxlength={600} />)}
        {d.sections.length ? field("section", "Секция *", (
          <select id="ap-section" value={form.section} onChange={set("section")}>
            <option value="">— выберите —</option>
            {d.sections.map(s => <option key={s.no} value={String(s.no)}>{s.no}. {s.title}</option>)}
          </select>
        )) : null}
        {field("format", "Форма участия", (
          <select id="ap-format" value={form.format} onChange={set("format")}>
            {d.formats.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        ))}
        {field("org", "Организация", <input id="ap-org" value={form.org} onInput={set("org")} autocomplete="organization" maxlength={300} />)}
        {field("city", "Город", <input id="ap-city" value={form.city} onInput={set("city")} maxlength={100} />)}
        {field("email", "E-mail для связи *", <input id="ap-email" type="email" inputmode="email" autocomplete="email" value={form.email} onInput={set("email")} maxlength={200} />,
          "Не публикуется")}
        {field("phone", "Телефон", <input id="ap-phone" type="tel" autocomplete="tel" value={form.phone} onInput={set("phone")} maxlength={40} />, "Не публикуется")}
        {field("note", "Комментарий для оргкомитета", <textarea id="ap-note" class="auto" rows={2} value={form.note} onInput={set("note")} maxlength={2000} />)}
        <div class="hp" aria-hidden="true">
          <label>Сайт<input tabIndex={-1} autocomplete="off" value={trap} onInput={e => setTrap(e.currentTarget.value)} /></label>
        </div>
        <p class="consent">{d.consent}</p>
        <label class={"check" + (err.field === "consent" ? " bad" : "")}>
          <input id="ap-consent" type="checkbox" checked={consent} onChange={e => { setConsent(e.currentTarget.checked); if (err.field === "consent") setErr({ field: "", message: "" }); }} />
          <span>Согласен(на) на обработку персональных данных на этих условиях</span>
        </label>
        <p class="err" role="alert">{err.message}</p>
        <button class="btn primary wide" disabled={busy}>{busy ? "Отправка…" : "Отправить заявку"}</button>
      </form>
      {mineList}
    </div>
  );
}

function MyApplication({ slug, token, toast }) {
  const res = useLoad(async () => {
    const r = await api("GET", `/api/apply/${encodeURIComponent(slug)}/${encodeURIComponent(token)}`);
    if (!r.json || !r.json.ok) throw new Error((r.json && r.json.message) || "Заявка не найдена");
    return r.json;
  }, [slug, token]);
  const [busy, setBusy] = useState(false);
  if (res.loading) return <p class="muted center">Загрузка…</p>;
  if (res.error) return <div class="card msg"><p>{res.error}</p><a class="btn wide" href={"#/apply/" + slug}>К форме заявки</a></div>;
  const a = res.data.application;
  const st = APP_STATUS[a.status] || [a.status, ""];

  async function withdraw() {
    if (!window.confirm("Отозвать заявку? Оргкомитет увидит, что вы отказались от доклада. Ваши e-mail и телефон будут удалены сразу.")) return;
    setBusy(true);
    try {
      const r = await api("POST", `/api/apply/${encodeURIComponent(slug)}/${encodeURIComponent(token)}`, { action: "withdraw" });
      if (!r.json.ok) throw new Error(r.json.message || "Не удалось отозвать заявку");
      toast && toast("Заявка отозвана");
      res.reload();
    } catch (e) { toast && toast(e.message); } finally { setBusy(false); }
  }
  const rows = [
    ["Докладчик", a.speaker], ["Авторы", a.authors.join(", ")], ["Доклад", a.title], ["Секция", a.section ? String(a.section) : ""],
    ["Форма участия", FORMAT[a.format] || a.format], ["Организация", a.org], ["Город", a.city], ["E-mail", a.email], ["Телефон", a.phone],
  ].filter(r => r[1]);
  return (
    <div class="card glass apply-mine">
      <div class="kicker">{res.data.event.title}</div>
      <h1>Заявка №{a.no}</h1>
      <p><span class={"badge app-" + a.status}>{st[0]}</span> <span class="muted small">подана {new Date(a.created.replace(" ", "T")).toLocaleDateString("ru-RU")}</span></p>
      {a.status === "accepted" ? <p class="apply-ok">Доклад включён в программу.</p> : null}
      {a.status === "rejected" && a.reason ? <p class="pill warn">Причина: {a.reason}</p> : null}
      {a.status === "withdrawn" ? <p class="muted">Вы отозвали заявку, контакты удалены.</p> : null}
      <dl class="apply-dl">{rows.map(r => [<dt key={"t" + r[0]}>{r[0]}</dt>, <dd key={"d" + r[0]}>{r[1]}</dd>])}</dl>
      <div class="actions">
        {a.status === "accepted" ? <a class="btn" href={"#/e/" + res.data.event.slug}>Программа</a> : null}
        {a.status !== "withdrawn" ? <button class="btn danger" disabled={busy} onClick={withdraw}>Отозвать заявку</button> : null}
      </div>
    </div>
  );
}
