// Extreme audit: payload sizes, term quality, and a timed chapter translation.
const BASE = process.env.BASE || "https://ln-translator.onrender.com";
const j = async (p, o) => { const r = await fetch(BASE + p, o); const t = await r.text(); return { s: r.status, t, d: (() => { try { return JSON.parse(t); } catch { return null; } })() }; };

const list = await j("/api/works");
const works = list.d?.works || list.d || [];
console.log(`GET /api/works → ${list.s}, ${(list.t.length / 1024).toFixed(0)} KB, ${works.length} works`);
const work = works[0];
console.log("work:", work?.title, work?.id);

const full = await j("/api/works/" + work.id);
console.log(`GET /api/works/:id → ${full.s}, ${(full.t.length / 1024).toFixed(0)} KB`);
const chapters = full.d.chapters || [];
console.log("chapters:", chapters.length, "| volumes:", (full.d.volumes || []).length, "| chapters payload KB:", (JSON.stringify(chapters).length / 1024).toFixed(0));
console.log("terms embedded in work:", full.d.terms ? Object.keys(full.d.terms).length : 0, "| terms payload KB:", full.d.terms ? (JSON.stringify(full.d.terms).length / 1024).toFixed(0) : 0);
console.log("tmSegments:", JSON.stringify(full.d.tmSegments), "| models:", JSON.stringify(full.d.models));

const terms = await j(`/api/works/${work.id}/terms?lang=sv`);
console.log(`GET terms?lang=sv → ${terms.s}, ${(terms.t.length / 1024).toFixed(0)} KB, ${terms.d.terms.length} terms`);
const junk = terms.d.terms.filter((t) => t.source.length > 13 && !/[\s\-']/.test(t.source));
console.log("suspicious long tokens:", junk.length, "e.g.", junk.slice(0, 8).map((t) => t.source).join(", "));
const stop = terms.d.terms.filter((t) => /^(the|and|any|all|names|cover|translation|copyright)$/i.test(t.source));
console.log("stopword terms still present:", stop.length, stop.slice(0, 8).map((t) => t.source).join(", "));

const c1 = chapters.find((c) => /^Chapter 1/.test(c.title));
console.log("\nchapter:", c1?.title, c1?.id, "| variants:", JSON.stringify(c1?.variants));

// timed chapter translation (Swedish / hard = not done yet)
console.log("\ntriggering sv/hard translation of that chapter…");
const t0 = Date.now();
const trig = await j(`/api/works/${work.id}/chapters/${c1.id}/translate`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: "sv", difficulty: "hard" }),
});
console.log("trigger →", trig.s, JSON.stringify(trig.d).slice(0, 160));
if (trig.d?.jobId) {
  let last = "";
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const job = await j(`/api/jobs/${trig.d.jobId}`);
    const jd = job.d || {};
    const line = `${jd.state} ${jd.done}/${jd.total} ${jd.current || ""}`;
    if (line !== last) { console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${line}`); last = line; }
    if (jd.state !== "running") {
      console.log("result:", JSON.stringify(jd.result || jd.error || "").slice(0, 220));
      break;
    }
  }
  console.log(`total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
const health = await j("/api/health");
console.log("\npool:", JSON.stringify(health.d.pool));
console.log("provider mix:", JSON.stringify(Object.fromEntries(works.map((w) => [w.id, w]))) ? "" : "");
