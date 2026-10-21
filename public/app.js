/* Netflix-style front end for a shared novel library.
   - profile gate with per-profile PIN, reading progress, My List and look
   - browse rows with generated covers, hero banner, search, reader, add, activity
*/
const $ = (id) => document.getElementById(id);
const LS = { get(k, d) { try { return JSON.parse(localStorage.getItem("ln." + k)) ?? d; } catch { return d; } }, set(k, v) { localStorage.setItem("ln." + k, JSON.stringify(v)); }, del(k) { localStorage.removeItem("ln." + k); } };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let TOKEN = LS.get("token", null);
const API = async (path, opts = {}) => {
  const headers = { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) };
  if (TOKEN) headers["x-profile-token"] = TOKEN;
  const r = await fetch(path, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return data;
};
const post = (p, b) => API(p, { method: "POST", body: JSON.stringify(b || {}) });
const patch = (p, b) => API(p, { method: "PATCH", body: JSON.stringify(b || {}) });
const del = (p) => API(p, { method: "DELETE" });

const MAIN_LANGS = ["en", "es", "sv", "de"];
const LEVELS = ["easy", "medium", "hard"];
const LEVEL_LABEL = { easy: "Easy", medium: "Medium", hard: "Hard" };
const FONTS = {
  serif: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  literary: "Cambria, 'Palatino Linotype', 'Book Antiqua', Palatino, serif",
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  humanist: "'Segoe UI', 'Trebuchet MS', Verdana, sans-serif",
  dyslexic: "'Comic Sans MS', Verdana, Tahoma, sans-serif",
  mono: "ui-monospace, Consolas, 'Courier New', monospace",
};
const DEFAULT_LOOK = { theme: "dark", font: "serif", size: 18, line: "1.7", width: "46rem", bg: "plain", spacing: "0", justify: false };

let LANG = [], PROFILES = [], me = null, LANG_NAMES = {};
let state = { progress: {}, myList: [], look: { ...DEFAULT_LOOK }, level: "medium" };
let WORKS = [], currentWork = null, currentChapter = null, currentLang = "en", currentLevel = "medium", currentVolume = null, splitOn = false;
let saveStateTimer = null;

function toast(msg, kind = "info") {
  const el = document.createElement("div");
  el.className = "toast " + kind; el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 5000);
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.old = btn.textContent; btn.disabled = true; btn.textContent = label || "…"; }
  else { btn.disabled = false; if (btn.dataset.old) btn.textContent = btn.dataset.old; }
}
const langName = (c) => LANG_NAMES[c] || c;
const hashHue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const initialsOf = (t) => String(t || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

/* --------------------------------------------------------------- modal */
function modal({ title, body, ok = "OK", cancel = "Cancel" }) {
  return new Promise((resolve) => {
    $("modalTitle").textContent = title;
    $("modalBody").innerHTML = body || "";
    $("modalMsg").textContent = "";
    $("modalOk").textContent = ok;
    $("modalCancel").textContent = cancel;
    $("modal").classList.remove("hidden");
    const focus = $("modalBody").querySelector("input");
    focus?.focus();
    const collect = () => {
      const values = {};
      for (const el of $("modalBody").querySelectorAll("input,select,textarea")) {
        if (!el.id) continue;
        values[el.id] = el.type === "checkbox" ? el.checked : el.value;
      }
      const sel = $("modalBody").querySelector(".avatar-picker button.sel");
      if (sel) values.__avatarIndex = Number(sel.dataset.i);
      return values;
    };
    const done = (okFlag) => {
      const values = collect();
      $("modal").classList.add("hidden");
      $("modalOk").onclick = null;
      $("modalCancel").onclick = null;
      resolve({ ok: okFlag, values });
    };
    $("modalOk").onclick = () => done(true);
    $("modalCancel").onclick = () => done(false);
  });
}

/* ---------------------------------------------------------------- boot */
async function boot() {
  const langs = await fetch("/api/languages").then((r) => r.json());
  LANG = langs;
  for (const l of langs) LANG_NAMES[l.code] = l.name;
  for (const el of [$("sourceLang")]) for (const l of langs) el.add(new Option(l.name, l.code));
  $("sourceLang").value = "en";
  for (const code of MAIN_LANGS) {
    const label = document.createElement("label");
    label.className = "chip";
    label.innerHTML = `<input type="checkbox" id="auto_${code}" value="${code}" ${code === "en" ? "checked" : ""}> ${langName(code)}`;
    $("autoLangs").appendChild(label);
  }
  for (const level of LEVELS) {
    const label = document.createElement("label");
    label.className = "chip";
    label.innerHTML = `<input type="checkbox" id="lvl_${level}" value="${level}" ${level === "medium" ? "checked" : ""}> ${LEVEL_LABEL[level]}`;
    $("autoLevels").appendChild(label);
  }
  bindUi();
  await showGate();
  registerPWA();
}

/* --------------------------------------------------------- profile gate */
async function showGate() {
  PROFILES = await fetch("/api/profiles").then((r) => r.json()).catch(() => []);
  $("gate").classList.remove("hidden");
  $("appShell").classList.add("hidden");
  $("gateProfiles").innerHTML = PROFILES.map((p) => `
    <button class="gate-profile" data-id="${p.id}">
      <span class="gate-avatar" style="background:${p.color || "#333"}">${esc(p.avatar || "🙂")}</span>
      <small>${esc(p.name)}${p.hasPin ? " 🔒" : ""}</small>
    </button>`).join("") || `<p class="hint">No profiles yet — create one to start.</p>`;
  document.querySelectorAll(".gate-profile").forEach((b) => (b.onclick = () => signIn(b.dataset.id)));
}

async function signIn(id) {
  const profile = PROFILES.find((p) => p.id === id);
  if (!profile) return;
  let pin = "";
  if (profile.hasPin) {
    const r = await modal({
      title: `${profile.avatar} ${profile.name}`,
      body: `<label>PIN <input id="pinInput" type="password" inputmode="numeric" autocomplete="off" placeholder="••••" style="font-size:1.3rem;letter-spacing:.3em"></label>`,
      ok: "Enter",
    });
    if (!r.ok) return;
    pin = r.values.pinInput || "";
  }
  try {
    const r = await post(`/api/profiles/${id}/login`, { pin });
    TOKEN = r.token; LS.set("token", TOKEN);
    await enterApp(r.profile);
  } catch (e) {
    $("gateMsg").textContent = e.message;
    toast(e.message, "error");
  }
}

async function enterApp(profile) {
  me = profile;
  $("gate").classList.add("hidden");
  $("appShell").classList.remove("hidden");
  $("whoami").textContent = me.avatar || "🙂";
  $("menuAvatar").textContent = me.avatar || "🙂";
  $("menuName").textContent = me.name;
  try {
    state = await API(`/api/profiles/${me.id}/state`);
    if (!state.look) state.look = { ...DEFAULT_LOOK };
  } catch (e) { if (e.status === 401) { LS.del("token"); TOKEN = null; return showGate(); } }
  applyLook();
  currentLevel = state.level || "medium";
  await loadLibrary();
  if (!location.hash || location.hash === "#/") location.hash = "#/browse";
  route();
}

$("addProfileBtn").onclick = createProfileFlow;
$("manageProfilesBtn").onclick = manageProfiles;

const AVATARS = ["🦊", "🐼", "🐯", "🦉", "🐙", "🦄", "🐧", "🐨", "🐸", "🦁", "🐺", "🐳", "🦋", "🐲", "👾", "🤖"];
async function createProfileFlow() {
  const body = `
    <label>Name <input id="npName" placeholder="e.g. Alex"></label>
    <label>PIN (optional — locks this profile) <input id="npPin" type="password" inputmode="numeric" placeholder="leave empty for none"></label>
    <div class="hint">Pick an avatar:</div>
    <div class="avatar-picker" id="npAvatars">${AVATARS.map((a, i) => `<button data-i="${i}" class="${i === 0 ? "sel" : ""}">${a}</button>`).join("")}</div>`;
  const res = await modal({ title: "New profile", body, ok: "Create" });
  if (!res.ok) return;
  const name = (res.values.npName || "").trim();
  const pin = (res.values.npPin || "").trim();
  const avatar = AVATARS[res.values.__avatarIndex] || "🙂";
  try {
    const r = await post("/api/profiles", { name, pin, avatar });
    TOKEN = r.token; LS.set("token", TOKEN);
    await enterApp(r.profile);
    toast(`Welcome, ${r.profile.name}!`, "ok");
  } catch (e) { toast(e.message, "error"); }
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("#npAvatars button");
  if (b) { document.querySelectorAll("#npAvatars button").forEach((x) => x.classList.remove("sel")); b.classList.add("sel"); }
});

