// Программа только для чтения: предпросмотр черновика (#/preview/<токен>) и опубликованная (#/e/<адрес>).
import { api, errorText } from "../api.js";
import { useLoad } from "../hooks.js";
import { EventHeader, Program } from "../components/Program.jsx";

export function View({ url, preview }) {
  const res = useLoad(async () => {
    const r = await api("GET", url);
    if (r.status !== 200) throw new Error(r.status === 404 ? (preview ? "Ссылка предпросмотра не найдена" : "Программа не найдена или ещё не опубликована") : errorText(r));
    return r.json;
  }, [url]);
  if (res.loading) return <p class="muted center">Загрузка…</p>;
  if (res.error) return <div class="card msg"><p>{res.error}</p></div>;
  return (
    <div>
      {preview ? <p class="pill warn">Черновик — предпросмотр, программа ещё может измениться</p> : null}
      <div class="card glass"><EventHeader program={res.data.program} /></div>
      <Program program={res.data.program} />
    </div>
  );
}
