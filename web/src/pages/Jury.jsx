// Оценка докладов жюри (#/jury/<адрес>[/<код>]) — перенос jury-score на conf-kit.
// Эксперт вводит фамилию и код комиссии; оценки сразу пишутся на телефоне и уходят на сервер очередью.
// Администратор (код администратора или владелец мероприятия) видит итоги всех экспертов.
import { useState, useEffect, useRef } from "preact/hooks";
import { api } from "../api.js";
import { download, plural } from "../util.js";
import { createQueue } from "../jury/queue.js";
import { normRec, filled, isComplete, isDone, sumOf, groupRows, computeResults, rankRows, jurorStats, stats, csvRank, csvRaw, norm } from "../jury/results.js";

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* приватный режим */ } },
};
const ERR = {
  bad_code: "Неверный код комиссии",
  jury_disabled: "Оценка докладов для этого мероприятия выключена",
  not_found: "Мероприятие не найдено",
  forbidden: "Код не даёт прав администратора",
};
const FORMAT = { oral: "очно", online: "онлайн", poster: "стенд" };
const fmtNum = x => (x == null || isNaN(x) ? "—" : (Math.round(x * 100) / 100).toLocaleString("ru-RU"));
const hhmm = d => (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();

function juryApi(slug, method, params, body) {
  const url = `/api/jury/${encodeURIComponent(slug)}` + (params ? "?" + Object.keys(params).map(k => k + "=" + encodeURIComponent(params[k] || "")).join("&") : "");
  return api(method, url, body).then(r => (r.status === 404 ? { ok: false, error: "not_found" } : r.json));
}

export function Jury({ slug, code, toast }) {
  const kSess = "conf_jury_" + slug, kInfo = "conf_jury_info_" + slug;
  const [sess, setSess] = useState(() => LS.get(kSess, null));
  const [info, setInfo] = useState(() => LS.get(kInfo, null));
  const enter = (s, i) => {
    if (i) { LS.set(kInfo, i); setInfo(i); }
    LS.set(kSess, s);
    setSess(s);
    // код из ссылки не оставляем в адресной строке: её могут переслать или показать на экране
    if (code) { try { history.replaceState(null, "", "#/jury/" + slug); } catch (e) { /* старый браузер */ } }
  };
  if (!sess || !info) return <Login slug={slug} linkCode={code} cached={info} prev={sess} enter={enter} />;
  return <JuryApp key={slug + norm(sess.juror)} slug={slug} sess={sess} info={info} toast={toast}
    setInfo={i => { LS.set(kInfo, i); setInfo(i); }}
    setRole={role => enter(Object.assign({}, sess, { role }))}
    logout={() => { LS.del(kSess); setSess(null); }} />;
}

function withIdx(res) {
  return { title: res.title, criteria: res.criteria, scaleMax: res.scaleMax, sections: res.sections || [],
    talks: (res.talks || []).map((t, i) => Object.assign({ idx: i }, t)) };
}

function Login({ slug, linkCode, cached, prev, enter }) {
  const [juror, setJuror] = useState(prev ? prev.juror : "");
  const [code, setCode] = useState(linkCode || (prev ? prev.code : ""));
  const [err, setErr] = useState("");
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    const name = juror.replace(/\s+/g, " ").trim();
    if (!name) return setErr("Введите фамилию и инициалы");
    setBusy(true); setErr(""); setOffline(false);
    try {
      const r = await juryApi(slug, "GET", { action: "ping", code: code.trim(), juror: name });
      if (!r || !r.ok) setErr(ERR[r && r.error] || "Не удалось войти");
      else enter({ juror: name, code: code.trim(), role: r.role }, withIdx(r));
    } catch (x) {
      setErr("Нет связи с сервером");
      setOffline(!!cached);
    } finally { setBusy(false); }
  }
  return (
    <form class="card glass panel jury-login" onSubmit={submit}>
      <div class="kicker">Конкурс докладов</div>
      <h1>{cached ? cached.title : "Оценка докладов"}</h1>
      <p class="muted">Введите фамилию и код комиссии из письма организатора. Аккаунт не нужен: оценки сохраняются на телефоне и отправляются сами.</p>
      <label class="field"><span>Эксперт (фамилия и инициалы)</span><input value={juror} onInput={e => setJuror(e.currentTarget.value)} autocomplete="name" maxlength={100} /></label>
      <label class="field"><span>Код комиссии</span><input value={code} onInput={e => setCode(e.currentTarget.value)} autocomplete="off" autocapitalize="none" spellcheck={false} /></label>
      <p class="err">{err}</p>
      <button class="btn primary" disabled={busy}>{busy ? "Проверка…" : "Войти"}</button>
      {offline ? <button type="button" class="btn wide" onClick={() => enter({ juror: juror.trim(), code: code.trim(), role: (prev && prev.role) || "juror" })}>Войти без связи</button> : null}
    </form>
  );
}

