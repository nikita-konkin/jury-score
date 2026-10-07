import { useEffect, useState, useCallback } from "preact/hooks";

/** Текущий адрес после «#»: «/claim/inv_…» */
export function useRoute() {
  const get = () => (location.hash.replace(/^#/, "") || "/").split("?")[0];
  const [route, setRoute] = useState(get());
  useEffect(() => {
    const on = () => { setRoute(get()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = path => { location.hash = "#" + path; };

/** Загрузка данных: { data, error, loading, reload }. fn возвращает Promise. */
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: "", loading: true });
  const run = useCallback(() => {
    setState(s => Object.assign({}, s, { loading: true, error: "" }));
    let alive = true;
    Promise.resolve().then(fn).then(
      data => { if (alive) setState({ data, error: "", loading: false }); },
      e => { if (alive) setState({ data: null, error: e.message || String(e), loading: false }); });
    return () => { alive = false; };
  }, deps);
  useEffect(run, [run]);
  return Object.assign({}, state, { reload: run });
}
