// Общие элементы конструктора: нижний лист, поля формы, значки проверки.

export function Sheet({ title, onClose, children, footer }) {
  return (
    <div class="sheet-wrap" role="dialog" aria-modal="true" aria-label={title}>
      <div class="sheet-bg" onClick={onClose} />
      <div class="sheet">
        <div class="sheet-head">
          <h2>{title}</h2>
          <button type="button" class="btn icon" aria-label="Закрыть" onClick={onClose}>✕</button>
        </div>
        <div class="sheet-body">{children}</div>
        {footer ? <div class="sheet-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Состояние формы: [form, set(key) → обработчик onInput/onChange, patch]. */
export function bind(form, setForm) {
  return key => e => {
    const t = e.currentTarget;
    const v = t.type === "checkbox" ? t.checked : t.value;
    setForm(Object.assign({}, form, { [key]: v }));
  };
}

export function Field({ label, hint, children }) {
  return (
    <label class="field">
      <span>{label}</span>
      {children}
      {hint ? <small class="hint">{hint}</small> : null}
    </label>
  );
}

export function Check({ label, checked, onChange }) {
  return (
    <label class="check">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

/** Значок «2 ошибки / 3 предупреждения» по записи из issueIndex. */
export function Issues({ x }) {
  if (!x) return null;
  return (
    <span class="iss">
      {x.err ? <span class="iss-err" title="ошибки">{x.err}</span> : null}
      {x.warn ? <span class="iss-warn" title="предупреждения">{x.warn}</span> : null}
    </span>
  );
}

export function IssueList({ list }) {
  if (!list || !list.length) return null;
  return (
    <ul class="report-list">
      {list.map((e, i) => <li key={i} class={e.level === "error" ? "err" : "warn"}>{e.message}</li>)}
    </ul>
  );
}

export function Datalist({ id, values }) {
  return <datalist id={id}>{values.map(v => <option key={v} value={v} />)}</datalist>;
}
