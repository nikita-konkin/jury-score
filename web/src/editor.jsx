// Точка входа конструктора (editor.js). preact, api.js, util.js, hooks.js и Program.jsx
// подставляются из app.js (см. SHARED в build.mjs), поэтому этот файл грузится только после него.
import { Editor } from "./pages/Editor.jsx";
import { Create } from "./pages/Create.jsx";

window.ConfEditor = { Editor, Create };