async function manageProfiles() {
  if (!PROFILES.length) return toast("No profiles yet", "warn");
  const body = `<div class="hint">${PROFILES.map((p) => `${p.avatar} ${esc(p.name)}${p.hasPin ? " 🔒" : ""}`).join("<br>")}</div>
    <p class="hint">To rename, change avatar or set a PIN, sign in as that profile and use “Edit profile”.</p>`;
  await modal({ title: "Profiles", body, ok: "Close", cancel: "Close" });
}

$("whoami").onclick = () => $("profileMenu").classList.toggle("hidden");
$("switchProfileBtn").onclick = () => showGate();
document.addEventListener("click", (e) => {
  if (!e.target.closest("#profileMenu") && !e.target.closest("#whoami")) $("profileMenu").classList.add("hidden");
});
$("profileMenu").addEventListener("click", async (e) => {
  const what = e.target.dataset?.menu;
  if (!what) return;
  $("profileMenu").classList.add("hidden");
  if (what === "switch") return showGate();
  if (what === "signout") { await post("/api/logout", {}).catch(() => {}); TOKEN = null; LS.del("token"); return showGate(); }
  if (what === "edit") {
    const body = `
      <label>Name <input id="epName" value="${esc(me.name)}"></label>
      <label>New PIN <input id="epPin" type="password" placeholder="${me.hasPin ? "leave empty to keep" : "set one (optional)"}"></label>
      <label class="chip"><input type="checkbox" id="epClearPin"> Remove PIN</label>
      <div class="hint">Avatar:</div>
      <div class="avatar-picker" id="npAvatars">${AVATARS.map((a, i) => `<button data-i="${i}" class="${a === me.avatar ? "sel" : ""}">${a}</button>`).join("")}</div>`;
    const res = await modal({ title: "Edit profile", body, ok: "Save" });
    if (!res.ok) return;
    const payload = { name: (res.values.epName || "").trim(), avatar: AVATARS[res.values.__avatarIndex] || me.avatar };
    const pin = (res.values.epPin || "").trim();
    if (res.values.epClearPin) payload.pin = "";
    else if (pin) payload.pin = pin;
    try {
      const r = await patch(`/api/profiles/${me.id}`, payload);
      me = r; $("whoami").textContent = me.avatar; $("menuAvatar").textContent = me.avatar; $("menuName").textContent = me.name;
      toast("Profile updated", "ok");
      if (payload.pin !== undefined) { TOKEN = null; LS.del("token"); showGate(); }
    } catch (e) { toast(e.message, "error"); }
  }
});

/* ------------------------------------------------------- per-profile state */
function saveStateSoon(patchObj) {
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(async () => {
    try { await post(`/api/profiles/${me.id}/state`, patchObj); } catch { /* offline is fine */ }
  }, 700);
}
function setProgress(workId, chapterId, lang, level, title, percent = 0) {
  const key = `${workId}/${chapterId}/${lang}/${level}`;
  state.progress[key] = { workId, chapterId, lang, level, title, percent, at: Date.now() };
  saveStateSoon({ progress: { [key]: state.progress[key] }, level });
}
function isInMyList(workId) { return state.myList.includes(workId); }
function toggleMyList(workId) {
  const has = isInMyList(workId);
  state.myList = has ? state.myList.filter((x) => x !== workId) : [...state.myList, workId];
  saveStateSoon({ myList: { [has ? "remove" : "add"]: [workId] } });
  toast(has ? "Removed from My List" : "Added to My List", "ok");
  renderRows(); renderHero(); if (currentWork?.id === workId) updateMyListBtn();
  if (location.hash.startsWith("#/mylist")) renderMyList();
}

/* ------------------------------------------------------------ data loads */
async function loadLibrary() {
  const data = await API("/api/works");
  WORKS = data.works || data;
}
const workById = (id) => WORKS.find((w) => w.id === id);

