/* SPA: hash routing, shared library, reader with preferences, terms, activity,
   bulk upload, glossary import/export, backups, PWA. No framework. */
const $ = (id) => document.getElementById(id);
const API = async (path, opts) => {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
};
const post = (p, b) => API(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const patch = (p, b) => API(p, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const del = (p) => API(p, { method: "DELETE" });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem("ln." + k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem("ln." + k, JSON.stringify(v)); },
};

function toast(msg, kind = "info") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 4200);
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.old = btn.textContent; btn.disabled = true; btn.textContent = label || "Working…"; }
  else { btn.disabled = false; if (btn.dataset.old) btn.textContent = btn.dataset.old; }
}

let LANG = [];
let currentWork = null;
let currentChapter = null;
let currentLang = "";
let readerPrefs = LS.get("prefs", { fontSize: 18, theme: "auto", split: false });

/* ------------------------------------------------------------------- boot */
document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => (location.hash = b.dataset.route)));
window.addEventListener("hashchange", route);

async function boot() {
  LANG = await API("/api/languages");
  for (const l of LANG) {
    $("source").add(new Option(l.name, l.code));
    $("sourceLang").add(new Option(l.name, l.code));
    if (l.code !== "auto") $("target").add(new Option(l.name, l.code));
  }
  $("source").value = "auto";
  $("target").value = "en";
  $("sourceLang").value = "ja";
  for (const code of ["en", "es", "sv"]) {
    const label = document.createElement("label");
    label.className = "chip";
    label.innerHTML = `<input type="checkbox" id="auto_${code}" value="${code}" ${code === "en" ? "checked" : ""}> ${LANG.find((l) => l.code === code)?.name || code}`;
    $("autoLangs").appendChild(label);
  }
  applyPrefs();
  loadHealth();
  registerPWA();
  if (!location.hash) location.hash = "#/";
  route();
}
boot().catch((e) => toast("Startup error: " + e.message, "error"));

function show(view) {
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.id === "view-" + view));
}

async function route() {
  const hash = location.hash || "#/";
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "work" && parts[1]) {
    await openWork(parts[1], parts[3] || parts[2], parts[5] || new URLSearchParams(hash.split("?")[1] || "").get("lang"));
    return;
  }
  if (parts[0] === "add") { show("add"); return; }
  if (parts[0] === "activity") { show("activity"); loadActivity(); return; }
  if (parts[0] === "quick") { show("quick"); return; }
  if (parts[0] === "about") { show("about"); loadHealth(); return; }
  if (parts[0] === "search") { show("library"); $("search").value = decodeURIComponent(parts[1] || ""); loadWorks(); return; }
  show("library");
  loadStats();
  loadWorks();
  loadContinue();
}

