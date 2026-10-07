import "./polyfills.js";
import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import { user } from "./api.js";
import { useRoute } from "./hooks.js";
import { Home } from "./pages/Home.jsx";
import { Claim } from "./pages/Claim.jsx";
import { MyEvent } from "./pages/MyEvent.jsx";
import { FromJson } from "./pages/FromJson.jsx";
import { View } from "./pages/View.jsx";

function Page({ route, toast, refresh }) {
  let m;
  if ((m = /^\/claim\/([\w-]+)$/.exec(route))) return <Claim token={m[1]} toast={toast} />;
  if ((m = /^\/preview\/([\w-]+)$/.exec(route))) return <View url={"/api/v1/preview/" + m[1]} preview />;
  if ((m = /^\/e\/([\w-]+)$/.exec(route))) return <View url={`/api/v1/events/${m[1]}/program`} />;
  if ((m = /^\/my\/(\w+)$/.exec(route))) return <MyEvent id={m[1]} toast={toast} />;
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
