// Ingest the Eminence in Shadow volumes from PDF into the live library.
//   node scripts/ingest-volumes.mjs            → ingest only
//   node scripts/ingest-volumes.mjs --demo     → ingest + translate a demo chapter
// Source files stay local (gitignored); only the extracted text goes to storage.
import { readFile, readdir } from "node:fs/promises";
import { parseBuffer } from "../src/files.js";

const BASE = process.env.BASE || "https://ln-translator.onrender.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, o) => { const r = await fetch(BASE + p, o); return { s: r.status, d: await r.json().catch(() => ({})) }; };
const post = (p, b) => j(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

async function waitJob(id, label) {
  for (let i = 0; i < 900; i++) {
    const { d: job } = await j(`/api/jobs/${id}`);
    if (!job || job.state !== "running") {
      console.log(`   ${label}: ${job?.state} ${job?.done}/${job?.total}${job?.error ? " ERROR " + job.error : ""}`);
      if (job?.errors?.length) console.log("     issues:", job.errors.slice(0, 3).join(" | "));
      return job;
    }
    if (i % 6 === 0) console.log(`   ${label}: ${job.done}/${job.total} — ${job.current || ""}`);
    await sleep(4000);
  }
  return null;
}

const files = (await readdir(".")).filter((f) => /^Eminence in Shadow Vol\. \d+.*\.pdf$/i.test(f)).sort((a, b) => {
  const n = (s) => Number((s.match(/Vol\.\s*(\d+)/i) || [])[1] || 0);
  return n(a) - n(b);
});
console.log("found volumes:", files.join(" | "));

let workId = null;
for (const file of files) {
  const volNum = (file.match(/Vol\.\s*(\d+)/i) || [])[1];
  const volume = `Volume ${volNum}`;
  const text = await parseBuffer(file, await readFile(file));
  console.log(`\n=== ${volume}: ${text.length.toLocaleString()} chars ===`);
  const up = await post("/api/works/bulk", {
    title: "The Eminence in Shadow",
    author: "Daisuke Aizawa",
    sourceLang: "en",
    volume,
    text,
    autoTranslateTo: [],
  });
  if (up.s !== 202) { console.log("   FAILED", up.s, JSON.stringify(up.d).slice(0, 200)); continue; }
  workId = up.d.workId;
  await waitJob(up.d.jobId, volume);
}

const work = (await j("/api/works/" + workId)).d;
console.log(`\nstory: ${work.title} — ${work.volumes.length} volumes, ${work.chapters.length} chapters`);
for (const v of work.volumes) console.log(`  ${v.label}: ${v.chapterCount} chapters`);

if (process.argv.includes("--demo")) {
  const first = work.chapters.find((c) => c.volume === "Volume 1" && /^Chapter 1/.test(c.title)) || work.chapters[0];
  console.log(`\n=== demo: translating "${first.title}" in Swedish (all levels) + Spanish + German (medium) ===`);
  const jobs = [];
  for (const [target, difficulty] of [["sv", "easy"], ["sv", "medium"], ["sv", "hard"], ["es", "medium"], ["de", "medium"]]) {
    const r = await post(`/api/works/${workId}/chapters/${first.id}/translate`, { target, difficulty });
    console.log(`  queued ${target}/${difficulty} → ${r.s} ${r.d.jobId || JSON.stringify(r.d).slice(0, 120)}`);
    if (r.d.jobId) jobs.push({ id: r.d.jobId, label: `${target}/${difficulty}` });
  }
  for (const job of jobs) await waitJob(job.id, job.label);
}

const after = (await j("/api/works/" + workId)).d;
console.log("\n=== available translations ===");
for (const c of after.chapters.slice(0, 4)) {
  const v = (c.variants || []).map((x) => `${x.lang}/${x.difficulty}`).join(", ");
  console.log(`  ${c.volume} | ${c.title}${v ? "  →  " + v : ""}`);
}
console.log("\nterms (sv):", JSON.stringify((await j(`/api/works/${workId}/terms?lang=sv`)).d.terms.slice(0, 8).map((t) => `${t.source}→${t.canonical}`)));
console.log("stats:", JSON.stringify((await j("/api/stats")).d));
console.log("\nOPEN: " + BASE + "/#/work/" + workId);
