// Офлайн-очередь оценок жюри (перенос change/flush/beaconAll/syncMine из jury-score).
// Каждая правка сразу пишется в localStorage и ставится в pending; через 500 мс — отправка, при сбое — повтор
// каждые 8 с, а также при online и возвращении на вкладку. Повтор безопасен: сервер делает upsert по ts.
import { normRec, fromRow, norm } from "./results.js";

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};

/**
 * opts: { slug, juror, code, nc, smax, post(body) → Promise<json>, beacon(body) → bool, onChange(), storage?, delays? }
 * Состояние: data (код → запись), pending, errs, fatal ("" | "bad_code").
 */
export function createQueue(opts) {
  const store = opts.storage || LS;
  const delays = Object.assign({ flush: 500, retry: 8000 }, opts.delays || {});
  const key = norm(opts.juror);
  const kData = `conf_jury_data_${opts.slug}_${key}`, kPend = `conf_jury_pending_${opts.slug}_${key}`;
  const q = {
    data: store.get(kData, {}) || {},
    pending: {}, errs: {}, fatal: "", storageFailed: false,
  };
  (store.get(kPend, []) || []).forEach(id => { q.pending[id] = 1; });
  let flushTimer = 0, retryTimer = 0, flushing = false, closed = false;
  const rec = id => normRec(q.data[id], opts.nc, opts.smax);
  const notify = () => { if (!closed && opts.onChange) opts.onChange(); };

  function save() {
    const ok = store.set(kData, q.data) & store.set(kPend, Object.keys(q.pending));
    if (!ok) q.storageFailed = true;
  }

  function payload(id) {
    const r = rec(id);
    return { action: "save", code: opts.code, juror: opts.juror, id, scores: r.s, status: r.st, comment: r.cm, ts: r.ts };
  }

  q.rec = rec;
  q.pendingCount = () => Object.keys(q.pending).length;

  /** Правка оценки: fn меняет запись; время правки строго растёт. */
  q.change = (id, fn) => {
    const r = q.data[id] = rec(id);
    fn(r);
    r.ts = Math.max(Date.now(), r.ts + 1);
    q.pending[id] = 1;
    save();
    notify();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(q.flush, delays.flush);
  };

  q.flush = async () => {
    clearTimeout(flushTimer); clearTimeout(retryTimer);
    if (closed || !q.pendingCount() || q.fatal) { notify(); return; }
    if (flushing) return;
    flushing = true;
    let failed = false;
    for (const id of Object.keys(q.pending)) {
      const sentTs = rec(id).ts;
      let res;
      try { res = await opts.post(payload(id)); } catch (e) {
        failed = true;
        Object.keys(q.pending).forEach(x => { q.errs[x] = 1; });
        break;
      }
      if (closed) break;
      if (res && res.ok) {
        delete q.errs[id];
        if (rec(id).ts === sentTs) delete q.pending[id]; // пока отправляли, могли поправить ещё раз
      } else if (res && res.error === "bad_code") { q.fatal = "bad_code"; failed = true; break; }
      else { q.errs[id] = 1; failed = true; }
      save();
      notify();
    }
    flushing = false;
    if (closed) return;
    save();
    notify();
    if (failed) { if (!q.fatal) retryTimer = setTimeout(q.flush, delays.retry); }
    else if (q.pendingCount()) flushTimer = setTimeout(q.flush, 0);
  };

  /** Оценки эксперта с сервера: неотправленные и более свежие локальные правки важнее. */
  q.merge = rows => {
    (rows || []).forEach(row => {
      if (q.pending[row.id]) return;
      if (q.data[row.id] && q.data[row.id].ts > row.ts) return;
      q.data[row.id] = fromRow(row, opts.nc, opts.smax);
    });
    save();
    notify();
  };

  /** Уход со страницы: последняя попытка через sendBeacon (запись остаётся в pending до подтверждения). */
  q.beacon = () => {
    if (q.fatal || !opts.beacon) return;
    Object.keys(q.pending).forEach(id => { try { opts.beacon(payload(id)); } catch (e) { /* не вышло */ } });
  };

  /** Удалить свои оценки локально (администратор удалил их на сервере). */
  q.reset = () => { q.data = {}; q.pending = {}; q.errs = {}; save(); notify(); };

  q.close = () => { closed = true; clearTimeout(flushTimer); clearTimeout(retryTimer); };
  return q;
}