function JuryApp({ slug, sess, info, toast, setInfo, setRole, logout }) {
  const nc = info.criteria.length, smax = info.scaleMax, maxTotal = nc * smax;
  const [, setTick] = useState(0);
  const [tab, setTab] = useState("rate");
  const [filter, setFilter] = useState(() => LS.get("conf_jury_filter_" + slug, "all"));
  const [open, setOpen] = useState("");
  const qRef = useRef(null);
  if (!qRef.current) {
    const url = `/api/jury/${encodeURIComponent(slug)}`;
    qRef.current = createQueue({
      slug, juror: sess.juror, code: sess.code, nc, smax,
      post: body => api("POST", url, body).then(r => r.json),
      beacon: body => !!(navigator.sendBeacon && navigator.sendBeacon(url, JSON.stringify(body))),
      onChange: () => setTick(n => n + 1),
    });
  }
  const q = qRef.current;
  const admin = sess.role === "admin";

  useEffect(() => {
    q.flush();
    // свежий список докладов и свои оценки с сервера; без связи работаем с тем, что на телефоне
    juryApi(slug, "GET", { action: "ping", code: sess.code, juror: sess.juror }).then(r => {
      if (r && r.ok) { setInfo(withIdx(r)); if (r.role !== sess.role) setRole(r.role); }
      else if (r && r.error === "bad_code") { q.fatal = "bad_code"; setTick(n => n + 1); }
    }, () => {});
    juryApi(slug, "GET", { action: "mine", code: sess.code, juror: sess.juror }).then(r => { if (r && r.ok) q.merge(r.rows); }, () => {});
    const onOnline = () => q.flush();
    const onVis = () => (document.hidden ? q.beacon() : q.flush());
    const onHide = () => q.beacon();
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onHide);
      q.close();
    };
  }, []);

  const sections = info.sections.filter(s => info.talks.some(t => t.section === s.no));
  // выбранная секция могла исчезнуть из программы — тогда показываем все доклады
  const f = filter !== "all" && sections.some(s => String(s.no) === String(filter)) ? String(filter) : "all";
  const known = {};
  sections.forEach(s => { known[s.no] = 1; });
  const groups = (f === "all" ? sections : sections.filter(s => String(s.no) === f))
    .map(s => ({ s, talks: info.talks.filter(t => t.section === s.no) }));
  const rest = f === "all" ? info.talks.filter(t => !known[t.section]) : [];
  if (rest.length) groups.push({ s: sections.length ? { no: 0, title: "Без секции" } : null, talks: rest });
  const list = [];
  groups.forEach(g => g.talks.forEach(t => list.push(t)));
  const done = list.filter(t => isDone(q.rec(t.code))).length;
  const pend = q.pendingCount(), errs = Object.keys(q.errs).length;
  const sync = q.fatal ? ["err", "⚠ код комиссии не действует"] : !pend ? ["ok", "✓ всё отправлено"]
    : errs || (typeof navigator.onLine === "boolean" && !navigator.onLine) ? ["err", `⚠ не отправлено: ${pend}`] : ["", "сохраняю…"];
  const setF = v => { setFilter(v); LS.set("conf_jury_filter_" + slug, v); };
  function quit() {
    if (pend && !window.confirm(`Не отправлено оценок: ${pend}. Они останутся на этом телефоне и уйдут, когда вы снова войдёте под тем же именем. Выйти?`)) return;
    logout();
  }
  function next(code) {
    const i = list.findIndex(t => t.code === code);
    if (i >= 0 && i + 1 < list.length) {
      setOpen(list[i + 1].code);
      setTimeout(() => { const el = document.getElementById("jt-" + list[i + 1].code); if (el) el.scrollIntoView(); }, 0);
    } else { setOpen(""); toast && toast("Это последний доклад в списке"); }
  }

  return (
    <div class="jury">
      <div class="card glass jury-head">
        <div class="row-between">
          <div class="jury-who"><b>{sess.juror}</b><span class="muted">{admin ? "администратор" : "эксперт"} · {info.title}</span></div>
          <button class="btn" onClick={quit}>Сменить</button>
        </div>
        <div class="jury-prog">
          <span>Оценено {done} из {list.length}</span>
          <span class={"sync " + sync[0]}>{sync[1]}</span>
        </div>
        <div class="meter"><i style={{ width: (list.length ? done / list.length * 100 : 0) + "%" }} /></div>
      </div>
      {q.fatal ? <div class="pill warn">Код комиссии больше не действует. Оценки сохранены на телефоне — нажмите «Сменить» и войдите с новым кодом.</div> : null}
      {q.storageFailed ? <div class="pill warn">Не удаётся сохранить на телефоне. Не закрывайте страницу, пока оценки не отправятся.</div> : null}
      <div class="seg" role="tablist">
        <button role="tab" aria-selected={tab === "rate"} class={tab === "rate" ? "on" : ""} onClick={() => setTab("rate")}>Оценки</button>
        <button role="tab" aria-selected={tab === "res"} class={tab === "res" ? "on" : ""} onClick={() => setTab("res")}>Итоги</button>
      </div>
      {tab === "rate" ? (
        <div>
          {sections.length > 1 ? (
            <div class="seg jury-secs" role="tablist" aria-label="Секция">
              <button class={f === "all" ? "on" : ""} onClick={() => setF("all")}>Все</button>
              {sections.map(s => <button key={s.no} class={f === String(s.no) ? "on" : ""} onClick={() => setF(String(s.no))}>Секция {s.no}</button>)}
            </div>
          ) : null}
          {groups.map(({ s: sec, talks }) => (
            <section key={sec ? sec.no : "all"}>
              {sec ? <h2 class="jury-sech"><span>{sec.no ? "Секция " + sec.no + " · " : ""}{talks.filter(t => isDone(q.rec(t.code))).length}/{talks.length}</span>{sec.title}</h2> : null}
              {talks.map((t, i) => (
                  <Talk key={t.code} t={t} no={i + 1} r={q.rec(t.code)} criteria={info.criteria} smax={smax} maxTotal={maxTotal}
                    state={q.pending[t.code] ? (q.errs[t.code] || q.fatal ? "error" : "saving") : q.rec(t.code).ts ? "saved" : ""}
                    open={open === t.code} onToggle={() => setOpen(open === t.code ? "" : t.code)} onNext={() => next(t.code)}
                    change={fn => q.change(t.code, fn)} />
              ))}
            </section>
          ))}
        </div>
      ) : <Results slug={slug} sess={sess} info={info} q={q} admin={admin} toast={toast} setRole={setRole} />}
    </div>
  );
}

