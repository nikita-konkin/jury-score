// Точка входа конструктора (editor.js). preact, api.js, util.js, hooks.js и Program.jsx
// подставляются из app.js (см. SHARED в build.mjs), поэтому этот файл грузится только после него.
import { Editor } from "./pages/Editor.jsx";
import { Create } from "./pages/Create.jsx";
import { Print } from "./print/Print.jsx";
import { Applications } from "./pages/Applications.jsx";
import { Jobs } from "./pages/Jobs.jsx";

window.ConfEditor = { Editor, Create, Print, Applications, Jobs };
