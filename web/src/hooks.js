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

/** Широкий экран (десктоп): true от min px (по умолчанию 900), обновляется при изменении окна. */
export function useWide(min) {
  const q = "(min-width: " + (min || 900) + "px)";
  const get = () => !!(window.matchMedia && window.matchMedia(q).matches);
  const [wide, setWide] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(q);
    const on = () => setWide(mq.matches);
    on();
    // Safari 12 знает только addListener
    if (mq.addEventListener) mq.addEventListener("change", on); else mq.addListener(on);
    return () => { if (mq.removeEventListener) mq.removeEventListener("change", on); else mq.removeListener(on); };
  }, [q]);
  return wide;
}

/** Класс у <html>, пока on и компонент на экране (например, «page-wide» — широкая страница на десктопе). */
export function useHtmlClass(cls, on) {
  useEffect(() => {
    if (!on) return undefined;
    const list = document.documentElement.classList;
    list.add(cls);
    return () => list.remove(cls);
  }, [cls, !!on]);
}
