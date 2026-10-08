import "./polyfills.js";
import * as preact from "preact";
import * as preactHooks from "preact/hooks";
import * as jsxRuntime from "preact/jsx-runtime";
import * as apiModule from "./api.js";
import * as utilModule from "./util.js";
import * as hooksModule from "./hooks.js";
import * as programModule from "./components/Program.jsx";
import { useRoute } from "./hooks.js";
import { Home } from "./pages/Home.jsx";
import { Claim } from "./pages/Claim.jsx";
import { MyEvent } from "./pages/MyEvent.jsx";
import { FromJson } from "./pages/FromJson.jsx";
import { View } from "./pages/View.jsx";
import { Jury } from "./pages/Jury.jsx";
import { Apply } from "./pages/Apply.jsx";

const { render } = preact;
const { useState, useEffect } = preactHooks;
const { user } = apiModule;

// общие модули для editor.js (ключи — как SHARED в build.mjs)
window.__confShared = {
  "preact": preact, "preact/hooks": preactHooks, "preact/jsx-runtime": jsxRuntime,
  api: apiModule, util: utilModule, hooks: hooksModule, program: programModule,
};

let editorLoad = null;
function loadEditor() {
  if (window.ConfEditor) return Promise.resolve(window.ConfEditor);
  if (!editorLoad) {
    editorLoad = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = __EDITOR_JS__;
      s.onload = () => (window.ConfEditor ? resolve(window.ConfEditor) : reject(new Error("Конструктор не запустился")));
      s.onerror = () => { editorLoad = null; s.parentNode.removeChild(s); reject(new Error("Не удалось загрузить конструктор — проверьте связь")); };
      document.head.appendChild(s);
    });
  }
  return editorLoad;
}

/** Страница из editor.js: грузится при первом заходе в конструктор. */
function Lazy({ name, props }) {
  const [mod, setMod] = useState(window.ConfEditor || null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!mod) loadEditor().then(setMod, e => setErr(e.message));
  }, []);
  if (err) return <div class="card msg"><p>{err}</p><button class="btn wide" onClick={() => { setErr(""); loadEditor().then(setMod, e => setErr(e.message)); }}>Повторить</button></div>;
  if (!mod) return <p class="muted center">Загрузка конструктора…</p>;
  const C = mod[name];
  return <C {...props} />;
}

function Page({ route, toast, refresh }) {
  let m;
  if ((m = /^\/claim\/([\w-]+)$/.exec(route))) return <Claim token={m[1]} toast={toast} />;
  if ((m = /^\/preview\/([\w-]+)$/.exec(route))) return <View url={"/api/v1/preview/" + m[1]} preview toast={toast} />;
  if ((m = /^\/e\/([\w-]+)$/.exec(route))) return <View key={m[1]} url={`/api/v1/events/${m[1]}/program`} toast={toast} />;
  if ((m = /^\/apply\/([\w-]+)(?:\/(ap_[A-Za-z0-9]+))?$/.exec(route))) return <Apply key={"a" + route} slug={m[1]} token={m[2] || ""} toast={toast} />;
  if ((m = /^\/jobs\/(\w+)$/.exec(route))) return <Lazy key={"jb" + m[1]} name="Jobs" props={{ id: m[1], toast }} />;
  if ((m = /^\/applications\/(\w+)$/.exec(route))) return <Lazy key={"ap" + m[1]} name="Applications" props={{ id: m[1], toast }} />;
  if ((m = /^\/jury\/([\w-]+)(?:\/([\w-]+))?$/.exec(route))) return <Jury key={"j" + m[1]} slug={m[1]} code={m[2] || ""} toast={toast} />;
  if ((m = /^\/my\/(\w+)$/.exec(route))) return <MyEvent id={m[1]} toast={toast} />;
  if ((m = /^\/edit\/(\w+)(\/.*)?$/.exec(route))) return <Lazy key={"e" + m[1]} name="Editor" props={{ id: m[1], sub: m[2] || "", toast }} />;
  if ((m = /^\/create(?:\/(\w+))?$/.exec(route))) return <Lazy key={"c" + (m[1] || "")} name="Create" props={{ from: m[1] || "", toast }} />;
  if ((m = /^\/print\/([\w-]+)(?:\/(\w+))?$/.exec(route))) return <Lazy key={"p" + m[1]} name="Print" props={{ id: m[1], kind: m[2] || "program", toast }} />;
  if (route === "/new") return <FromJson toast={toast} />;
  return <Home toast={toast} refresh={refresh} />;
}

function App() {
  const route = useRoute();
  const [msg, setMsg] = useState("");
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!msg) return undefined;
    const t = setTimeout(() => setMsg(""), 2600);
    return () => clearTimeout(t);
  }, [msg]);
  const me = user();
  return (
    <div class="wrap">
      <div class="bg" aria-hidden="true"><i /><i /><i /><i /></div>
      <nav class="top glass">
        <a class="brand" href="#/"><b>conf-kit</b><small>программы мероприятий</small></a>
        {me ? <a class="who" href="#/" title={me.email}>{(me.name || me.email || "?").slice(0, 1).toUpperCase()}</a> : null}
      </nav>
      <main><Page route={route} toast={setMsg} refresh={() => setTick(n => n + 1)} /></main>
      <div class={"toast glass" + (msg ? " show" : "")} role="status" aria-live="polite">{msg}</div>
    </div>
  );
}

if (!window.__confOld) render(<App />, document.getElementById("app"));
