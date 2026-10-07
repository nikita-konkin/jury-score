// Полифилы только там, где нет своей реализации: Chrome 61, Firefox 60, Safari 12 (iOS 12.0 — без AbortController).
// Синтаксис понижает esbuild, а отсутствующие методы добавляются здесь.

if (!Array.prototype.flat) {
  Object.defineProperty(Array.prototype, "flat", {
    configurable: true, writable: true,
    value: function flat(depth) {
      const d = depth === undefined ? 1 : Number(depth) || 0;
      const out = [];
      (function walk(list, level) {
        for (let i = 0; i < list.length; i++) {
          if (Array.isArray(list[i]) && level < d) walk(list[i], level + 1);
          else if (i in list) out.push(list[i]);
        }
      })(this, 0);
      return out;
    },
  });
}

if (!Array.prototype.flatMap) {
  Object.defineProperty(Array.prototype, "flatMap", {
    configurable: true, writable: true,
    value: function flatMap(fn, thisArg) { return Array.prototype.map.call(this, fn, thisArg).flat(); },
  });
}

if (!Object.fromEntries) {
  Object.fromEntries = function fromEntries(entries) {
    const o = {};
    Array.from(entries, e => { o[e[0]] = e[1]; });
    return o;
  };
}

if (!Object.entries) Object.entries = o => Object.keys(o).map(k => [k, o[k]]);
if (!Object.values) Object.values = o => Object.keys(o).map(k => o[k]);

if (typeof Promise.prototype.finally !== "function") {
  Promise.prototype.finally = function (fn) {
    return this.then(v => Promise.resolve(fn()).then(() => v), e => Promise.resolve(fn()).then(() => { throw e; }));
  };
}

if (!Promise.allSettled) {
  Promise.allSettled = list => Promise.all(Array.from(list, p => Promise.resolve(p).then(
    value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }))));
}

if (!String.prototype.padStart) {
  String.prototype.padStart = function (len, fill) {
    let s = String(this);
    const f = fill === undefined ? " " : String(fill);
    while (s.length < len) s = f + s;
    return s.slice(s.length - Math.max(len, String(this).length));
  };
}