function coverHtml(w, { progressPercent } = {}) {
  const hue = hashHue(w.title);
  const inList = isInMyList(w.id);
  return `
    <div class="cover" style="background:linear-gradient(150deg,hsl(${hue} 62% 26%),hsl(${(hue + 48) % 360} 58% 14%))">
      <span class="initials">${esc(initialsOf(w.title))}</span>
      <span class="cover-title">${esc(w.title)}</span>
      <span class="badges">${inList ? `<span class="list-badge">My List</span>` : ""}${w.warnings ? `<span class="warn-badge">⚠ ${w.warnings}</span>` : ""}</span>
      ${progressPercent ? `<span class="cover-progress"><span style="width:${Math.round(progressPercent)}%"></span></span>` : ""}
    </div>
    <div class="card-meta"><strong>${esc(w.title)}</strong>
      ${esc(w.author || "unknown author")} · ${w.volumeCount ? `${w.volumeCount} vol · ` : ""}${w.chapterCount} ch${w.translatedCount ? ` · ${w.translatedCount} tr` : ""}
    </div>`;
}

function cardHtml(w, opts = {}) {
  return `<div class="card-item" data-id="${w.id}">${coverHtml(w, opts)}</div>`;
}

/* ---------------------------------------------------------------- browse */
function renderHero() {
  const pool = WORKS.filter((w) => w.translatedCount > 0);
  const w = pool[Math.floor(Math.random() * Math.max(1, pool.length))] || WORKS[0];
  if (!w) { $("hero").innerHTML = `<div class="hero-inner"><h1>Your library is empty</h1><p class="blurb">Add a chapter or a whole volume to get started.</p><div class="hero-actions"><a href="#/add"><button>＋ Add chapters</button></a></div></div>`; $("hero").style.background = "linear-gradient(120deg,#1b1b22,#2a2a35)"; return; }
  const hue = hashHue(w.title);
  $("hero").style.background = `linear-gradient(120deg, hsl(${hue} 55% 22%), hsl(${(hue + 60) % 360} 50% 10%))`;
  $("hero").innerHTML = `
    <div class="hero-inner">
      <div class="meta">${esc(w.author || "unknown author")} · ${w.volumeCount ? `${w.volumeCount} volumes · ` : ""}${w.chapterCount} chapters · sources: ${(w.languages || []).map(langName).join(", ") || langName(w.lang)}</div>
      <h1>${esc(w.title)}</h1>
      <p class="blurb">${w.translatedCount ? `${w.translatedCount} translation(s) ready at Easy / Medium / Hard.` : "No translations yet — open it to translate."}</p>
      <div class="hero-actions">
        <button data-act="read">▶ Read</button>
        <button class="ghost" data-act="list">${isInMyList(w.id) ? "✓ My List" : "＋ My List"}</button>
        <button class="ghost" data-act="add">＋ Add chapters</button>
      </div>
    </div>`;
  $("hero").querySelector('[data-act="read"]').onclick = () => openWork(w.id);
  $("hero").querySelector('[data-act="list"]').onclick = () => toggleMyList(w.id);
  $("hero").querySelector('[data-act="add"]').onclick = () => { location.hash = `#/add?title=${encodeURIComponent(w.title)}&author=${encodeURIComponent(w.author || "")}`; };
}

function progressRow() {
  const entries = Object.values(state.progress || {}).sort((a, b) => b.at - a.at)
    .filter((e) => (e.percent ?? 0) < 100);
  if (!entries.length) return "";
  const items = entries.slice(0, 12).map((e) => {
    const w = workById(e.workId);
    if (!w) return "";
    return `<div class="card-item" data-id="${w.id}" data-chapter="${e.chapterId}" data-lang="${e.lang}" data-level="${e.level}">
      ${coverHtml(w, { progressPercent: e.percent || 5 })}
      <div class="card-meta">${esc(langName(e.lang))} · ${esc(LEVEL_LABEL[e.level] || "Medium")}</div>
    </div>`;
  }).join("");
  if (!items.trim()) return "";
  return `<div class="row-head"><h2>Continue reading</h2><span class="hint">private to ${esc(me.name)}</span></div><div class="row-scroll">${items}</div>`;
}

function renderRows() {
  const rows = [];
  rows.push(progressRow());
  const list = WORKS.filter((w) => isInMyList(w.id));
  if (list.length) rows.push(`<div class="row-head"><h2>My List</h2></div><div class="row-scroll">${list.map((w) => cardHtml(w)).join("")}</div>`);
  const recent = [...WORKS].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)).slice(0, 14);
  if (recent.length) rows.push(`<div class="row-head"><h2>Recently updated</h2></div><div class="row-scroll">${recent.map((w) => cardHtml(w)).join("")}</div>`);
  const translated = WORKS.filter((w) => w.translatedCount > 0).sort((a, b) => b.translatedCount - a.translatedCount).slice(0, 14);
  if (translated.length) rows.push(`<div class="row-head"><h2>Ready to read</h2></div><div class="row-scroll">${translated.map((w) => cardHtml(w)).join("")}</div>`);
  rows.push(`<div class="row-head"><h2>All stories</h2><span class="hint">${WORKS.length} in the shared library</span></div><div class="grid">${WORKS.map((w) => cardHtml(w)).join("")}</div>`);
  $("browseRows").innerHTML = rows.join("");
  document.querySelectorAll(".card-item").forEach((el) => (el.onclick = () => {
    if (el.dataset.chapter) location.hash = `#/work/${el.dataset.id}/chapter/${el.dataset.chapter}?lang=${el.dataset.lang}&level=${el.dataset.level}`;
    else location.hash = `#/work/${el.dataset.id}`;
  }));
}

function renderBrowse() { renderHero(); renderRows(); }

function renderMyList() {
  const list = WORKS.filter((w) => isInMyList(w.id));
  $("myListGrid").innerHTML = list.length ? list.map((w) => cardHtml(w)).join("") : `<p class="hint">Nothing saved yet — press “＋ My List” on any story.</p>`;
  document.querySelectorAll("#myListGrid .card-item").forEach((el) => (el.onclick = () => (location.hash = `#/work/${el.dataset.id}`)));
}

async function doSearch() {
  const q = $("search").value.trim();
  if (!q) return;
  const works = await API("/api/works?q=" + encodeURIComponent(q));
  const list = works.works || works;
  $("searchResults").innerHTML = list.length ? list.map((w) => cardHtml(w)).join("") : `<p class="hint">No story matches “${esc(q)}”.</p>`;
  document.querySelectorAll("#searchResults .card-item").forEach((el) => (el.onclick = () => (location.hash = `#/work/${el.dataset.id}`)));
}

