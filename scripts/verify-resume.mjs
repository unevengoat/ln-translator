const BASE = "https://ln-translator.onrender.com";
const j = async (p, o) => { const r = await fetch(BASE + p, o); const t = await r.text(); return { s: r.status, t, d: (() => { try { return JSON.parse(t); } catch { return null; } })() }; };
const post = (p, b) => j(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

const list = (await j("/api/works")).d;
const works = list.works || list;
const w = works[0];
const full = (await j("/api/works/" + w.id)).d;
const c1 = full.chapters.find((c) => /^Chapter 1/.test(c.title));
console.log("variants before:", JSON.stringify(c1.variants));

console.log("\ntriggering es/hard again (should RESUME from cached chunks)…");
const t0 = Date.now();
const trig = await post(`/api/works/${w.id}/chapters/${c1.id}/translate`, { target: "es", difficulty: "hard" });
console.log("trigger →", trig.s, trig.d?.jobId);
let last = "";
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const d = (await j(`/api/jobs/${trig.d.jobId}`)).d || {};
  const line = `${d.state} ${d.done}/${d.total}`;
  if (line !== last) { console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${line} — ${d.current || ""}`); last = line; }
  if (d.state !== "running") { console.log("result:", JSON.stringify(d.result || d.error || "").slice(0, 220)); break; }
}
console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);
const h = (await j("/api/health")).d;
console.log("\npool:", JSON.stringify(h.pool.map((p) => ({ p: p.provider, ok: p.ok, failed: p.failed, rl: p.rateLimited, disabled: p.disabled || false }))));
const es = (await j(`/api/works/${w.id}/chapters/${c1.id}?lang=es&difficulty=hard`)).d;
console.log("\nES hard sample:", String(es.translation || "").replace(/\s+/g, " ").slice(0, 180));
