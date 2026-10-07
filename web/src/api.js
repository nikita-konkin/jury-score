// Клиент API: вход пользователя (токен PocketBase в localStorage), запросы с таймаутом.

const AUTH_KEY = "conf_auth";
const TIMEOUT_MS = 30000;

function load() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || "null"); } catch (e) { return null; }
}

export const auth = { state: load() };

export function setAuth(token, record) {
  auth.state = token ? { token, record } : null;
  try {
    if (auth.state) localStorage.setItem(AUTH_KEY, JSON.stringify(auth.state));
    else localStorage.removeItem(AUTH_KEY);
  } catch (e) { /* приватный режим: вход живёт до перезагрузки */ }
}

export const user = () => (auth.state ? auth.state.record : null);

/** { status, json } или исключение с понятным сообщением при сетевой ошибке. */
export async function api(method, url, body, headers) {
  const h = Object.assign({}, headers || {});
  if (auth.state && auth.state.token && !h.Authorization) h.Authorization = auth.state.token;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(url, {
      method, headers: h, signal: ctl ? ctl.signal : undefined,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(ctl && ctl.signal.aborted ? "Сервер не ответил за 30 секунд" : "Нет связи с сервером");
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = { message: text.slice(0, 300) }; }
  // токен истёк или отозван — выходим, чтобы не показывать чужие ошибки
  if (res.status === 401 && auth.state && h.Authorization === auth.state.token) setAuth(null);
  return { status: res.status, json: json || {} };
}

export const errorText = r => (r.json && r.json.message ? String(r.json.message).replace(/\.$/, "") : "Ошибка " + r.status);

export async function login(email, password) {
  const r = await api("POST", "/api/collections/users/auth-with-password", { identity: email, password });
  if (r.status === 200) setAuth(r.json.token, r.json.record);
  return r;
}