/* -------------------------------------------------------------- routing */
function show(view) {
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.id === "view-" + view));
  document.querySelectorAll("#mainNav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === view));
  window.scrollTo({ top: 0 });
}
async function route() {
  if (!me) return;
  const hash = location.hash || "#/browse";
  const [pathPart, queryPart] = hash.replace(/^#\/?/, "").split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const qs = new URLSearchParams(queryPart || "");
  if (parts[0] === "work" && parts[1]) return openWork(parts[1], parts[3], qs.get("lang"), qs.get("level"));
  if (parts[0] === "add") { show("add"); return prefillAdd(qs); }
  if (parts[0] === "activity") { show("activity"); return loadActivity(); }
  if (parts[0] === "search") { show("search"); return; }
  if (parts[0] === "mylist") { show("mylist"); return renderMyList(); }
  if (parts[0] === "about") { show("about"); return loadHealth(); }
  show("browse"); renderBrowse();
}
window.addEventListener("hashchange", route);

/* --------------------------------------------------------------- reader */
async function openWork(workId, chapterId, lang, level) {
  currentWork = await API("/api/works/" + workId);
  const qs = new URLSearchParams((location.hash.split("?")[1] || ""));
  chapterId = chapterId || qs.get("chapter") || null;
  lang = lang || qs.get("lang") || null;
  level = level || qs.get("level") || null;
  currentChapter = chapterId || currentWork.chapters[0]?.id || null;
  const langs = [...new Set([...MAIN_LANGS, ...(currentWork.languages || []), currentWork.lang])];
  currentLang = lang && langs.includes(lang) ? lang : (currentWork.languages || []).includes("en") ? "en" : MAIN_LANGS.find((l) => langs.includes(l)) || "en";
  currentLevel = LEVELS.includes(level) ? level : (state.level || "medium");
  $("readerTitle").textContent = currentWork.title;
  $("readerSub").textContent = `${currentWork.author || "unknown author"} · ${currentWork.volumes?.length || 0} volumes · ${currentWork.chapters.length} chapters`;
  fillVolumeSelect(); fillChapterSelect(); fillLangSelect();
  $("difficultySelect").value = currentLevel;
  updateMyListBtn();
  show("reader");
  await loadTerms(); renderSuggestions(); await loadChapter();
}

function updateMyListBtn() {
  if (!currentWork) return;
  $("myListBtn").textContent = isInMyList(currentWork.id) ? "✓ My List" : "＋ My List";
}

const workVolumes = () => (currentWork?.volumes || []).filter((v) => v.chapterCount > 0);
const chaptersOfVolume = (key) => currentWork.chapters.filter((c) => (c.volumeKey || "") === (key || ""));

function fillVolumeSelect() {
  const vols = workVolumes();
  const labelled = vols.filter((v) => v.label);
  $("volumeWrap").classList.toggle("hidden", labelled.length === 0);
  if (!labelled.length) { currentVolume = vols[0]?.key || ""; return; }
  $("volumeSelect").innerHTML = vols.map((v) => `<option value="${esc(v.key)}">${esc(v.label || "Chapters")} (${v.chapterCount})</option>`).join("");
  const withCurrent = vols.find((v) => chaptersOfVolume(v.key).some((c) => c.id === currentChapter));
  currentVolume = withCurrent?.key ?? vols[0]?.key ?? "";
  $("volumeSelect").value = currentVolume;
}
function fillChapterSelect() {
  const list = chaptersOfVolume(currentVolume);
  const pool = list.length ? list : currentWork.chapters;
  $("chapterSelect").innerHTML = pool.map((c) => `<option value="${c.id}">${c.index}. ${esc(c.title)}${(c.translations || []).length ? " ✓" : ""}${c.warnings ? " ⚠" : ""}</option>`).join("");
  if (currentChapter && pool.some((c) => c.id === currentChapter)) $("chapterSelect").value = currentChapter;
  else currentChapter = pool[0]?.id || null;
}
function fillLangSelect() {
  const opts = [...new Set([...MAIN_LANGS, ...(currentWork.languages || []), currentWork.lang])];
  $("langSelect").innerHTML = opts.map((l) => `<option value="${l}">${esc(langName(l))}${l === currentWork.lang ? " (rewrite)" : ""}</option>`).join("");
  $("langSelect").value = opts.includes(currentLang) ? currentLang : (currentLang = opts[0]);
}

async function loadChapter() {
  currentChapter = $("chapterSelect").value;
  currentLang = $("langSelect").value;
  currentLevel = $("difficultySelect").value;
  const ch = await API(`/api/works/${currentWork.id}/chapters/${currentChapter}?lang=${currentLang}&difficulty=${currentLevel}`);
  const vol = ch.chapter.volume ? esc(ch.chapter.volume) + " · " : "";
  const note = ch.record && ch.record.difficulty !== currentLevel ? ` <em>(showing ${LEVEL_LABEL[ch.record.difficulty]} — ${LEVEL_LABEL[currentLevel]} not done yet)</em>` : "";
  $("readerMeta").innerHTML = ch.translation
    ? `${vol}${esc(langName(currentLang))} · <strong>${esc(LEVEL_LABEL[currentLevel])}</strong>${note}${ch.record?.provider ? ` · via ${esc(ch.record.provider)}` : ""}`
    : `${vol}Not translated to ${esc(langName(currentLang))} at ${esc(LEVEL_LABEL[currentLevel])} yet.`;
  const warn = ch.record?.warnings || [];
  $("warnBox").classList.toggle("hidden", !warn.length);
  const visibleWarnings = [...new Map(warn.map((w) => [`${w.code || ""}|${w.detail || ""}`, w])).values()];
  $("warnBox").classList.toggle("hidden", !visibleWarnings.length);
  $("warnBox").innerHTML = visibleWarnings.length
    ? `<strong>QA warnings:</strong><ul>${visibleWarnings.map((w) => `<li>${esc(w.detail)}${w.sample && !w.detail?.includes(w.sample) ? ` <code>${esc(w.sample)}</code>` : ""}</li>`).join("")}</ul>`
    : "";
  renderReader(ch.translation, ch.original, ch.lang);
  if (ch.translation || ch.original) setProgress(currentWork.id, currentChapter, currentLang, currentLevel, `${currentWork.title} · ${ch.chapter.title}`, 8);
}
function renderReader(translation, original, sourceLang) {
  const body = (s) => (s || "").split("\n\n").map((p) => `<p>${esc(p)}</p>`).join("") || `<p class="hint">No text.</p>`;
  if (splitOn) {
    $("readerBody").innerHTML = `<h3 class="hint">${esc(langName(sourceLang))}</h3>` + body(original);
    $("readerBody2").classList.remove("hidden");
    $("readerBody2").innerHTML = `<h3 class="hint">${esc(langName(currentLang))} · ${esc(LEVEL_LABEL[currentLevel])}</h3>` + body(translation);
  } else {
    $("readerBody2").classList.add("hidden");
    $("readerBody").innerHTML = translation ? body(translation) : `<h3 class="hint">${esc(langName(sourceLang))} (original — not translated at this level yet)</h3>` + body(original);
  }
}

$("chapterSelect").onchange = () => loadChapter();
$("langSelect").onchange = () => loadChapter();
$("difficultySelect").onchange = () => { state.level = currentLevel = $("difficultySelect").value; saveStateSoon({ level: currentLevel }); loadChapter(); };
$("volumeSelect").onchange = () => { currentVolume = $("volumeSelect").value; currentChapter = null; fillChapterSelect(); loadChapter(); };
$("backToBrowse").onclick = () => (location.hash = "#/browse");
$("myListBtn").onclick = () => toggleMyList(currentWork.id);
$("showOriginal").onclick = async () => {
  const ch = await API(`/api/works/${currentWork.id}/chapters/${currentChapter}?lang=`);
  renderReader(null, ch.original, ch.lang);
};
$("splitView").onclick = () => { splitOn = !splitOn; loadChapter(); };
$("copyChapter").onclick = async () => { await navigator.clipboard.writeText($("readerBody").innerText); toast("Chapter copied", "ok"); };
$("dlChapter").onclick = () => {
  const blob = new Blob([$("readerBody").innerText], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${currentWork.title}.${currentLang}.${currentLevel}.txt`.replace(/[^\w.\-]+/g, "_");
  a.click(); URL.revokeObjectURL(a.href);
};
$("shareChapter").onclick = async () => {
  const link = `${location.origin}/#/work/${currentWork.id}/chapter/${currentChapter}?lang=${currentLang}&level=${currentLevel}`;
  try { await navigator.clipboard.writeText(link); toast("Link copied", "ok"); } catch { prompt("Copy this link:", link); }
};
$("markRead").onclick = () => {
  setProgress(currentWork.id, currentChapter, currentLang, currentLevel, `${currentWork.title} · ${$("chapterSelect").selectedOptions[0]?.textContent || ""}`, 100);
  toast("Marked finished", "ok"); navChapter(1);
};
$("addToStory").onclick = () => {
  const qs = new URLSearchParams({ title: currentWork.title, author: currentWork.author || "", url: currentWork.sourceUrl || "" });
  if (currentWork.volumes?.length) qs.set("volume", currentWork.volumes.at(-1).label || "");
  location.hash = "#/add?" + qs.toString();
};

$("prevChapter").onclick = $("prevChapterBottom").onclick = () => navChapter(-1);
$("nextChapter").onclick = $("nextChapterBottom").onclick = () => navChapter(1);
function navChapter(dir) {
  const list = chaptersOfVolume(currentVolume);
  const pool = list.length ? list : currentWork.chapters;
  const i = pool.findIndex((c) => c.id === $("chapterSelect").value);
  const n = pool[i + dir];
  if (n) { $("chapterSelect").value = n.id; return loadChapter(); }
  const vols = workVolumes();
  const vi = vols.findIndex((v) => v.key === currentVolume);
  const nv = vols[vi + dir];
  if (nv) {
    currentVolume = nv.key;
    if (!$("volumeWrap").classList.contains("hidden")) $("volumeSelect").value = nv.key;
    const set = chaptersOfVolume(nv.key);
    const first = set[dir > 0 ? 0 : set.length - 1];
    if (first) { currentChapter = first.id; fillChapterSelect(); return loadChapter(); }
  }
  toast(dir > 0 ? "Last chapter" : "First chapter");
}
document.addEventListener("keydown", (e) => {
  if (!$("view-reader").classList.contains("active")) return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  if (e.key === "ArrowLeft") navChapter(-1);
  if (e.key === "ArrowRight") navChapter(1);
  if (e.key === "t") $("translateBtn").click();
  if (e.key === "o") $("showOriginal").click();
  if (e.key === "s") $("splitView").click();
  if (["1", "2", "3"].includes(e.key)) { $("difficultySelect").value = LEVELS[+e.key - 1]; $("difficultySelect").onchange(); }
});
window.addEventListener("scroll", () => {
  const total = document.documentElement.scrollHeight - window.innerHeight;
  $("progressBar").style.width = total > 0 ? Math.min(100, Math.max(0, (window.scrollY / total) * 100)) + "%" : "0%";
}, { passive: true });

async function doTranslate(force = false) {
  busy($("translateBtn"), true, "Translating…");
  try {
    const r = await post(`/api/works/${currentWork.id}/chapters/${currentChapter}/translate`, { target: currentLang, difficulty: currentLevel, force });
    const job = await followJob(r.jobId, { label: `${langName(currentLang)} · ${LEVEL_LABEL[currentLevel]}`, target: $("readerMeta") });
    const res = job?.result || {};
    toast(res.cached ? "Already done" : `Translated ${res.chunks} chunks via ${res.provider}`, res.qa?.ok === false ? "warn" : "ok");
    currentWork = await API("/api/works/" + currentWork.id);
    fillVolumeSelect(); fillChapterSelect(); await loadChapter(); refreshLibrarySoon();
  } catch (e) { toast("Error: " + e.message, "error"); }
  finally { busy($("translateBtn"), false); }
}
$("translateBtn").onclick = () => doTranslate(false);

$("translateAllBtn").onclick = async () => {
  const all = confirm(`Translate every chapter into ${langName(currentLang)}?\n\nOK = all three levels\nCancel = only ${LEVEL_LABEL[currentLevel]}`);
  const difficulties = all ? LEVELS : [currentLevel];
  if (!confirm(`That's ${currentWork.chapters.length * difficulties.length} chapter translation(s), running in the background. Start?`)) return;
  busy($("translateAllBtn"), true, "Starting…");
  try {
    const r = await post(`/api/works/${currentWork.id}/translate-all`, { target: currentLang, difficulties });
    busy($("translateAllBtn"), false);
    await followJob(r.jobId, { label: `${langName(currentLang)} × ${difficulties.length}`, target: $("readerMeta") });
    toast("Whole story translated", "ok");
    currentWork = await API("/api/works/" + currentWork.id);
    fillChapterSelect(); await loadChapter(); refreshLibrarySoon();
  } catch (e) { toast("Error: " + e.message, "error"); busy($("translateAllBtn"), false); }
};

async function followJob(jobId, { reload, label = "Working", target } = {}) {
  if (!jobId) return null;
  const out = target || $("readerMeta");
  let last = "";
  for (let i = 0; i < 3000; i++) {
    let job;
    try { job = await API(`/api/jobs/${jobId}`); }
    catch (e) {
      out.innerHTML = `Job lost (server restarted). <button id="jobRetry" class="ghost" type="button">Retry</button>`;
      $("jobRetry")?.addEventListener("click", () => $("translateBtn").click());
      throw new Error("The server restarted during this job — finished chunks are kept, press translate to resume.");
    }
    if (job.state === "running") {
      const line = `${esc(label)}… ${job.done}/${job.total}${job.current ? ` — ${esc(job.current)}` : ""}`;
      if (line !== last) { out.innerHTML = line; last = line; }
    }
    if (job.state === "interrupted") {
      throw new Error(job.error || "Interrupted by a restart — press translate to resume.");
    }
    if (job.state === "done" || job.state === "error") {
      await reload?.();
      if (job.state === "error") throw new Error(job.error || "job failed");
      if (job.errors?.length) toast(`${job.errors.length} rate-limit hits — retry to continue`, "warn");
      return job;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}
async function refreshLibrarySoon() { clearTimeout(saveStateTimer); setTimeout(async () => { await loadLibrary(); if (location.hash.startsWith("#/browse")) renderBrowse(); }, 1200); }

/* ------------------------------------------------------------- story settings */
$("storySettingsBtn").onclick = async () => {
  const w = currentWork;
  const title = prompt("Story title:", w.title); if (title === null) return;
  const author = (prompt("Author:", w.author || "") ?? w.author) || "";
  const notes = (prompt("Translator notes for this story:", w.settings?.notes || "") ?? "") || "";
  try { await patch(`/api/works/${w.id}`, { title, author, settings: { notes } }); toast("Story updated", "ok"); await loadLibrary(); openWork(w.id, currentChapter, currentLang, currentLevel); }
  catch (e) { toast(e.message, "error"); }
};

/* ----------------------------------------------------------------- terms */
async function loadTerms() {
  const data = await API(`/api/works/${currentWork.id}/terms?lang=${currentLang}`);
  window.__suggest = data; window.__terms = data.terms || [];
  renderTerms();
}
function renderTerms() {
  const all = window.__terms || [];
  const needle = ($("termSearch").value || "").trim().toLowerCase();
  const list = needle ? all.filter((t) => t.source.toLowerCase().includes(needle) || (t.canonical || "").toLowerCase().includes(needle)) : all;
  const CAP = 60;
  $("termCount").textContent = `${all.length} term(s)${needle || list.length > CAP ? ` · showing ${Math.min(list.length, CAP)}` : ""}`;
  $("terms").innerHTML = list.length
    ? list.slice(0, CAP).map((t) => `<div class="term" data-source="${esc(t.source)}" data-canonical="${esc(t.canonical)}">
        <span class="src">${esc(t.source)}</span> → <strong>${esc(t.canonical)}</strong>
        <span class="hint">(${esc(t.origin)}${t.variants?.length ? " · seen: " + t.variants.map(esc).join(", ") : ""})</span>
        <button class="edit ghost" type="button">Edit</button>
        <button class="del ghost" type="button" title="Delete this term">✕</button></div>`).join("") + (list.length > CAP ? `<p class="hint">…${list.length - CAP} more</p>` : "")
    : `<p class="hint">${all.length ? "No match." : "No terms yet for this language."}</p>`;
  document.querySelectorAll(".term .edit").forEach((b) => (b.onclick = () => {
    const t = b.closest(".term"); $("termSource").value = t.dataset.source; $("termCanonical").value = t.dataset.canonical;
  }));
  document.querySelectorAll(".term .del").forEach((b) => (b.onclick = async () => {
    const t = b.closest(".term");
    if (!confirm(`Delete term “${t.dataset.source}”?`)) return;
    try {
      await del(`/api/works/${currentWork.id}/terms/${encodeURIComponent(t.dataset.source)}`);
      toast("Term deleted", "ok");
      await loadTerms(); await loadChapter();
    } catch (e) { toast(e.message, "error"); }
  }));
}
$("termSearch").oninput = renderTerms;
function renderSuggestions() {
  const d = window.__suggest || { candidates: [], modelTerms: [] };
  const list = [...(d.candidates || []).map((c) => c.source), ...(d.modelTerms || []).map((t) => `${t.source} → ${t.translation}`)];
  $("termSuggest").textContent = list.length ? list.join(" · ") : "No new suggestions.";
}
$("saveTerm").onclick = async () => {
  const source = $("termSource").value.trim(), canonical = $("termCanonical").value.trim();
  if (!source || !canonical) return toast("Fill both boxes", "warn");
  busy($("saveTerm"), true, "Updating…");
  try { const r = await post(`/api/works/${currentWork.id}/terms`, { lang: currentLang, source, canonical }); toast(r.summary, "ok"); await loadTerms(); await loadChapter(); }
  catch (e) { toast(e.message, "error"); } finally { busy($("saveTerm"), false); }
};
$("acceptSuggestions").onclick = async () => {
  const d = window.__suggest || {};
  const pairs = [...(d.candidates || []), ...(d.modelTerms || []).map((t) => ({ source: t.source, suggested: t.translation }))];
  if (!pairs.length) return toast("Nothing to accept", "warn");
  for (const p of pairs) await post(`/api/works/${currentWork.id}/terms`, { lang: currentLang, source: p.source, canonical: p.suggested }).catch(() => {});
  toast(`Accepted ${pairs.length}`, "ok"); await loadTerms(); await loadChapter();
};
$("cleanTerms").onclick = async () => {
  if (!confirm("Remove auto-discovered noise? Your own terms are kept.")) return;
  const r = await post(`/api/works/${currentWork.id}/terms/clean`, {});
  toast(`Removed ${r.removed} (${r.before} → ${r.after})`, "ok"); await loadTerms(); await loadChapter();
};
$("refreshTerms").onclick = async () => {
  busy($("refreshTerms"), true, "Reading several chapters…");
  try {
    const r = await post(`/api/works/${currentWork.id}/terms/refresh`, { lang: currentLang });
    toast(`${r.mapped}/${r.total} terms now have a ${langName(currentLang)} form (+${r.added})`, "ok");
    await loadTerms(); await loadChapter();
  } catch (e) { toast(e.message, "error"); }
  finally { busy($("refreshTerms"), false); }
};
$("exportGloss").onclick = () => window.open(`/api/works/${currentWork.id}/glossary?lang=${currentLang}&format=csv`, "_blank");
$("importGlossFile").onchange = async () => {
  const f = $("importGlossFile").files[0]; if (!f) return;
  try { const r = await post(`/api/works/${currentWork.id}/glossary`, { lang: currentLang, data: await f.text() }); toast(`Imported ${r.imported}`, "ok"); await loadTerms(); await loadChapter(); }
  catch (e) { toast(e.message, "error"); }
};

/* ---------------------------------------------------------------- upload */
function prefillFromLast() {
  const last = LS.get("lastStory", null);
  if (last) { if (!$("title").value) $("title").value = last.title || ""; if (!$("author").value) $("author").value = last.author || ""; }
}
async function prefillAdd(qs) {
  prefillFromLast();
  const title = qs.get("title"), author = qs.get("author");
  if (title) $("title").value = title;
  if (author) $("author").value = author;
  const vol = qs.get("volume"); if (vol) $("volume").value = vol;
  if (title) {
    const w = WORKS.find((x) => x.title.toLowerCase() === title.toLowerCase());
    if (w) {
      const full = await API("/api/works/" + w.id);
      const inVol = full.chapters.filter((c) => !vol || (c.volume || "").toLowerCase() === vol.toLowerCase());
      const last = (inVol.length ? inVol : full.chapters).at(-1);
      const next = (last?.index || 0) + 1;
      $("chapterTitle").value = `Chapter ${next}`;
      if (!vol && last?.volume) $("volume").value = last.volume;
      $("addHint").textContent = `Adding to “${full.title}” — next up: ${last?.volume ? last.volume + " · " : ""}Chapter ${next} (${(inVol.length ? inVol : full.chapters).length} exist).`;
    }
  }
  updateUploadStats();
}
$("uploadFile").onchange = async () => {
  const f = $("uploadFile").files[0]; if (!f) return;
  busy($("uploadFile"), true, "Reading…");
  try {
    if (/\.(epub|html?|pdf|docx|rtf|fb2|zip)$/i.test(f.name)) {
      const buf = await f.arrayBuffer();
      let bin = ""; const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const parsed = await post("/api/parse-file", { name: f.name, dataBase64: btoa(bin) });
      $("uploadText").value = parsed.text;
      toast(`Parsed ${parsed.name}: ${parsed.chars.toLocaleString()} chars, ~${parsed.chapters} chapter(s)`, "ok");
    } else $("uploadText").value = await f.text();
    if (!$("title").value && f.name) $("title").value = f.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").replace(/\s*\b(vol(ume)?)\.?\s*\d+\s*$/i, "").trim();
    const vm = f.name.match(/\b(vol(?:ume)?\.?\s*\d+)\b/i);
    if (vm && !$("volume").value) $("volume").value = vm[1].replace(/\s+/g, " ");
    maybeDetectLanguage(); updateUploadStats();
  } catch (e) { toast("File error: " + e.message, "error"); } finally { busy($("uploadFile"), false); }
};
$("uploadText").oninput = () => { maybeDetectLanguage(); updateUploadStats(); };
$("uploadText").onpaste = () => setTimeout(() => { maybeDetectLanguage(); updateUploadStats(); }, 0);
function maybeDetectLanguage() {
  if (!$("autoDetect").checked) return;
  const t = $("uploadText").value; if (t.trim().length < 20) return;
  if (/[\u3040-\u30ff]/.test(t)) $("sourceLang").value = "ja";
  else if (/[\uac00-\ud7af]/.test(t)) $("sourceLang").value = "ko";
  else if (/[\u4e00-\u9fff]/.test(t)) $("sourceLang").value = "zh-CN";
  else if (/[äöüß]/i.test(t) && !/[ñ¿¡]/i.test(t)) $("sourceLang").value = "de";
  else if (/[ñáéíóú¿¡]/i.test(t)) $("sourceLang").value = "es";
  else if (/[åäö]/i.test(t)) $("sourceLang").value = "sv";
  else $("sourceLang").value = "en";
}
function updateUploadStats() {
  const n = $("uploadText").value.length;
  $("uploadStats").textContent = n ? `${n.toLocaleString()} chars ≈ ${Math.max(1, Math.ceil(n / 1800))} chunks` : "";
}
$("previewSplit").onclick = async () => {
  const text = $("uploadText").value.trim(); if (!text) return toast("Paste some text first", "warn");
  const r = await post("/api/works/preview-split", { text, volume: $("volume").value });
  $("splitPreview").innerHTML = `Detected <strong>${r.volumes?.length ? r.volumes.length + " volume(s) · " : ""}${r.count} chapter(s)</strong>: ` +
    r.chapters.slice(0, 30).map((c) => `<code>${esc(c.title || "(untitled)")}</code>`).join(" · ") + (r.chapters.length > 30 ? ` …+${r.chapters.length - 30}` : "");
};
async function saveChapters({ translate }) {
  const title = $("title").value.trim(), text = $("uploadText").value.trim();
  if (!title || !text) return toast("Story title and chapter text are required", "warn");
  const autoTranslateTo = translate ? [...document.querySelectorAll("#autoLangs input:checked")].map((i) => i.value) : [];
  const difficulties = translate ? [...document.querySelectorAll("#autoLevels input:checked")].map((i) => i.value) : [];
  const settings = { keepHonorifics: $("setHonorifics").checked, formality: $("setFormality").value, notes: $("setNotes").value };
  const btn = translate ? $("saveTranslate") : $("saveOnly");
  busy(btn, true, "Saving…");
  try {
    LS.set("lastStory", { title, author: $("author").value });
    const body = { title, author: $("author").value, sourceLang: $("sourceLang").value, sourceUrl: $("sourceUrl").value, autoTranslateTo, difficulties, settings, volume: $("volume").value };
    const r = $("autoSplit").checked ? await post("/api/works/bulk", { ...body, text }) : await post("/api/works", { ...body, text, chapterTitle: $("chapterTitle").value });
    toast("Saved", "ok"); clearAddForm();
    if (r.jobId) await followJob(r.jobId, { label: translate ? "Saving & translating" : "Saving", target: $("uploadResult") });
    await loadLibrary();
    location.hash = `#/work/${r.workId}`;
  } catch (e) { toast("Error: " + e.message, "error"); $("uploadResult").textContent = "Error: " + e.message; }
  finally { busy(btn, false); }
}
$("saveTranslate").onclick = () => saveChapters({ translate: true });
$("saveOnly").onclick = () => saveChapters({ translate: false });
function clearAddForm() { $("uploadText").value = ""; $("chapterTitle").value = ""; $("splitPreview").innerHTML = ""; $("uploadResult").innerHTML = ""; $("addHint").textContent = ""; updateUploadStats(); }

/* ------------------------------------------------------- activity / about */
async function loadActivity() {
  const feed = await API("/api/activity?limit=60");
  $("activityFeed").innerHTML = feed.length ? feed.map((a) => `<div class="feed-item"><span class="hint">${new Date(a.at).toLocaleString()}</span> <span class="badge">${esc(a.type)}</span> ${esc(a.detail || "")} ${a.workId ? `<a href="#/work/${a.workId}">open</a>` : ""}</div>`).join("") : `<p class="hint">No activity yet.</p>`;
}
async function loadHealth() {
  try {
    const h = await API("/api/health");
    $("healthBox").innerHTML = `<p>Storage: <strong>${esc(h.storageDescription)}</strong></p>
      <p>${h.stats.works} stories · ${h.stats.volumes || 0} volumes · ${h.stats.chapters} chapters · ${h.stats.translations} translations · ${h.stats.terms} terms · ${h.stats.warnings} QA warnings</p>`;
    const s = h.storageInfo;
    if (s && s.provider === "github") $("tokenBox").innerHTML = s.broadToken
      ? `<p class="warn-text">⚠ The GitHub token can access all your repositories — switch to a fine-grained token limited to the data repo (see README).</p>`
      : `<p>✅ GitHub token is scoped narrow.</p>`;
    const pool = h.pool || [];
    $("poolBox").innerHTML = `<p>Free model pool: ${(h.providers || []).map((p) => `${esc(p.provider)}${p.keyless ? " (keyless)" : ""}`).join(", ") || "none"}</p>` +
      (pool.length ? `<p class="hint">${pool.map((p) => `${esc(p.provider)}: ${p.ok} ok / ${p.failed} failed${p.coolingDown ? " (cooling " + Math.round(p.cooldownMs / 1000) + "s)" : ""}`).join(" · ")}</p>` : "");
    $("footerInfo").textContent = `Storage: ${h.storage} · free provider pool · profile: ${me?.name || "-"}`;
  } catch { /* ignore */ }
}
$("exportAll").onclick = () => window.open("/api/export", "_blank");
$("reloadStore").onclick = async () => { try { await post("/api/reload", {}); toast("Reloaded", "ok"); await loadLibrary(); renderBrowse(); } catch (e) { toast(e.message, "error"); } };
$("importAllFile").onchange = async () => {
  const f = $("importAllFile").files[0]; if (!f) return;
  try { const r = await post("/api/import", { payload: JSON.parse(await f.text()) }); $("backupResult").textContent = `Imported: ${r.works} stories, ${r.chapters} chapters, ${r.terms} terms.`; toast("Import complete", "ok"); await loadLibrary(); }
  catch (e) { toast("Import error: " + e.message, "error"); }
};

/* ----------------------------------------------------------- reader look */
$("readerLookBtn").onclick = () => $("lookPanel").classList.toggle("hidden");
function bindUi() {
  $("searchGo").onclick = doSearch;
  $("search").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  $("theme").onchange = () => { state.look.theme = $("theme").value; persistLook(); };
  $("fontFamily").onchange = () => { state.look.font = $("fontFamily").value; persistLook(); };
  $("fontSize").oninput = () => { state.look.size = +$("fontSize").value; persistLook(); };
  $("lineHeight").onchange = () => { state.look.line = $("lineHeight").value; persistLook(); };
  $("readWidth").onchange = () => { state.look.width = $("readWidth").value; persistLook(); };
  $("pageBg").onchange = () => { state.look.bg = $("pageBg").value; persistLook(); };
  $("letterSpacing").onchange = () => { state.look.spacing = $("letterSpacing").value; persistLook(); };
  $("justifyText").onchange = () => { state.look.justify = $("justifyText").checked; persistLook(); };
}
function persistLook() { applyLook(); saveStateSoon({ look: state.look }); $("lookSaved").textContent = "saved to your profile"; setTimeout(() => ($("lookSaved").textContent = ""), 1500); }
function applyLook() {
  const l = { ...DEFAULT_LOOK, ...(state.look || {}) };
  state.look = l;
  $("theme").value = l.theme; $("fontFamily").value = l.font; $("fontSize").value = l.size;
  $("lineHeight").value = l.line; $("readWidth").value = l.width; $("pageBg").value = l.bg;
  $("letterSpacing").value = l.spacing; $("justifyText").checked = !!l.justify;
  document.documentElement.dataset.theme = l.theme === "auto" ? "" : l.theme;
  document.body.dataset.pagebg = l.bg;
  for (const el of [$("readerBody"), $("readerBody2")]) {
    el.style.fontFamily = FONTS[l.font] || FONTS.serif;
    el.style.fontSize = l.size + "px";
    el.style.lineHeight = l.line;
    el.style.letterSpacing = l.spacing;
    el.classList.toggle("justify", !!l.justify);
  }
  document.documentElement.style.setProperty("--read-width", l.width);
  document.documentElement.style.setProperty("--read-space", (l.size * 0.75).toFixed(0) + "px");
}
function registerPWA() { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {}); }

/* resume: show the profile gate every visit (Netflix-style), remembering who was
   here last, but never auto-enter a profile with a PIN. */
(async () => {
  try { await boot(); } catch (e) { toast("Startup error: " + e.message, "error"); }
  if (TOKEN) {
    try {
      const r = await API("/api/me");
      if (r.profile) {
        $("gateMsg").textContent = `Last used: ${r.profile.avatar} ${r.profile.name} — tap a profile to continue.`;
      }
    } catch { TOKEN = null; LS.del("token"); }
  }
})();
