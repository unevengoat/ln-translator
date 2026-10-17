const $ = (id) => document.getElementById(id);
const API = (path, opts) => fetch(path, opts).then(async (r) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
});
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const langName = (code) => LANG.find((l) => l.code === code)?.name || code;

let LANG = [];
let PROVIDERS = [];
let currentWork = null;
let currentChapter = null;
let currentLang = "";

/* tabs */
document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => show(b.dataset.tab)));
function show(tab) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("active", s.id === "tab-" + tab));
}

async function boot() {
  LANG = await API("/api/languages");
  PROVIDERS = await API("/api/providers");
  for (const l of LANG) {
    $("source").add(new Option(l.name, l.code));
    $("sourceLang").add(new Option(l.name, l.code));
    if (l.code !== "auto") $("target").add(new Option(l.name, l.code));
  }
  $("source").value = "auto";
  $("target").value = "en";
  $("sourceLang").value = "ja";
  // quick-target chips for auto-translate on upload
  for (const code of ["en", "es", "sv"]) {
    const id = "auto_" + code;
    const label = document.createElement("label");
    label.className = "chip";
    label.innerHTML = `<input type="checkbox" id="${id}" value="${code}" ${code === "en" ? "checked" : ""}> ${langName(code)}`;
    $("autoLangs").appendChild(label);
  }
  loadStats();
  loadWorks();
}
boot().catch((e) => ($("globalStats").textContent = "Error: " + e.message));

async function loadStats() {
  const s = await API("/api/stats");
  $("globalStats").textContent = `${s.works} stories · ${s.chapters} chapters · ${s.translations} translations · ${s.terms} terms · ${s.tmSegments} memory segments`;
}

/* ------------------------------------------------------------------ library */
async function loadWorks() {
  const works = await API("/api/works?q=" + encodeURIComponent($("search").value || ""));
  $("works").innerHTML = works.length
    ? works.map((w) => `
      <div class="work" data-id="${w.id}">
        <h3>${esc(w.title)}</h3>
        <p class="hint">${esc(w.author || "unknown author")} · source ${langName(w.lang)} · ${w.chapterCount} chapter(s) · ${w.translatedCount} translation(s)
          ${w.languages?.length ? "· " + w.languages.map((l) => esc(langName(l))).join(", ") : ""}</p>
      </div>`).join("")
    : `<p class="hint">No stories yet — add a chapter to start the shared library.</p>`;
  document.querySelectorAll(".work").forEach((el) => (el.onclick = () => openWork(el.dataset.id)));
}

$("search").oninput = loadWorks;

async function openWork(workId) {
  currentWork = await API("/api/works/" + workId);
  currentChapter = currentWork.chapters[0]?.id || null;
  currentLang = [...new Set([...currentWork.languages, "en", "es", "sv"])].filter((l) => l !== currentWork.lang)[0] || "en";
  $("readerTitle").textContent = currentWork.title + (currentWork.author ? " — " + currentWork.author : "");
  fillChapterSelect();
  fillLangSelect();
  show("reader");
  await loadTerms();
  renderTermSuggest();
  await loadChapter();
}

function fillChapterSelect() {
  $("chapterSelect").innerHTML = currentWork.chapters
    .sort((a, b) => a.index - b.index)
    .map((c) => `<option value="${c.id}">${c.index}. ${esc(c.title)}${c.translations.length ? " ✓" : ""}</option>`).join("");
  if (currentChapter) $("chapterSelect").value = currentChapter;
}
function fillLangSelect() {
  const opts = [...new Set([...currentWork.languages, "en", "es", "sv", "ja", "ko", "zh-CN"])].filter((l) => l !== currentWork.lang);
  $("langSelect").innerHTML = opts.map((l) => `<option value="${l}">${langName(l)}</option>`).join("");
  if (opts.includes(currentLang)) $("langSelect").value = currentLang;
  else currentLang = opts[0];
}

async function loadChapter(showOriginal = false) {
  currentChapter = $("chapterSelect").value;
  currentLang = $("langSelect").value;
  const ch = await API(`/api/works/${currentWork.id}/chapters/${currentChapter}?lang=${showOriginal ? "" : currentLang}`);
  const body = showOriginal ? ch.original : ch.translation;
  $("readerMeta").textContent = showOriginal
    ? "Original · " + langName(ch.lang)
    : body
      ? "Translated to " + langName(currentLang) + " · available: " + (ch.available.map(langName).join(", ") || "none")
      : `Not translated to ${langName(currentLang)} yet — press "Translate / ensure".`;
  $("readerBody").innerHTML = (body || "").split("\n\n").map((p) => `<p>${esc(p)}</p>`).join("") || `<p class="hint">No text.</p>`;
}

$("chapterSelect").onchange = () => loadChapter(false);
$("langSelect").onchange = () => loadChapter(false);
$("showOriginal").onclick = async () => {
  const ch = await API(`/api/works/${currentWork.id}/chapters/${currentChapter}?lang=`);
  $("readerMeta").textContent = "Original · " + langName(ch.lang);
  $("readerBody").innerHTML = ch.original.split("\n\n").map((p) => `<p>${esc(p)}</p>`).join("");
};
$("backToLibrary").onclick = () => { show("library"); loadStats(); loadWorks(); };

