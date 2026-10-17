/* SPA: hash routing, shared library with volumes and reading levels, reader with
   themes/typography, terms, activity, bulk upload, backups, PWA. No framework. */
const $ = (id) => document.getElementById(id);
const API = async (path, opts) => {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
};
const post = (p, b) => API(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const patch = (p, b) => API(p, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem("ln." + k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem("ln." + k, JSON.stringify(v)); },
};

const MAIN_LANGS = ["en", "es", "sv", "de"];           // the main targets
const LEVELS = ["easy", "medium", "hard"];
const LEVEL_LABEL = { easy: "Easy", medium: "Medium", hard: "Hard" };

function toast(msg, kind = "info") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 5000);
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
let currentLevel = "medium";
let currentVolume = null;
let lastStory = LS.get("lastStory", null);
let look = LS.get("look", { theme: "auto", font: "serif", size: 18, line: "1.7", width: "46rem", justify: false });
let splitOn = LS.get("split", false);

const langName = (code) => LANG.find((l) => l.code === code)?.name || code;

function detectLang(text) {
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af\u1100-\u11ff]/.test(text)) return "ko";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh-CN";
  if (/[äöüß]/i.test(text) && !/[ñ¿¡]/i.test(text)) return "de";
  if (/[ñáéíóú¿¡]/i.test(text)) return "es";
  if (/[åäö]/i.test(text)) return "sv";
  return "en";
}

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
  bindLookControls();
  applyLook();
  loadHealth();
  registerPWA();
  prefillFromLast();
  if (!location.hash) location.hash = "#/";
  route();
  window.addEventListener("scroll", updateProgress, { passive: true });
}
boot().catch((e) => toast("Startup error: " + e.message, "error"));

function show(view) {
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.id === "view-" + view));
}

