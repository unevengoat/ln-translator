// Remove the false "volume" chapter produced by a body-text match, then queue the
// demo translations: Swedish at all three levels + Spanish + German at medium.
const BASE = process.env.BASE || "https://ln-translator.onrender.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, o) => { const r = await fetch(BASE + p, o); return { s: r.status, d: await r.json().catch(() => ({})) }; };
const post = (p, b) => j(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

async function waitJob(id, label) {
  for (let i = 0; i < 1500; i++) {
    const { d: job } = await j(`/api/jobs/${id}`);
    if (!job || job.state !== "running") {
      console.log(`   ${label}: ${job?.state} ${job?.done}/${job?.total}${job?.error ? " ERROR " + job.error : ""}`);
      return job;
    }
    if (i % 8 === 0) console.log(`   ${label}: ${job?.done}/${job?.total} — ${job?.current || ""}`);
    await sleep(4000);
  }
}

const works = (await j("/api/works")).d;
const emis = (works.works || works).find((w) => /Eminence in Shadow/i.test(w.title));
console.log("story:", emis.title, emis.id);
const work = (await j("/api/works/" + emis.id)).d;

// 1. remove false volume chapters (a "volume" label that is really prose)
const bogus = (work.chapters || []).filter((c) => c.volume && /^Volume \d+\s+\S{6,}/i.test(c.volume));
for (const c of bogus) {
  const r = await fetch(`${BASE}/api/works/${emis.id}/chapters/${c.id}`, { method: "DELETE" });
  console.log("removed false-volume chapter:", JSON.stringify(c.volume).slice(0, 70), "→", r.status);
}
const clean = (await j("/api/works/" + emis.id)).d;
console.log("volumes now:", clean.volumes.length, "|", clean.volumes.map((v) => v.label).join(", "));

// 2. demo translations on Volume 1 Chapter 1
const first = clean.chapters.find((c) => c.volume === "Volume 1" && /^Chapter 1/.test(c.title)) || clean.chapters.find((c) => /^Chapter 1/.test(c.title));
console.log(`\ndemo chapter: ${first.volume} | ${first.title} (${first.sourceHash ? "" : ""})`);
const jobs = [];
for (const [target, difficulty] of [["sv", "easy"], ["sv", "medium"], ["sv", "hard"], ["es", "medium"], ["de", "medium"]]) {
  const r = await post(`/api/works/${emis.id}/chapters/${first.id}/translate`, { target, difficulty });
  console.log(`  queued ${target}/${difficulty} → ${r.s} ${r.d.jobId || JSON.stringify(r.d).slice(0, 140)}`);
  if (r.d.jobId) jobs.push({ id: r.d.jobId, label: `${target}/${difficulty}` });
}
for (const job of jobs) await waitJob(job.id, job.label);

// 3. show the result: same terms across levels
const after = (await j("/api/works/" + emis.id)).d;
const c1 = after.chapters.find((c) => c.id === first.id);
console.log("\nlevels stored for this chapter:", JSON.stringify(c1.variants));
for (const level of ["easy", "medium", "hard"]) {
  const ch = (await j(`/api/works/${emis.id}/chapters/${first.id}?lang=sv&difficulty=${level}`)).d;
  const t = String(ch.translation || "").replace(/\s+/g, " ").slice(0, 200);
  console.log(`\nSV ${level.toUpperCase()} (${ch.record?.exact ? "exact" : "fallback"}): ${t}`);
}
const es = (await j(`/api/works/${emis.id}/chapters/${first.id}?lang=es&difficulty=medium`)).d;
const de = (await j(`/api/works/${emis.id}/chapters/${first.id}?lang=de&difficulty=medium`)).d;
console.log("\nES:", String(es.translation || "").replace(/\s+/g, " ").slice(0, 160));
console.log("DE:", String(de.translation || "").replace(/\s+/g, " ").slice(0, 160));
console.log("\nterms sv:", JSON.stringify((await j(`/api/works/${emis.id}/terms?lang=sv`)).d.terms.slice(0, 10).map((t) => `${t.source}→${t.canonical}`)));
console.log("stats:", JSON.stringify((await j("/api/stats")).d));
console.log("\nOPEN: " + BASE + "/#/work/" + emis.id);