$("translateBtn").onclick = async () => {
  const t0 = Date.now();
  $("readerMeta").textContent = "Translating… (reuses memory, keeps this story's terms)";
  try {
    const r = await API(`/api/works/${currentWork.id}/chapters/${currentChapter}/translate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: currentLang }),
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    $("readerMeta").textContent = `${r.cached ? "From memory" : "Translated"} · ${r.chunks} chunks · via ${r.provider || "memory"} · ${secs}s`;
    currentWork = await API("/api/works/" + currentWork.id);
    fillChapterSelect();
    await loadChapter();
    loadStats();
  } catch (e) {
    $("readerMeta").textContent = "Error: " + e.message;
  }
};

/* -------------------------------------------------------------------- terms */
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
    : `<p class="hint">No terms recorded yet for ${langName(currentLang)}. They appear as chapters are translated, or add one below.</p>`;
  document.querySelectorAll(".term .edit").forEach((b) => (b.onclick = () => {
    const term = b.closest(".term");
    $("termSource").value = term.dataset.source;
    $("termCanonical").value = term.dataset.canonical;
  }));
}

async function renderTermSuggest() {
  const d = window.__suggest || { candidates: [], modelTerms: [] };
  const list = [...(d.candidates || []).map((c) => c.source), ...(d.modelTerms || []).map((t) => `${t.source} → ${t.translation}`)];
  $("termSuggest").textContent = list.length ? list.join(" · ") : "No new suggestions.";
}

$("saveTerm").onclick = async () => {
  const source = $("termSource").value.trim();
  const canonical = $("termCanonical").value.trim();
  if (!source || !canonical) { $("termResult").textContent = "Fill both boxes."; return; }
  $("termResult").textContent = "Saving and updating every chapter…";
  try {
    const r = await API(`/api/works/${currentWork.id}/terms`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang: currentLang, source, canonical }),
    });
    $("termResult").textContent = r.summary;
    await loadTerms();
    renderTermSuggest();
    await loadChapter();
  } catch (e) {
    $("termResult").textContent = "Error: " + e.message;
  }
};

/* ------------------------------------------------------------------- upload */
$("uploadFile").onchange = async () => {
  const f = $("uploadFile").files[0];
  if (!f) return;
  $("uploadText").value = await f.text();
  updateUploadStats();
};
$("uploadText").oninput = updateUploadStats;
function updateUploadStats() {
  const n = $("uploadText").value.length;
  $("uploadStats").textContent = n ? `${n.toLocaleString()} chars ≈ ${Math.max(1, Math.ceil(n / 1800))} chunks` : "";
}

$("saveChapter").onclick = async () => {
  const title = $("title").value.trim();
  const text = $("uploadText").value.trim();
  if (!title || !text) { $("uploadResult").textContent = "Story title and chapter text are required."; return; }
  const autoTranslateTo = [...document.querySelectorAll('#autoLangs input:checked')].map((i) => i.value);
  $("saveChapter").disabled = true;
  $("uploadResult").textContent = "Saving" + (autoTranslateTo.length ? " and translating to " + autoTranslateTo.map(langName).join(", ") + "…" : "…");
  try {
    const r = await API("/api/works", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title, author: $("author").value, sourceLang: $("sourceLang").value,
        sourceUrl: $("sourceUrl").value, chapterTitle: $("chapterTitle").value,
        chapterIndex: $("chapterIndex").value, text, autoTranslateTo,
      }),
    });
    const bits = [];
    bits.push(r.duplicate ? "Already in the library (same text) — nothing re-saved." : r.version ? "Saved as a new version (old version kept)." : "Chapter saved.");
    if (r.termsAdded) bits.push(r.termsAdded + " terms recorded.");
    if (r.translated?.length) bits.push("Translated to " + r.translated.map(langName).join(", ") + ".");
    if (r.translateError) bits.push("Translation issue:" + r.translateError);
    $("uploadResult").innerHTML = bits.join(" ") + ` <a href="#" id="openNow">Open story →</a>`;
    $("openNow").onclick = (e) => { e.preventDefault(); openWork(r.workId); };
    loadStats(); loadWorks();
  } catch (e) {
    $("uploadResult").textContent = "Error: " + e.message;
  } finally {
    $("saveChapter").disabled = false;
  }
};

/* -------------------------------------------------------------------- quick */
$("swap").onclick = () => {
  if ($("source").value === "auto") return;
  const s = $("source").value;
  $("source").value = $("target").value;
  $("target").value = s;
};
$("go").onclick = async () => {
  const text = $("input").value.trim();
  if (!text) { $("progress").textContent = "Paste some text first."; return; }
  const engine = document.querySelector('input[name="engine"]:checked').value;
  $("go").disabled = true;
  $("progress").textContent = "Translating…";
  $("output").value = "";
  try {
    const r = await API("/api/translate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text, source: $("source").value, target: $("target").value,
        engine: engine === "ai" ? "ai" : "free",
        chain: engine === "ai" ? "auto" : undefined,
        ai: engine === "ai" ? { provider: "custom", baseUrl: undefined } : undefined,
      }),
    });
    $("output").value = r.translation;
    $("progress").textContent = `${r.chunks} chunks · via ${r.provider || r.engine}`;
  } catch (e) {
    $("progress").textContent = "Error: " + e.message;
  } finally {
    $("go").disabled = false;
  }
};