function Talk({ t, no, r, criteria, smax, maxTotal, state, open, onToggle, onNext, change }) {
  const n = filled(r), comp = isComplete(r);
  const cls = "jcard" + (open ? " open" : "") + (comp ? " done" : "") + (!r.st && n && !comp ? " part" : "") + (r.st ? " flagged" : "");
  const score = r.st === "absent" ? "не было" : r.st === "abstain" ? "воздерж." : comp ? <span>{sumOf(r)}<small>/{maxTotal}</small></span>
    : n ? <span>{sumOf(r)}<small> · {n}/{criteria.length}</small></span> : "—";
  const pts = [];
  for (let v = 1; v <= smax; v++) pts.push(v);
  return (
    <article class={cls} id={"jt-" + t.code}>
      <button class="jsum" aria-expanded={open} onClick={onToggle}>
        <span class="jwhen">{t.start || "№ " + no}</span>
        <span class="jmain"><span class="jttl">{t.title}</span><span class="jwho">{[t.speaker, FORMAT[t.format]].filter(Boolean).join(" · ")}</span></span>
        <span class="jside"><span class="jscore">{score}</span>
          <span class={"jsv " + state}>{{ saving: "Сохраняю…", saved: "✓ Сохранено", error: "⚠ Не отправлено" }[state] || ""}</span></span>
      </button>
      {open ? (
        <div class="jbody">
          <p class="jmeta">
            {[t.start && t.end ? t.start + "–" + t.end : "", t.room, t.session].filter(Boolean).join(" · ")}<br />
            {t.authors && t.authors.length ? <span><b>Авторы:</b> {t.authors.join(", ")}<br /></span> : null}
            <b>Докладчик:</b> {[t.speaker + (FORMAT[t.format] ? ` (${FORMAT[t.format]})` : ""), t.org, t.city].filter(Boolean).join(", ")}
          </p>
          {criteria.map((name, c) => (
            <div key={c} class="jcrit">
              <div class="jcl"><span>{name}</span><b>{r.s[c] == null ? "" : r.s[c]}</b></div>
              <div class="jpts">
                {pts.map(v => (
                  <button key={v} class="jpt" aria-pressed={r.s[c] === v} aria-label={`${name}: ${v}`}
                    onClick={() => change(x => { x.s[c] = x.s[c] === v ? null : v; if (x.st === "absent") x.st = ""; })}>{v}</button>
                ))}
              </div>
            </div>
          ))}
          <div class="jflags">
            {[["absent", "Доклад не состоялся"], ["abstain", "Воздерживаюсь"]].map(([f, label]) => (
              <button key={f} class="jflag" aria-pressed={r.st === f} onClick={() => change(x => { x.st = x.st === f ? "" : f; })}>{label}</button>
            ))}
          </div>
          <textarea class="jcomment" rows={2} maxlength={1000} placeholder="Комментарий (необязательно)" aria-label="Комментарий"
            value={r.cm} onChange={e => { const v = e.currentTarget.value; change(x => { x.cm = v; }); }} />
          <div class="jfoot">
            <button class="btn" onClick={onToggle}>Свернуть</button>
            <button class="btn" onClick={onNext}>Следующий →</button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function Results({ slug, sess, info, q, admin, toast, setRole }) {
  const nc = info.criteria.length, smax = info.scaleMax, maxTotal = nc * smax;
  const [mode, setMode] = useState("all");
  const [server, setServer] = useState(null); // { all, at }
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  function load() {
    if (!admin) return;
    setBusy(true);
    juryApi(slug, "GET", { action: "all", code: sess.code, juror: sess.juror }).then(r => {
      setBusy(false);
      if (r && r.ok) { setServer({ all: groupRows(r.rows, info.talks, nc, smax), at: new Date() }); setNote(""); }
      else if (r && r.error === "forbidden") { setRole("juror"); toast && toast(ERR.forbidden); }
      else setNote(ERR[r && r.error] || "Не удалось загрузить оценки");
    }, () => { setBusy(false); setNote(server ? `⚠ Нет связи — данные на ${hhmm(server.at)}` : "⚠ Не удалось загрузить оценки других экспертов"); });
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [admin]);

  // свои оценки с телефона важнее серверных: в них могут быть неотправленные правки
  const all = Object.assign({}, admin && server ? server.all : {});
  all[norm(sess.juror)] = { name: sess.juror, data: q.data };
  const rows = computeResults(all, info.talks, nc, smax);
  const secs = info.sections.filter(s => info.talks.some(t => t.section === s.no));

  async function remove(name) {
    if (!window.confirm(`Удалить все оценки эксперта «${name}»?\n\nОни перенесутся в архив. Если эксперт ещё работает под этим именем, сначала попросите его выйти, иначе его новые правки снова появятся.`)) return;
    try {
      const r = await juryApi(slug, "POST", null, { action: "delete", code: sess.code, juror: sess.juror, target: name });
      if (!r.ok) return toast && toast(r.error === "forbidden" ? "Удалять оценки может только администратор" : "Не удалось удалить");
      toast && toast(`Удалено оценок: ${r.deleted}`);
      if (norm(name) === norm(sess.juror)) q.reset();
      load();
    } catch (e) { toast && toast("Нет связи с сервером — оценки не удалены"); }
  }
  const csv = kind => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    download(`${slug}_${kind === "rank" ? "рейтинг" : "оценки"}_${stamp}.csv`,
      kind === "rank" ? csvRank(rows, info.criteria) : csvRaw(all, info.talks, info.criteria, smax), "text/csv;charset=utf-8");
  };

  const ranked = {};
  rows.forEach(r => { ranked[r.t.code] = 1; });
  const unrated = info.talks.filter(t => !ranked[t.code]);
  const groups = mode === "sec" ? secs.map(s => ({ s, rows: rankRows(rows.filter(r => r.t.section === s.no)) })) : [{ s: null, rows: rankRows(rows) }];
  return (
    <div>
      {admin ? (
        <div class="seg" role="tablist" aria-label="Вид итогов">
          {[["all", "Рейтинг"], ["sec", "Секции"], ["stats", "Статистика"]].map(([m, label]) => (
            <button key={m} class={mode === m ? "on" : ""} onClick={() => setMode(m)}>{label}</button>
          ))}
        </div>
      ) : null}
      <p class="muted small jury-note">
        {admin ? `Средний суммарный балл экспертов (максимум ${maxTotal}). Учитываются только полностью заполненные оценки без отметок «не состоялся» и «воздерживается».`
          : "Ваши оценки, отсортированные по сумме баллов. Сводные итоги всех экспертов видит администратор."}
        {admin ? <span> {busy ? "Загрузка…" : server ? `Обновлено в ${hhmm(server.at)}.` : ""} {note}</span> : null}
      </p>
      {mode === "stats" && admin ? <Stats data={stats(all, rows, info.talks, info.criteria, smax, secs)} talks={info.talks} smax={smax} />
        : groups.map((g, gi) => (
          <div key={gi}>
            {g.s ? <h2 class="jury-sech"><span>Секция {g.s.no}</span>{g.s.title}</h2> : null}
            {g.rows.length ? g.rows.map(r => <RankRow key={r.t.code} r={r} admin={admin} maxTotal={maxTotal} criteria={info.criteria} />)
              : <p class="muted empty">Пока нет полных оценок</p>}
          </div>
        ))}
      {admin && mode !== "stats" ? (
        <details class="card jbox" open>
          <summary>Эксперты: {jurorStats(all, info.talks, nc, smax).length}</summary>
          <ul>
            {jurorStats(all, info.talks, nc, smax).map(j => (
              <li key={j.key} class="jrow">
                <span>{j.name}<small>{j.done}/{info.talks.length} · изменено в {hhmm(new Date(j.last))}</small></span>
                <button class="btn danger" aria-label={"Удалить оценки: " + j.name} onClick={() => remove(j.name)}>Удалить</button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {mode !== "stats" && unrated.length ? (
        <details class="card jbox">
          <summary>Без полных оценок: {unrated.length}</summary>
          <ul>{unrated.map(t => <li key={t.code}><span>{t.speaker} — {t.title}</span></li>)}</ul>
        </details>
      ) : null}
      {admin ? (
        <div class="actions">
          <button class="btn" onClick={() => csv("rank")}>⬇ Рейтинг, CSV</button>
          <button class="btn" onClick={() => csv("raw")}>⬇ Все оценки, CSV</button>
        </div>
      ) : null}
    </div>
  );
}

function RankRow({ r, admin, maxTotal, criteria }) {
  return (
    <div class={"card jrank" + (r.rank <= 3 ? " p" + r.rank : "")}>
      <div class="jplace">{r.rank}</div>
      <div class="jrmain"><b>{r.t.title}</b><span class="muted">{r.t.speaker}{r.t.section ? " · секция " + r.t.section : ""}</span></div>
      <div class="javg"><b>{fmtNum(r.avg)}</b><span>{admin ? `${r.n} ${plural(r.n, "эксперт", "эксперта", "экспертов")}` : "из " + maxTotal}</span></div>
      <details class="jdet">
        <summary>Подробнее</summary>
        <dl>
          {criteria.map((c, i) => [<dt key={"c" + i}>{c}</dt>, <dd key={"v" + i}>{fmtNum(r.crit[i])}</dd>])}
          {admin ? r.list.slice().sort((a, b) => b.total - a.total).map((x, i) => [<dt key={"j" + i}>{x.name}</dt>, <dd key={"t" + i}>{x.total}</dd>]) : null}
          {admin && r.n > 1 ? [<dt key="mm">Мин – макс · ст. откл.</dt>, <dd key="mv">{r.min}–{r.max} · {fmtNum(r.sd)}</dd>] : null}
        </dl>
      </details>
    </div>
  );
}

function Stats({ data, talks, smax }) {
  if (!data) return <p class="muted empty">Пока нет полных оценок — статистика появится после первых оценок экспертов.</p>;
  const pct = (x, max) => Math.max(0, Math.min(100, max ? x / max * 100 : 0)) + "%";
  const row = (label, sub, value, width, key) => (
    <li key={key || label} class="jst">
      <div class="jstl"><span>{label}{sub ? <small>{sub}</small> : null}</span><b>{value}</b></div>
      <div class="meter"><i style={{ width }} /></div>
    </li>
  );
  const dn = data.dist.reduce((a, b) => a + b, 0), dmax = Math.max.apply(null, data.dist);
  const dist = [];
  for (let v = smax; v >= 1; v--) dist.push(row(`${v} ${plural(v, "балл", "балла", "баллов")}`, "", `${data.dist[v - 1]} · ${Math.round(data.dist[v - 1] / dn * 100)}%`, pct(data.dist[v - 1], dmax), "d" + v));
  return (
    <div>
      <div class="jtiles">
        <div class="card jtile"><b>{data.jurors.length}</b><span>{plural(data.jurors.length, "эксперт оценивает", "эксперта оценивают", "экспертов оценивают")}</span></div>
        <div class="card jtile"><b>{data.counted}</b><span>{plural(data.counted, "оценка засчитана", "оценки засчитаны", "оценок засчитано")}</span></div>
        <div class="card jtile"><b>{data.ranked}<small>/{talks.length}</small></b><span>докладов в рейтинге</span></div>
        <div class="card jtile"><b>{fmtNum(data.overall)}<small>/{data.maxTotal}</small></b><span>средняя сумма баллов</span></div>
      </div>
      {data.bySection.length ? (
        <div class="card jbox"><h3>По секциям</h3><ul>{data.bySection.map(s => row(`Секция ${s.no}`,
          s.rated ? `${s.rated} из ${s.count} докладов · лидер: ${s.leaders.map(r => r.t.speaker).join(", ")} (${fmtNum(s.leaders[0].avg)})` : `0 из ${s.count} докладов`,
          s.mean == null ? "—" : fmtNum(s.mean), s.mean == null ? "0%" : pct(s.mean, data.maxTotal), "s" + s.no))}</ul></div>
      ) : null}
      <div class="card jbox"><h3>Средний балл по критериям (из {smax})</h3><ul>{data.crit.map((c, i) => row(c.name, "", fmtNum(c.mean), pct(c.mean, smax), "c" + i))}</ul></div>
      <div class="card jbox"><h3>Распределение баллов</h3><ul>{dist}</ul></div>
      <div class="card jbox"><h3>Эксперты</h3><ul>{data.jurors.map(j => row(j.name,
        `${j.mean == null ? "нет полных оценок" : "средняя сумма " + fmtNum(j.mean) + " (" + (j.mean - data.overall >= 0 ? "+" : "−") + fmtNum(Math.abs(j.mean - data.overall)) + " к общей)"} · изменено в ${hhmm(new Date(j.last))}`,
        `${j.done}/${talks.length}`, pct(j.done, talks.length), j.key))}</ul></div>
      {data.spread.length ? (
        <div class="card jbox"><h3>Наибольшие расхождения экспертов</h3><ul>{data.spread.map(r => (
          <li key={r.t.code}><span>{r.t.speaker} — {r.t.title}<small>{r.n} {plural(r.n, "оценка", "оценки", "оценок")}: {r.list.map(x => x.total).join(", ")}</small></span><b>{r.min}–{r.max}</b></li>
        ))}</ul></div>
      ) : null}
    </div>
  );
}
