const BASE = "https://ln-translator.onrender.com";
const j = async (p, o) => { const r = await fetch(BASE + p, o); const t = await r.text(); return { s: r.status, t, d: (() => { try { return JSON.parse(t); } catch { return null; } })() }; };
const post = (p, b) => j(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

const list = await j("/api/works");
const works = list.d?.works || list.d || [];
console.log(`/api/works → ${(list.t.length / 1024).toFixed(1)} KB (was 26 KB)`);
const w = works[0];
const full = await j("/api/works/" + w.id);
console.log(`/api/works/:id → ${(full.t.length / 1024).toFixed(1)} KB (was 371 KB) | terms embedded: ${full.d.terms ? "YES" : "no"} | termCount: ${full.d.termCount}`);
const c1 = (full.d.chapters || []).find((c) => /^Chapter 1/.test(c.title));
console.log("chapter:", c1.title, "| variants:", JSON.stringify(c1.variants));

console.log("\nrefreshing terms for Swedish (re-samples 3 chapters)…");
const t1 = Date.now();
const ref = await post(`/api/works/${w.id}/terms/refresh`, { lang: "sv" });
console.log(`refresh → ${ref.s} in ${((Date.now() - t1) / 1000).toFixed(1)}s:`, JSON.stringify(ref.d));

console.log("\ntriggering es/hard (not translated yet) to watch chunk progress…");
const t0 = Date.now();
const trig = await post(`/api/works/${w.id}/chapters/${c1.id}/translate`, { target: "es", difficulty: "hard" });
console.log("trigger →", trig.s, trig.d?.jobId);
let last = "";
for (let i = 0; i < 45; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const job = await j(`/api/jobs/${trig.d.jobId}`);
  const d = job.d || {};
  const line = `${d.state} ${d.done}/${d.total} — ${d.current || ""}`;
  if (line !== last) { console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${line}`); last = line; }
  if (d.state !== "running") { console.log("result:", JSON.stringify(d.result || d.error || "").slice(0, 200)); break; }
}
console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);
const h = await j("/api/health");
console.log("\npool:", JSON.stringify(h.d.pool.map((p) => ({ p: p.provider, ok: p.ok, failed: p.failed, rl: p.rateLimited }))));