async function route() {
  const hash = location.hash || "#/";
  const [pathPart, queryPart] = hash.replace(/^#\/?/, "").split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const qs = new URLSearchParams(queryPart || "");
  if (parts[0] === "work" && parts[1]) { await openWork(parts[1], parts[3], qs.get("lang"), qs.get("level")); return; }
  if (parts[0] === "add") { show("add"); await prefillAdd(qs); return; }
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
      `<p>Models: Groq ${h.keys.groq ? "✅ primary" : "❌ missing"} · Gemini ${h.keys.gemini ? "✅ backup ready" : "— not set"}</p>` +
      `<p>${h.stats.works} stories · ${h.stats.volumes || 0} volumes · ${h.stats.chapters} chapters · ${h.stats.translations} translations · ${h.stats.terms} terms · ${h.stats.tmSegments} memory segments · ${h.stats.calls} model calls · ${h.stats.warnings} QA warnings</p>`;
    const s = h.storageInfo;
    if (s && s.provider === "github") {
      $("tokenBox").innerHTML =
        `<p>GitHub storage: <strong>${esc(s.repo)}</strong> @ ${esc(s.branch)} · ${s.ok ? "✅ reachable" : "❌ " + (s.status || s.error)}` +
        `${s.private != null ? ` · ${s.private ? "private repo" : "public repo"}` : ""}${s.rateRemaining ? ` · ${s.rateRemaining} API calls left this hour` : ""}</p>` +
        (s.broadToken
          ? `<p class="warn-text">⚠ This token can access <strong>all</strong> your repositories (scopes: ${esc(s.scopes)}). Switch to a fine-grained token limited to this one repo — see README → "Locking the token down".</p>`
          : `<p>✅ Token is scoped narrow (no broad <code>repo</code> scope reported).</p>`);
    } else $("tokenBox").textContent = "";
    $("footerInfo").textContent = `Storage: ${h.storage} · Groq primary · Gemini backup`;
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ library */
async function loadStats() {
  const s = await API("/api/stats");
  $("globalStats").textContent = `${s.works} stories · ${s.volumes || 0} volumes · ${s.chapters} chapters · ${s.translations} translations · ${s.terms} terms${s.warnings ? ` · ⚠ ${s.warnings} QA warnings` : ""}`;
}

async function loadWorks() {
  const works = await API("/api/works?q=" + encodeURIComponent($("search").value || ""));
  $("works").innerHTML = works.length
    ? works.map((w) => `
      <div class="work" data-id="${w.id}">
        <h3>${esc(w.title)} ${w.warnings ? `<span class="badge warn">⚠ ${w.warnings}</span>` : ""}</h3>
        <p class="hint">${esc(w.author || "unknown author")} · source ${esc(langName(w.lang))} ·
          ${w.volumeCount ? `${w.volumeCount} volume(s) · ` : ""}${w.chapterCount} chapter(s) · ${w.translatedCount} translation(s)
          ${w.languages?.length ? "· " + w.languages.map((l) => esc(langName(l))).join(", ") : ""}</p>
      </div>`).join("")
    : `<p class="hint">No stories yet — press <strong>Add chapters / volumes</strong> to start the library.</p>`;
  document.querySelectorAll(".work").forEach((el) => (el.onclick = () => (location.hash = `#/work/${el.dataset.id}`)));
}

$("search").addEventListener("keydown", (e) => { if (e.key === "Enter") location.hash = `#/search/${encodeURIComponent($("search").value)}`; });
$("searchGo").onclick = () => (location.hash = `#/search/${encodeURIComponent($("search").value)}`);
$("gotoAdd").onclick = () => (location.hash = "#/add");

function loadContinue() {
  const recent = Object.entries(LS.get("progress", {})).map(([k, v]) => ({ ...v, key: k })).sort((a, b) => b.at - a.at).slice(0, 6);
  $("continueWrap").classList.toggle("hidden", !recent.length);
  $("continueList").innerHTML = recent.map((r) => `<a class="chip" href="#/work/${r.workId}?lang=${r.lang}&level=${r.level || "medium"}&chapter=${r.chapterId}">${esc(r.title)} · ${esc(langName(r.lang))} · ${esc(LEVEL_LABEL[r.level] || "Medium")}</a>`).join("");
}

/* ------------------------------------------------------------------- reader */
async function openWork(workId, chapterId, lang, level) {
  currentWork = await API("/api/works/" + workId);
  const qs = new URLSearchParams((location.hash.split("?")[1] || ""));
  chapterId = chapterId || qs.get("chapter") || null;
  lang = lang || qs.get("lang") || null;
  level = level || qs.get("level") || null;
  currentChapter = chapterId || currentWork.chapters[0]?.id || null;
  const langs = [...new Set([...MAIN_LANGS, ...currentWork.languages])];
  currentLang = lang && langs.includes(lang) ? lang : "en";
  currentLevel = LEVELS.includes(level) ? level : (LS.get("level", "medium"));
  $("readerTitle").textContent = currentWork.title + (currentWork.author ? " — " + currentWork.author : "");
  fillVolumeSelect(); fillChapterSelect(); fillLangSelect();
  $("difficultySelect").value = currentLevel;
  show("reader");
  await loadTerms(); renderSuggestions(); await loadChapter();
  LS.set("lastStory", { title: currentWork.title, author: currentWork.author, url: currentWork.sourceUrl, sourceLang: currentWork.lang });
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

function levelBadges(c) {
  const list = c.variants || (c.translations || []).map((t) => ({ lang: t, difficulty: "medium" }));
  if (!list.length) return "";
  return list.map((v) => `<span class="badge level">${esc(v.lang)}·${esc(LEVEL_LABEL[v.difficulty] || v.difficulty)}</span>`).join(" ");
}

function fillChapterSelect() {
  const list = chaptersOfVolume(currentVolume);
  const pool = list.length ? list : currentWork.chapters;
  $("chapterSelect").innerHTML = pool
    .map((c) => `<option value="${c.id}">${c.index}. ${esc(c.title)}${c.translations.length ? " ✓" : ""}${c.warnings ? " ⚠" : ""}</option>`).join("");
  if (currentChapter && pool.some((c) => c.id === currentChapter)) $("chapterSelect").value = currentChapter;
  else currentChapter = pool[0]?.id || null;
}
function fillLangSelect() {
  const opts = [...new Set([...MAIN_LANGS, ...currentWork.languages, currentWork.lang])];
  $("langSelect").innerHTML = opts.map((l) => `<option value="${l}">${esc(langName(l))}${l === currentWork.lang ? " (rewrite)" : ""}</option>`).join("");
  $("langSelect").value = opts.includes(currentLang) ? currentLang : (currentLang = opts[0]);
}

async function loadChapter() {
  currentChapter = $("chapterSelect").value;
  currentLang = $("langSelect").value;
  currentLevel = $("difficultySelect").value;
  LS.set("level", currentLevel);
  const ch = await API(`/api/works/${currentWork.id}/chapters/${currentChapter}?lang=${currentLang}&difficulty=${currentLevel}`);
  const vol = ch.chapter.volume ? esc(ch.chapter.volume) + " · " : "";
  const avail = (ch.available || []).map((a) => `${langName(a.lang)}·${LEVEL_LABEL[a.difficulty] || a.difficulty}`);
  const levelNote = ch.record && ch.record.difficulty !== currentLevel ? ` <em>(showing ${LEVEL_LABEL[ch.record.difficulty]} — ${LEVEL_LABEL[currentLevel]} not done yet)</em>` : "";
  $("readerMeta").innerHTML = ch.translation
    ? `${vol}Translated to <strong>${esc(langName(currentLang))}</strong> · <strong>${esc(LEVEL_LABEL[currentLevel])}</strong>${levelNote}${ch.record?.provider ? ` via ${esc(ch.record.provider)}` : ""}`
    : `${vol}Not translated to ${esc(langName(currentLang))} at ${esc(LEVEL_LABEL[currentLevel])} yet — press <em>Translate / ensure</em>.`;
  const warn = ch.record?.warnings || [];
  $("warnBox").classList.toggle("hidden", !warn.length);
  $("warnBox").innerHTML = warn.length
    ? `<strong>QA warnings for this chapter (${esc(langName(currentLang))} · ${esc(LEVEL_LABEL[currentLevel])}):</strong>` +
      `<ul>${warn.map((w) => `<li class="${w.severity}">${esc(w.detail)}${w.sample ? ` <code>${esc(w.sample)}</code>` : ""}</li>`).join("")}</ul>` +
      `<button id="retranslateBtn" type="button">Re-translate this chapter (force)</button>`
    : "";
  $("retranslateBtn")?.addEventListener("click", () => doTranslate(true));
  renderReader(ch.translation, ch.original, ch.lang);
  $("readerMeta").insertAdjacentHTML("beforeend", `<div class="hint">Available: ${avail.length ? esc(avail.join(", ")) : "none"}</div>`);
  if (ch.translation || ch.original) {
    const progress = LS.get("progress", {});
    progress[`${currentWork.id}/${currentChapter}/${currentLang}/${currentLevel}`] = {
      at: Date.now(), workId: currentWork.id, chapterId: currentChapter, lang: currentLang, level: currentLevel,
      title: `${currentWork.title} · ${ch.chapter.title}`,
    };
    LS.set("progress", progress);
    history.replaceState(null, "", `#/work/${currentWork.id}/chapter/${currentChapter}?lang=${currentLang}&level=${currentLevel}`);
  }
}

function renderReader(translation, original, sourceLang) {
  const showText = (s) => (s || "").split("\n\n").map((p) => `<p>${esc(p)}</p>`).join("") || `<p class="hint">No text.</p>`;
  if (splitOn) {
    $("readerBody").innerHTML = `<h3 class="hint">${esc(langName(sourceLang))} (original)</h3>` + showText(original);
    $("readerBody2").classList.remove("hidden");
    $("readerBody2").innerHTML = `<h3 class="hint">${esc(langName(currentLang))} · ${esc(LEVEL_LABEL[currentLevel])}</h3>` + showText(translation);
  } else {
    $("readerBody2").classList.add("hidden");
    $("readerBody").innerHTML = translation
      ? showText(translation)
      : `<h3 class="hint">${esc(langName(sourceLang))} (original — no translation at this level yet)</h3>` + showText(original);
  }
}

$("chapterSelect").onchange = () => loadChapter();
$("langSelect").onchange = () => loadChapter();
$("difficultySelect").onchange = () => loadChapter();
$("volumeSelect").onchange = () => { currentVolume = $("volumeSelect").value; currentChapter = null; fillChapterSelect(); loadChapter(); };
$("backToLibrary").onclick = () => (location.hash = "#/");
$("showOriginal").onclick = async () => {
  const ch = await API(`/api/works/${currentWork.id}/chapters/${currentChapter}?lang=`);
  renderReader(null, ch.original, ch.lang);
  $("readerMeta").textContent = "Original · " + langName(ch.lang);
};
$("splitView").onclick = () => { splitOn = !splitOn; LS.set("split", splitOn); $("#splitView").classList.toggle("on", splitOn); loadChapter(); };
$("copyChapter").onclick = async () => { await navigator.clipboard.writeText($("readerBody").innerText); toast("Chapter copied", "ok"); };
$("dlChapter").onclick = () => {
  const blob = new Blob([$("readerBody").innerText], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${currentWork.title}.${currentLang}.${currentLevel}.txt`.replace(/[^\w.\-]+/g, "_");
  a.click();
  URL.revokeObjectURL(a.href);
};
$("shareChapter").onclick = async () => {
  const link = `${location.origin}/#/work/${currentWork.id}/chapter/${currentChapter}?lang=${currentLang}&level=${currentLevel}`;
  try { await navigator.clipboard.writeText(link); toast("Link copied", "ok"); } catch { prompt("Copy this link:", link); }
};
$("addToStory").onclick = () => {
  const qs = new URLSearchParams({ title: currentWork.title, author: currentWork.author || "", url: currentWork.sourceUrl || "" });
  if (currentWork.volumes?.length) qs.set("volume", currentWork.volumes.at(-1).label || "");
  qs.set("next", "1");
  location.hash = "#/add?" + qs.toString();
};

$("prevChapter").onclick = () => navChapter(-1);
$("nextChapter").onclick = () => navChapter(1);
$("prevChapterBottom").onclick = () => navChapter(-1);
$("nextChapterBottom").onclick = () => navChapter(1);
function navChapter(dir) {
  const list = chaptersOfVolume(currentVolume);
  const pool = list.length ? list : currentWork.chapters;
  const i = pool.findIndex((c) => c.id === $("chapterSelect").value);
  const n = pool[i + dir];
  if (n) { $("chapterSelect").value = n.id; loadChapter(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  const vols = workVolumes();
  const vi = vols.findIndex((v) => v.key === currentVolume);
  const nv = vols[vi + dir];
  if (nv) {
    currentVolume = nv.key;
    if (!$("volumeWrap").classList.contains("hidden")) $("volumeSelect").value = nv.key;
    const set = chaptersOfVolume(nv.key);
    const first = set[dir > 0 ? 0 : set.length - 1];
    if (first) { currentChapter = first.id; fillChapterSelect(); loadChapter(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
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
  if (["1", "2", "3"].includes(e.key)) { $("difficultySelect").value = LEVELS[+e.key - 1]; loadChapter(); }
});

function updateProgress() {
  const el = $("readerBody");
  const total = document.documentElement.scrollHeight - window.innerHeight;
  $("progressBar").style.width = total > 0 ? Math.min(100, Math.max(0, (window.scrollY / total) * 100)) + "%" : "0%";
}

async function doTranslate(force = false) {
  busy($("translateBtn"), true, "Translating…");
  $("readerMeta").textContent = `Translating to ${langName(currentLang)} at ${LEVEL_LABEL[currentLevel]}…`;
  try {
    const r = await post(`/api/works/${currentWork.id}/chapters/${currentChapter}/translate`, { target: currentLang, difficulty: currentLevel, force });
    toast(r.cached ? "Already done (from memory)" : `Translated ${r.chunks} chunks via ${r.provider}`, r.qa?.ok === false ? "warn" : "ok");
    currentWork = await API("/api/works/" + currentWork.id);
    fillVolumeSelect(); fillChapterSelect();
    await loadChapter();
    loadStats();
  } catch (e) { toast("Error: " + e.message, "error"); $("readerMeta").textContent = "Error: " + e.message; }
  finally { busy($("translateBtn"), false); }
}
$("translateBtn").onclick = () => doTranslate(false);

$("translateAllBtn").onclick = async () => {
  const all = confirm(`Translate EVERY chapter of this story into ${langName(currentLang)}?\n\nOK = all three levels (Easy + Medium + Hard)\nCancel = only the selected level (${LEVEL_LABEL[currentLevel]})`);
  const difficulties = all ? LEVELS : [currentLevel];
  const total = currentWork.chapters.length * difficulties.length;
  if (!confirm(`That's ${total} chapter translation(s). This runs in the background — you can keep using the site. Start?`)) return;
  busy($("translateAllBtn"), true, "Starting…");
  try {
    const r = await post(`/api/works/${currentWork.id}/translate-all`, { target: currentLang, difficulties });
    busy($("translateAllBtn"), false);
    await followJob(r.jobId, { label: `${langName(currentLang)} × ${difficulties.length} level(s)`, reload: () => refreshWork() });
    toast("Whole story translated", "ok");
  } catch (e) { toast("Error: " + e.message, "error"); busy($("translateAllBtn"), false); }
};

async function followJob(jobId, { reload, label = "Translating", target } = {}) {
  if (!jobId) return null;
  const out = target || $("readerMeta");
  for (let i = 0; i < 1500; i++) {
    const job = await API(`/api/jobs/${jobId}`).catch(() => null);
    if (!job) break;
    out.innerHTML = job.total ? `${esc(label)}… ${job.done}/${job.total}${job.current ? ` — ${esc(job.current)}` : ""}` : `${esc(label)}… preparing`;
    if (job.state === "done" || job.state === "error") {
      await reload?.();
      if (job.state === "error") throw new Error(job.error || "job failed");
      if (job.errors?.length) toast(`Finished with ${job.errors.length} issue(s)`, "warn");
      return job;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

async function refreshWork() {
  if (!currentWork) return;
  currentWork = await API("/api/works/" + currentWork.id);
  fillVolumeSelect(); fillChapterSelect(); await loadChapter(); loadStats();
}

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
    openWork(w.id, currentChapter, currentLang, currentLevel);
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
  busy($("saveTerm"), true, "Updating every level…");
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
function prefillFromLast() {
  if (!lastStory) return;
  if (!$("title").value) $("title").value = lastStory.title || "";
  if (!$("author").value) $("author").value = lastStory.author || "";
  if (!$("sourceUrl").value) $("sourceUrl").value = lastStory.url || "";
  if (lastStory.sourceLang && LANG.some((l) => l.code === lastStory.sourceLang)) $("sourceLang").value = lastStory.sourceLang;
}

async function prefillAdd(qs) {
  if (qs.get("title") || lastStory) prefillFromLast();
  const title = qs.get("title"), author = qs.get("author"), url = qs.get("url"), volume = qs.get("volume");
  if (title) $("title").value = title;
  if (author) $("author").value = author;
  if (url) $("sourceUrl").value = url;
  if (volume) $("volume").value = volume;
  // work out the next chapter number/title for this story
  if (title) {
    try {
      const works = await API("/api/works?q=" + encodeURIComponent(title));
      const w = works.find((x) => x.title.toLowerCase() === title.toLowerCase());
      if (w) {
        const full = await API("/api/works/" + w.id);
        const wantVol = (volume || "").toLowerCase();
        const inVol = full.chapters.filter((c) => !wantVol || (c.volume || "").toLowerCase() === wantVol);
        const last = (inVol.length ? inVol : full.chapters).at(-1);
        const next = (last?.index || 0) + 1;
        $("chapterTitle").value = `Chapter ${next}`;
        if (!volume && last?.volume) $("volume").value = last.volume;
        $("addHint").textContent = `Adding to “${full.title}” — next up: ${last?.volume ? last.volume + " · " : ""}Chapter ${next} of ${(inVol.length ? inVol : full.chapters).length} existing chapter(s).`;
      }
    } catch { /* ignore */ }
  }
  updateUploadStats();
}

$("uploadFile").onchange = async () => {
  const f = $("uploadFile").files[0]; if (!f) return;
  busy($("uploadFile"), true, "Reading…");
  try {
    if (/\.epub$|\.html?$|\.pdf$/i.test(f.name)) {
      const buf = await f.arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const parsed = await post("/api/parse-file", { name: f.name, dataBase64: btoa(bin) });
      $("uploadText").value = parsed.text;
      toast(`Parsed ${parsed.name}: ${parsed.chars.toLocaleString()} chars, ~${parsed.chapters} chapter(s)`, "ok");
    } else {
      $("uploadText").value = await f.text();
    }
    if (!$("title").value && f.name) $("title").value = f.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").replace(/\s*\b(Vol|Volume)\b\s*(\d+)\s*$/i, "").trim();
    const volMatch = f.name.match(/\b(Vol(?:ume)?\.?\s*\d+)\b/i);
    if (volMatch && !$("volume").value) $("volume").value = volMatch[1].replace(/\s+/g, " ");
    maybeDetectLanguage();
    updateUploadStats();
  } catch (e) { toast("File error: " + e.message, "error"); }
  finally { busy($("uploadFile"), false); }
};

$("uploadText").oninput = () => { maybeDetectLanguage(); updateUploadStats(); };
$("uploadText").onpaste = () => setTimeout(() => { maybeDetectLanguage(); updateUploadStats(); }, 0);

function maybeDetectLanguage() {
  if (!$("autoDetect").checked) return;
  const text = $("uploadText").value;
  if (text.trim().length < 20) return;
  const guess = detectLang(text);
  if (LANG.some((l) => l.code === guess)) $("sourceLang").value = guess;
}

function updateUploadStats() {
  const n = $("uploadText").value.length;
  $("uploadStats").textContent = n ? `${n.toLocaleString()} chars ≈ ${Math.max(1, Math.ceil(n / 1800))} chunks` : "";
}

$("previewSplit").onclick = async () => {
  const text = $("uploadText").value.trim();
  if (!text) return toast("Paste some text first", "warn");
  const r = await post("/api/works/preview-split", { text, volume: $("volume").value });
  const volText = r.volumes?.length ? `${r.volumes.length} volume(s) · ` : "";
  $("splitPreview").innerHTML = `Detected <strong>${volText}${r.count} chapter(s)</strong>: ` +
    r.chapters.slice(0, 30).map((c) => `<code>${esc(c.volume ? c.volume + " / " : "")}${esc(c.title || "(untitled)")}</code>`).join(" · ") +
    (r.chapters.length > 30 ? ` …+${r.chapters.length - 30} more` : "");
};

async function saveChapters({ translate }) {
  const title = $("title").value.trim(), text = $("uploadText").value.trim();
  if (!title || !text) { toast("Story title and chapter text are required", "warn"); return; }
  const autoTranslateTo = translate ? [...document.querySelectorAll('#autoLangs input:checked')].map((i) => i.value) : [];
  const difficulties = translate ? [...document.querySelectorAll('#autoLevels input:checked')].map((i) => i.value) : [];
  if (translate && !autoTranslateTo.length) { toast("Pick at least one language", "warn"); return; }
  if (translate && !difficulties.length) { toast("Pick at least one reading level", "warn"); return; }
  const settings = { keepHonorifics: $("setHonorifics").checked, formality: $("setFormality").value, notes: $("setNotes").value };
  const btn = translate ? $("saveTranslate") : $("saveOnly");
  busy(btn, true, "Saving…");
  try {
    const body = {
      title, author: $("author").value, sourceLang: $("sourceLang").value,
      sourceUrl: $("sourceUrl").value, autoTranslateTo, difficulties, settings, volume: $("volume").value,
    };
    LS.set("lastStory", { title, author: $("author").value, url: $("sourceUrl").value, sourceLang: $("sourceLang").value });
    const r = $("autoSplit").checked
      ? await post("/api/works/bulk", { ...body, text })
      : await post("/api/works", { ...body, text, chapterTitle: $("chapterTitle").value });
    const bits = [];
    if (r.chapters) {
      const added = r.chapters.filter((c) => c.created).length;
      const dups = r.chapters.filter((c) => c.duplicate).length;
      const vers = r.chapters.filter((c) => c.version).length;
      const vols = [...new Set(r.chapters.map((c) => c.volume).filter(Boolean))];
      bits.push(`Saved ${added} new chapter(s)${vols.length ? ` in ${vols.length} volume(s)` : ""}${dups ? `, ${dups} already existed` : ""}${vers ? `, ${vers} updated (old versions kept)` : ""}.`);
    } else if (r.jobId) bits.push("Working in the background…");
    else bits.push(r.duplicate ? "Already in the library (same text)." : r.version ? "Saved as a new version." : "Chapter saved.");
    $("uploadResult").innerHTML = bits.join(" ") + ` <a href="#/work/${r.workId}">Open story →</a>`;
    toast("Saved", "ok");
    loadStats();
    clearAddForm();
    if (r.jobId) {
      await followJob(r.jobId, { label: translate ? "Saving & translating" : "Saving", target: $("uploadResult"), reload: async () => { location.hash = `#/work/${r.workId}`; } });
      toast(translate ? "Saved and translated" : "Saved", "ok");
    } else if (translate) location.hash = `#/work/${r.workId}`;
  } catch (e) { toast("Error: " + e.message, "error"); $("uploadResult").textContent = "Error: " + e.message; }
  finally { busy(btn, false); }
}
$("saveTranslate").onclick = () => saveChapters({ translate: true });
$("saveOnly").onclick = () => saveChapters({ translate: false });

function clearAddForm() {
  $("uploadText").value = "";
  $("chapterTitle").value = "";
  $("splitPreview").innerHTML = "";
  $("uploadResult").innerHTML = "";
  $("addHint").textContent = "";
  updateUploadStats();
}

/* --------------------------------------------------------------- activity */
async function loadActivity() {
  const feed = await API("/api/activity?limit=60");
  $("activityFeed").innerHTML = feed.length
    ? feed.map((a) => `<div class="feed-item"><span class="when">${new Date(a.at).toLocaleString()}</span> <span class="badge">${esc(a.type)}</span> ${esc(a.detail || "")} ${a.workId ? `<a href="#/work/${a.workId}">open</a>` : ""}</div>`).join("")
    : `<p class="hint">No activity yet.</p>`;
}

/* ------------------------------------------------------- quick translate */
$("swap").onclick = () => { if ($("source").value === "auto") return; const s = $("source").value; $("source").value = $("target").value; $("target").value = s; };
$("go").onclick = async () => {
  const t = $("input").value.trim(); if (!t) return toast("Paste some text first", "warn");
  busy($("go"), true, "Translating…");
  try {
    const r = await post("/api/translate", { text: t, source: $("source").value, target: $("target").value, chain: "auto" });
    $("output").value = r.translation;
    $("progress").textContent = `${r.chunks} chunks · via ${r.provider || "model"}`;
  } catch (e) { toast("Error: " + e.message, "error"); $("progress").textContent = "Error: " + e.message; }
  finally { busy($("go"), false); }
};

/* ---------------------------------------------------------- backup/restore */
$("exportAll").onclick = () => window.open("/api/export", "_blank");
$("reloadStore").onclick = async () => {
  busy($("reloadStore"), true, "Reloading…");
  try { await post("/api/reload", {}); toast("Reloaded from storage", "ok"); loadStats(); loadHealth(); }
  catch (e) { toast("Error: " + e.message, "error"); }
  finally { busy($("reloadStore"), false); }
};
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

/* ------------------------------------------------------------- reader look */
const FONTS = {
  serif: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  dyslexic: "'Comic Sans MS', Verdana, Tahoma, sans-serif",
  mono: "ui-monospace, Consolas, 'Courier New', monospace",
};
function bindLookControls() {
  $("theme").onchange = () => { look.theme = $("theme").value; LS.set("look", look); applyLook(); };
  $("fontFamily").onchange = () => { look.font = $("fontFamily").value; LS.set("look", look); applyLook(); };
  $("fontSize").oninput = () => { look.size = +$("fontSize").value; LS.set("look", look); applyLook(); };
  $("lineHeight").onchange = () => { look.line = $("lineHeight").value; LS.set("look", look); applyLook(); };
  $("readWidth").onchange = () => { look.width = $("readWidth").value; LS.set("look", look); applyLook(); };
  $("justifyText").onchange = () => { look.justify = $("justifyText").checked; LS.set("look", look); applyLook(); };
}
function applyLook() {
  $("theme").value = look.theme;
  $("fontFamily").value = look.font;
  $("fontSize").value = look.size;
  $("lineHeight").value = look.line;
  $("readWidth").value = look.width;
  $("justifyText").checked = !!look.justify;
  document.documentElement.dataset.theme = look.theme === "auto" ? "" : look.theme;
  for (const el of [$("readerBody"), $("readerBody2")]) {
    el.style.fontFamily = FONTS[look.font] || FONTS.serif;
    el.style.fontSize = look.size + "px";
    el.style.lineHeight = look.line;
    el.classList.toggle("justify", !!look.justify);
  }
  document.documentElement.style.setProperty("--read-width", look.width);
  document.documentElement.style.setProperty("--read-space", (look.size * 0.75).toFixed(0) + "px");
  $("splitView").classList.toggle("on", splitOn);
}

/* ------------------------------------------------------------------- PWA */
function registerPWA() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}