/* -------------------------------------------------------------- health/footer */
async function loadHealth() {
  try {
    const h = await API("/api/health");
    $("healthBox").innerHTML =
      `<p>Storage: <strong>${esc(h.storageDescription)}</strong> (${esc(h.storage)})</p>` +
      `<p>Models: Groq ${h.keys.groq ? "✅ configured" : "❌ missing"} · Gemini ${h.keys.gemini ? "✅ backup ready" : "— not set"}</p>` +
      `<p>${h.stats.works} stories · ${h.stats.chapters} chapters · ${h.stats.translations} translations · ${h.stats.terms} terms · ${h.stats.tmSegments} memory segments · ${h.stats.calls} model calls · ${h.stats.warnings} QA warnings</p>` +
      (h.editTokenRequired ? `<p class="hint">Editing is protected by an edit token.</p>` : `<p class="hint">Open editing (set EDIT_TOKEN to protect it).</p>`);
    $("footerInfo").textContent = `Storage: ${h.storage} · Groq primary · Gemini backup`;
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ library */
async function loadStats() {
  const s = await API("/api/stats");
  $("globalStats").textContent = `${s.works} stories · ${s.chapters} chapters · ${s.translations} translations · ${s.terms} terms · ${s.tmSegments} memory segments${s.warnings ? ` · ⚠ ${s.warnings} QA warnings` : ""}`;
}

async function loadWorks() {
  const works = await API("/api/works?q=" + encodeURIComponent($("search").value || ""));
  $("works").innerHTML = works.length
    ? works.map((w) => `
      <div class="work" data-id="${w.id}">
        <h3>${esc(w.title)} ${w.warnings ? `<span class="badge warn">⚠ ${w.warnings}</span>` : ""}</h3>
        <p class="hint">${esc(w.author || "unknown author")} · source ${esc(langName(w.lang))} · ${w.chapterCount} chapter(s) · ${w.translatedCount} translation(s)
          ${w.languages?.length ? "· " + w.languages.map((l) => esc(langName(l))).join(", ") : ""}</p>
      </div>`).join("")
    : `<p class="hint">No stories yet — add a chapter to start the shared library.</p>`;
  document.querySelectorAll(".work").forEach((el) => (el.onclick = () => (location.hash = `#/work/${el.dataset.id}`)));
}

$("search").addEventListener("keydown", (e) => { if (e.key === "Enter") location.hash = `#/search/${encodeURIComponent($("search").value)}`; });
$("searchGo").onclick = () => (location.hash = `#/search/${encodeURIComponent($("search").value)}`);

function loadContinue() {
  const recent = Object.entries(LS.get("progress", {})).map(([k, v]) => ({ ...v, key: k })).sort((a, b) => b.at - a.at).slice(0, 6);
  $("continueWrap").classList.toggle("hidden", !recent.length);
  $("continueList").innerHTML = recent.map((r) => `<a class="chip" href="#/work/${r.workId}/chapter/${r.chapterId}?lang=${r.lang}">${esc(r.title)} · ${esc(langName(r.lang))}</a>`).join("");
}

const langName = (code) => LANG.find((l) => l.code === code)?.name || code;

/* ------------------------------------------------------------------- reader */
async function openWork(workId, chapterId, lang) {
  currentWork = await API("/api/works/" + workId);
  currentChapter = chapterId || currentWork.chapters[0]?.id || null;
  const langs = [...new Set([...currentWork.languages, "en", "es", "sv"])].filter((l) => l !== currentWork.lang);
  currentLang = lang && langs.includes(lang) ? lang : langs.includes("en") ? "en" : langs[0];
  $("readerTitle").textContent = currentWork.title + (currentWork.author ? " — " + currentWork.author : "");
  fillChapterSelect();
  fillLangSelect();
  show("reader");
  await loadTerms();
  renderSuggestions();
  await loadChapter();
}

function fillChapterSelect() {
  $("chapterSelect").innerHTML = [...currentWork.chapters].sort((a, b) => a.index - b.index)
    .map((c) => `<option value="${c.id}">${c.index}. ${esc(c.title)}${c.translations.length ? " ✓" : ""}${c.warnings ? " ⚠" : ""}</option>`).join("");
  if (currentChapter) $("chapterSelect").value = currentChapter;
}
function fillLangSelect() {
  const opts = [...new Set([...currentWork.languages, "en", "es", "sv", "ja", "ko", "zh-CN"])].filter((l) => l !== currentWork.lang);
  $("langSelect").innerHTML = opts.map((l) => `<option value="${l}">${esc(langName(l))}</option>`).join("");
  $("langSelect").value = opts.includes(currentLang) ? currentLang : (currentLang = opts[0]);
}

async function loadChapter() {
  currentChapter = $("chapterSelect").value;
  currentLang = $("langSelect").value;
  const ch = await API(`/api/works/${currentWork.id}/chapters/${currentChapter}?lang=${currentLang}`);
  const body = ch.translation || "";
  $("readerMeta").innerHTML = ch.translation
    ? `Translated to <strong>${esc(langName(currentLang))}</strong>${ch.record?.provider ? ` via ${esc(ch.record.provider)}` : ""} · available: ${ch.available.map(langName).join(", ") || "none"}`
    : `Not translated to ${esc(langName(currentLang))} yet — press <em>Translate / ensure</em>. Available: ${ch.available.map(langName).join(", ") || "none"}`;
  const warn = ch.record?.warnings || [];
  $("warnBox").classList.toggle("hidden", !warn.length);
  $("warnBox").innerHTML = warn.length ? `<strong>QA warnings for this chapter:</strong><ul>${warn.map((w) => `<li class="${w.severity}">${esc(w.detail)}${w.sample ? ` <code>${esc(w.sample)}</code>` : ""}</li>`).join("")}</ul>` : "";
  renderReader(body, ch.original, ch.lang);
  if (ch.translation || ch.original) {
    const progress = LS.get("progress", {});
    progress[`${currentWork.id}/${currentChapter}/${currentLang}`] = { at: Date.now(), workId: currentWork.id, chapterId: currentChapter, lang: currentLang, title: `${currentWork.title} · ${ch.chapter.title}` };
    LS.set("progress", progress);
  }
}

function renderReader(translation, original, sourceLang) {
  const showText = (s) => (s || "").split("\n\n").map((p) => `<p>${esc(p)}</p>`).join("") || `<p class="hint">No text.</p>`;
  if (readerPrefs.split) {
    $("readerBody").innerHTML = `<h3 class="hint">${esc(langName(sourceLang))} (original)</h3>` + showText(original);
    $("readerBody2").classList.remove("hidden");
    $("readerBody2").innerHTML = `<h3 class="hint">${esc(langName(currentLang))}</h3>` + showText(translation);
  } else {
    $("readerBody2").classList.add("hidden");
    $("readerBody").innerHTML = showText(translation || original);
    if (!translation) $("readerBody").innerHTML = `<h3 class="hint">${esc(langName(sourceLang))} (original)</h3>` + showText(original);
  }
}

$("chapterSelect").onchange = () => loadChapter();
$("langSelect").onchange = () => loadChapter();
$("backToLibrary").onclick = () => (location.hash = "#/");
$("showOriginal").onclick = async () => {
  const ch = await API(`/api/works/${currentWork.id}/chapters/${currentChapter}?lang=`);
  renderReader(null, ch.original, ch.lang);
  $("readerMeta").textContent = "Original · " + langName(ch.lang);
};
$("splitView").onclick = () => { readerPrefs.split = !readerPrefs.split; LS.set("prefs", readerPrefs); applyPrefs(); loadChapter(); };
$("copyChapter").onclick = async () => { await navigator.clipboard.writeText($("readerBody").innerText); toast("Chapter copied", "ok"); };
$("dlChapter").onclick = () => {
  const blob = new Blob([$("readerBody").innerText], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${currentWork.title}.${currentLang}.txt`.replace(/[^\w.\-]+/g, "_");
  a.click();
  URL.revokeObjectURL(a.href);
};
$("shareChapter").onclick = async () => {
  const link = `${location.origin}/#/work/${currentWork.id}/chapter/${currentChapter}?lang=${currentLang}`;
  try { await navigator.clipboard.writeText(link); toast("Link copied: " + link, "ok"); } catch { prompt("Copy this link:", link); }
};

$("prevChapter").onclick = () => navChapter(-1);
$("nextChapter").onclick = () => navChapter(1);
function navChapter(dir) {
  const list = [...currentWork.chapters].sort((a, b) => a.index - b.index);
  const i = list.findIndex((c) => c.id === $("chapterSelect").value);
  const n = list[i + dir];
  if (n) { $("chapterSelect").value = n.id; loadChapter(); window.scrollTo({ top: 0, behavior: "smooth" }); }
  else toast(dir > 0 ? "Last chapter" : "First chapter");
}
document.addEventListener("keydown", (e) => {
  if (!document.getElementById("view-reader").classList.contains("active")) return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  if (e.key === "ArrowLeft") navChapter(-1);
  if (e.key === "ArrowRight") navChapter(1);
  if (e.key === "t") $("translateBtn").click();
  if (e.key === "o") $("showOriginal").click();
  if (e.key === "s") $("splitView").click();
});

$("translateBtn").onclick = async () => {
  busy($("translateBtn"), true, "Translating…");
  $("readerMeta").textContent = "Translating… (reuses memory, keeps this story's terms)";
  try {
    const r = await post(`/api/works/${currentWork.id}/chapters/${currentChapter}/translate`, { target: currentLang });
    toast(r.cached ? "Loaded from memory" : `Translated ${r.chunks} chunks via ${r.provider}`, r.qa?.ok === false ? "warn" : "ok");
    currentWork = await API("/api/works/" + currentWork.id);
    fillChapterSelect();
    await loadChapter();
    loadStats();
  } catch (e) { toast("Error: " + e.message, "error"); $("readerMeta").textContent = "Error: " + e.message; }
  finally { busy($("translateBtn"), false); }
};

/* ------------------------------------------------------------- story settings */
$("storySettingsBtn").onclick = async () => {
  const w = currentWork;
  const title = prompt("Story title:", w.title);
  if (title === null) return;
  const author = (prompt("Author:", w.author || "") ?? w.author) || "";
  const sourceUrl = prompt("Source URL:", w.sourceUrl || "") ?? w.sourceUrl;
  const notes = (prompt("Translator notes for this story:", w.settings?.notes || "") ?? w.settings?.notes) || "";
  try {
    await patch(`/api/works/${w.id}`, { title, author, sourceUrl, settings: { notes } });
    toast("Story updated", "ok");
    openWork(w.id, currentChapter, currentLang);
  } catch (e) { toast("Error: " + e.message, "error"); }
};

/* ----------------------------------------------------------------- terms */
async function loadTerms() {
  const data = await API(`/api/works/${currentWork.id}/terms?lang=${currentLang}`);
  window.__suggest = data;
  $("terms").innerHTML = data.terms.length
    ? data.terms.map((t) => `
      <div class="term" data-source="${esc(t.source)}" data-canonical="${esc(t.canonical)}">
        <span class="src">${esc(t.source)}</span> → <strong>${esc(t.canonical)}</strong>
        <span class="hint">(${esc(t.origin)}${t.variants?.length ? " · seen: " + t.variants.map(esc).join(", ") : ""})</span>
        <button class="edit" type="button">Edit</button>
      </div>`).join("")
    : `<p class="hint">No terms recorded yet for ${esc(langName(currentLang))}. They appear as chapters are translated, or add one below.</p>`;
  document.querySelectorAll(".term .edit").forEach((b) => (b.onclick = () => {
    const t = b.closest(".term");
    $("termSource").value = t.dataset.source;
    $("termCanonical").value = t.dataset.canonical;
  }));
}

function renderSuggestions() {
  const d = window.__suggest || { candidates: [], modelTerms: [] };
  const list = [...(d.candidates || []).map((c) => c.source), ...(d.modelTerms || []).map((t) => `${t.source} → ${t.translation}`)];
  $("termSuggest").textContent = list.length ? list.join(" · ") : "No new suggestions.";
}

$("saveTerm").onclick = async () => {
  const source = $("termSource").value.trim(), canonical = $("termCanonical").value.trim();
  if (!source || !canonical) return toast("Fill both boxes", "warn");
  busy($("saveTerm"), true, "Updating all chapters…");
  try {
    const r = await post(`/api/works/${currentWork.id}/terms`, { lang: currentLang, source, canonical });
    $("termResult").textContent = r.summary;
    toast(r.summary, "ok");
    await loadTerms(); renderSuggestions(); await loadChapter();
  } catch (e) { toast("Error: " + e.message, "error"); }
  finally { busy($("saveTerm"), false); }
};

$("acceptSuggestions").onclick = async () => {
  const d = window.__suggest || {};
  const pairs = [...(d.candidates || []), ...(d.modelTerms || []).map((t) => ({ source: t.source, suggested: t.translation }))];
  if (!pairs.length) return toast("Nothing to accept", "warn");
  busy($("acceptSuggestions"), true, `Saving ${pairs.length}…`);
  try {
    for (const p of pairs) await post(`/api/works/${currentWork.id}/terms`, { lang: currentLang, source: p.source, canonical: p.suggested });
    toast(`Accepted ${pairs.length} terms`, "ok");
    await loadTerms(); renderSuggestions(); await loadChapter();
  } catch (e) { toast("Error: " + e.message, "error"); }
  finally { busy($("acceptSuggestions"), false); }
};

$("exportGloss").onclick = () => window.open(`/api/works/${currentWork.id}/glossary?lang=${currentLang}&format=csv`, "_blank");
$("importGlossPaste").onclick = async () => {
  const data = $("glossImport").value.trim();
  if (!data) return toast("Paste a glossary first", "warn");
  try { const r = await post(`/api/works/${currentWork.id}/glossary`, { lang: currentLang, data }); toast(`Imported ${r.imported} terms`, "ok"); await loadTerms(); await loadChapter(); }
  catch (e) { toast("Error: " + e.message, "error"); }
};
$("importGlossFile").onchange = async () => {
  const f = $("importGlossFile").files[0]; if (!f) return;
  const data = await f.text();
  try { const r = await post(`/api/works/${currentWork.id}/glossary`, { lang: currentLang, data }); toast(`Imported ${r.imported} terms`, "ok"); await loadTerms(); await loadChapter(); }
  catch (e) { toast("Error: " + e.message, "error"); }
};

/* ------------------------------------------------------------------ upload */
$("uploadFile").onchange = async () => {
  const f = $("uploadFile").files[0]; if (!f) return;
  busy($("uploadFile"), true, "Reading…");
  try {
    if (/\.epub$|\.html?$/i.test(f.name)) {
      const buf = await f.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const parsed = await post("/api/parse-file", { name: f.name, dataBase64: b64 });
      $("uploadText").value = parsed.text;
      toast(`Parsed ${parsed.name}: ${parsed.chars} chars, ~${parsed.chapters} chapter(s)`, "ok");
    } else {
      $("uploadText").value = await f.text();
    }
    updateUploadStats();
  } catch (e) { toast("File error: " + e.message, "error"); }
  finally { busy($("uploadFile"), false); }
};

$("uploadText").oninput = updateUploadStats;
function updateUploadStats() {
  const n = $("uploadText").value.length;
  $("uploadStats").textContent = n ? `${n.toLocaleString()} chars ≈ ${Math.max(1, Math.ceil(n / 1800))} chunks` : "";
}

$("previewSplit").onclick = async () => {
  const text = $("uploadText").value.trim();
  if (!text) return toast("Paste some text first", "warn");
  const r = await post("/api/works/preview-split", { text });
  $("splitPreview").innerHTML = `Detected <strong>${r.count}</strong> chapter(s): ` + r.chapters.map((c) => `<code>${esc(c.title || "(untitled)")}</code> (${c.chars})`).join(" · ");
};

$("saveChapter").onclick = async () => {
  const title = $("title").value.trim(), text = $("uploadText").value.trim();
  if (!title || !text) return toast("Story title and chapter text are required", "warn");
  const autoTranslateTo = [...document.querySelectorAll('#autoLangs input:checked')].map((i) => i.value);
  const settings = { keepHonorifics: $("setHonorifics").checked, formality: $("setFormality").value, notes: $("setNotes").value };
  busy($("saveChapter"), true, autoTranslateTo.length ? "Saving & translating…" : "Saving…");
  try {
    const body = { title, author: $("author").value, sourceLang: $("sourceLang").value, sourceUrl: $("sourceUrl").value, autoTranslateTo, settings };
    const r = $("autoSplit").checked
      ? await post("/api/works/bulk", { ...body, text })
      : await post("/api/works", { ...body, text, chapterTitle: $("chapterIndexTitle")?.value || "" });
    const bits = [];
    if (r.chapters) bits.push(`Saved ${r.chapters.filter((c) => c.created).length} new chapter(s)${r.chapters.some((c) => c.duplicate) ? `, ${r.chapters.filter((c) => c.duplicate).length} already existed` : ""}${r.chapters.some((c) => c.version) ? `, ${r.chapters.filter((c) => c.version).length} updated (old version kept)` : ""}.`);
    else bits.push(r.duplicate ? "Already in the library (same text)." : r.version ? "Saved as a new version." : "Chapter saved.");
    if (r.termsAdded) bits.push(`${r.termsAdded} terms recorded.`);
    if (r.translated?.length) bits.push(`Translated: ${typeof r.translated[0] === "string" ? r.translated.length + " item(s)" : r.translated.map(langName).join(", ")}.`);
    if (r.translateError) bits.push("Translation issue: " + r.translateError);
    $("uploadResult").innerHTML = bits.join(" ") + ` <a href="#/work/${r.workId}">Open story →</a>`;
    toast("Saved", "ok");
    loadStats();
  } catch (e) { toast("Error: " + e.message, "error"); $("uploadResult").textContent = "Error: " + e.message; }
  finally { busy($("saveChapter"), false); }
};

/* --------------------------------------------------------------- activity */
async function loadActivity() {
  const feed = await API("/api/activity?limit=60");
  $("activityFeed").innerHTML = feed.length
    ? feed.map((a) => `<div class="feed-item"><span class="when">${new Date(a.at).toLocaleString()}</span> <span class="badge">${esc(a.type)}</span> ${esc(a.detail || "")} ${a.lang ? `<span class="hint">(${esc(langName(a.lang))})</span>` : ""} ${a.workId ? `<a href="#/work/${a.workId}">open</a>` : ""}</div>`).join("")
    : `<p class="hint">No activity yet.</p>`;
}

/* ------------------------------------------------------- quick translate */
$("swap").onclick = () => { if ($("source").value === "auto") return; const s = $("source").value; $("source").value = $("target").value; $("target").value = s; };
$("go").onclick = async () => {
  const t = $("input").value.trim(); if (!t) return toast("Paste some text first", "warn");
  const engine = document.querySelector('input[name="engine"]:checked').value;
  busy($("go"), true, "Translating…");
  try {
    const r = await post("/api/translate", { text: t, source: $("source").value, target: $("target").value, engine: engine === "ai" ? "ai" : "free", chain: engine === "ai" ? "auto" : undefined });
    $("output").value = r.translation;
    $("progress").textContent = `${r.chunks} chunks · via ${r.provider || r.engine}`;
  } catch (e) { toast("Error: " + e.message, "error"); $("progress").textContent = "Error: " + e.message; }
  finally { busy($("go"), false); }
};

/* ---------------------------------------------------------- backup/restore */
$("exportAll").onclick = () => window.open("/api/export", "_blank");
$("importAllFile").onchange = async () => {
  const f = $("importAllFile").files[0]; if (!f) return;
  busy($("importAllFile"), true, "Importing…");
  try {
    const payload = JSON.parse(await f.text());
    const r = await post("/api/import", { payload });
    $("backupResult").textContent = `Imported: ${r.works} stories, ${r.chapters} chapters, ${r.translations} translations, ${r.texts} texts, ${r.terms} terms, ${r.tm} memory segments.`;
    toast("Import complete", "ok");
    loadStats();
  } catch (e) { toast("Import error: " + e.message, "error"); }
  finally { busy($("importAllFile"), false); }
};

/* ------------------------------------------------------------- reader prefs */
function applyPrefs() {
  const p = readerPrefs;
  $("fontSize").value = p.fontSize;
  $("theme").value = p.theme;
  $("readerBody").style.fontSize = p.fontSize + "px";
  $("readerBody2").style.fontSize = p.fontSize + "px";
  document.documentElement.dataset.theme = p.theme === "auto" ? "" : p.theme;
  $("readerPane").classList.toggle("split", !!p.split);
  $("splitView").classList.toggle("on", !!p.split);
}
$("fontSize").oninput = () => { readerPrefs.fontSize = +$("fontSize").value; LS.set("prefs", readerPrefs); applyPrefs(); };
$("theme").onchange = () => { readerPrefs.theme = $("theme").value; LS.set("prefs", readerPrefs); applyPrefs(); };

/* ------------------------------------------------------------------- PWA */
function registerPWA() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}
