// Clean noisy terms, then resume the demo translations (they resume from memory).
const BASE = "https://ln-translator.onrender.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, o) => { const r = await fetch(BASE + p, o); return { s: r.status, d: await r.json().catch(() => ({})) }; };
const post = (p, b) => j(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

async function waitJob(id, label, maxMin = 30) {
  const until = Date.now() + maxMin * 60000;
  for (let i = 0; Date.now() < until; i++) {
    const { d: job } = await j(`/api/jobs/${id}`);
    if (!job || job.state !== "running") {
      console.log(`   ${label}: ${job?.state} ${job?.done}/${job?.total}${job?.error ? " ERROR " + String(job.error).slice(0, 120) : ""}`);
      return job;
    }
    if (i % 10 === 0) console.log(`   ${label}: still running… ${job?.current || ""}`);
    await sleep(6000);
  }
  console.log(`   ${label}: timed out waiting`);
  return null;
}

const works = (await j("/api/works")).d;
const emis = (works.works || works).find((w) => /Eminence in Shadow/i.test(w.title));
console.log("story:", emis.id, "| terms before:", (await j(`/api/works/${emis.id}/terms?lang=en`)).d.terms.length);

const clean = await post(`/api/works/${emis.id}/terms/clean`, {});
console.log("terms cleaned:", JSON.stringify(clean.d));
const after = (await j(`/api/works/${emis.id}/terms?lang=en`)).d;
console.log("terms now:", after.terms.length, "| sample:", JSON.stringify(after.terms.slice(0, 12).map((t) => t.source)));

const work = (await j("/api/works/" + emis.id)).d;
const first = work.chapters.find((c) => c.volume === "Volume 1" && /^Chapter 1/.test(c.title));
console.log(`\nchapter: ${first.title}`);

// resume the levels one at a time so each gets the rate-limit budget
const combos = process.argv.includes("--es-de") ? [["es", "medium"], ["de", "medium"]] : [["sv", "easy"], ["sv", "hard"], ["es", "medium"], ["de", "medium"]];
for (const [target, difficulty] of combos) {
  const r = await post(`/api/works/${emis.id}/chapters/${first.id}/translate`, { target, difficulty });
  console.log(`\n→ ${target}/${difficulty} ${r.s}`);
  if (r.d.jobId) await waitJob(r.d.jobId, `${target}/${difficulty}`);
}

const w2 = (await j("/api/works/" + emis.id)).d;
const c1 = w2.chapters.find((c) => c.id === first.id);
console.log("\nlevels now stored:", JSON.stringify(c1.variants));
for (const [target, difficulty] of [["sv", "easy"], ["sv", "medium"], ["sv", "hard"], ["es", "medium"], ["de", "medium"]]) {
  const ch = (await j(`/api/works/${emis.id}/chapters/${first.id}?lang=${target}&difficulty=${difficulty}`)).d;
  const t = String(ch.translation || "").replace(/\s+/g, " ").trim();
  console.log(`\n${target.toUpperCase()} ${difficulty}${ch.record?.exact ? "" : " (fallback)"}: ${t.slice(0, 260) || "— none —"}`);
}
console.log("\nstats:", JSON.stringify((await j("/api/stats")).d));
console.log("OPEN: " + BASE + "/#/work/" + emis.id);
