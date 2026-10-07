// «Создать из ответа чат-бота» для ботов без инструментов (GigaChat, YandexGPT, …):
// набор для бота → ответ бота → проверка → черновик в аккаунте вошедшего пользователя.
import { useState } from "preact/hooks";
import { api, errorText, user } from "../api.js";
import { go } from "../hooks.js";
import { Program, Report } from "../components/Program.jsx";
import { copyText, extractJson } from "../util.js";

/** Текст для чат-бота: инструкция, схема и (для правки) текущая программа. */
export async function botKit(current) {
  const [llms, schema] = await Promise.all([
    fetch("/llms.txt").then(r => r.text()),
    fetch("/schema/program.v1.json").then(r => r.text()),
  ]);
  return [
    "Ты помогаешь организатору составить программу мероприятия для сервиса conf-kit. Инструментов у тебя нет.",
    "Ответь ОДНИМ блоком JSON вида { \"program\": <документ conf.program/v1>, \"feedback\": [ … ] }.",
    "В feedback перечисли, чего не хватило в схеме или что пришлось положить в extra (формат — как у /api/v1/feedback); если всё поместилось — пустой массив.",
    "Не выдумывай данные: чего нет в материалах — спроси или не заполняй.",
    "",
    llms,
    "",
    "## JSON Schema",
    schema,
    "",
    current ? "## Текущая программа (внеси правки и верни целиком)\n" + JSON.stringify(current) : "## Материалы мероприятия\n(вставьте сюда информационное письмо, список докладов, регламент)",
  ].join("\n");
}

export function FromJson({ toast }) {
  const [text, setText] = useState("");
  const [state, setState] = useState(null); // { program, feedback, doc, report }
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!user()) return <div class="card msg"><p>Сначала войдите в аккаунт.</p><a class="btn wide" href="#/">Вход</a></div>;

  async function check() {
    setErr("");
    setState(null);
    const x = extractJson(text);
    if (x.error) { setErr(x.error); return; }
    const program = x.value && x.value.program && typeof x.value.program === "object" ? x.value.program : x.value;
    const feedback = Array.isArray(x.value.feedback) ? x.value.feedback : [];
    setBusy(true);
    try {
      const r = await api("POST", "/api/v1/programs/validate", program);
      if (r.status !== 200) throw new Error(errorText(r));
      setState({ program, feedback, doc: r.json.doc, report: r.json.report });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  async function create() {
    setBusy(true);
    try {
      const r = await api("POST", "/api/v1/events", { program: state.program }, { "X-Conf-Client": "ui" });
      if (r.status !== 201) throw new Error(errorText(r));
      const id = r.json.event.id;
      // обратная связь бота отправляется от имени пользователя
      await Promise.allSettled(state.feedback.slice(0, 10).map(f =>
        api("POST", "/api/v1/feedback", Object.assign({}, f, { source: "paste", event_id: id }))));
      toast("Черновик создан");
      go("/my/" + id);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div>
      <a class="back" href="#/">← Мои мероприятия</a>
      <div class="card glass">
        <h1 class="page-title">Из ответа чат-бота</h1>
        <ol class="steps">
          <li>
            Скопируйте набор и вставьте его в чат-бот (GigaChat, YandexGPT, ChatGPT…), а в конце — материалы мероприятия.
            <button class="btn wide" onClick={() => botKit().then(t => copyText(t)).then(() => toast("Набор скопирован"), e => setErr(e.message))}>
              Скопировать набор для чат-бота
            </button>
          </li>
          <li>Вставьте ответ бота целиком — JSON найдётся сам.</li>
        </ol>
        <label class="field"><span>Ответ чат-бота</span>
          <textarea rows="8" value={text} onInput={e => setText(e.target.value)} placeholder="{ &quot;program&quot;: { … } }" /></label>
        <p class="err" role="alert">{err}</p>
        <button class="btn primary" disabled={busy || !text.trim()} onClick={check}>{busy && !state ? "Проверка…" : "Проверить"}</button>
      </div>
      {state ? (
        <div>
          <div class="card"><Report report={state.report} />
            {state.feedback.length ? <p class="muted">Бот сообщил о проблемах: {state.feedback.length} — они уйдут разработчикам вместе с черновиком.</p> : null}
            {state.report.ok ? <button class="btn primary" disabled={busy} onClick={create}>Создать черновик</button>
              : <p class="muted">Отправьте боту список ошибок и попросите исправить.</p>}
          </div>
          {state.doc ? <Program program={state.doc} /> : null}
        </div>
      ) : null}
    </div>
  );
}
