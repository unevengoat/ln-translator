const BASE = "https://ln-translator.onrender.com";
const j = async (p, o) => { const r = await fetch(BASE + p, o); return { s: r.status, d: await r.json().catch(() => ({})) }; };

const works = (await j("/api/works")).d;
for (const w of (works.works || works)) console.log(`story: ${w.title} [${w.id}] ${w.chapterCount} ch, ${w.translatedCount} translations`);

const emis = (works.works || works).find((w) => /Eminence/i.test(w.title));
const work = (await j("/api/works/" + emis.id)).d;
console.log("\nvolumes:", work.volumes.map((v) => v.label).join(", "));
console.log("tmSegments (target|level → cached chunks):", JSON.stringify(work.tmSegments));
console.log("models pinned:", JSON.stringify(work.models));
console.log("usage:", JSON.stringify(work.usage));
console.log("\nchapter 1 variants:", JSON.stringify(work.chapters.find((c) => /^Chapter 1/.test(c.title))?.variants || []));

// delete my placeholder demo story
const lantern = (works.works || works).find((w) => /Lantern Keeper/i.test(w.title));
if (lantern) {
  const r = await fetch(`${BASE}/api/works/${lantern.id}`, { method: "DELETE" });
  console.log("\nremoved placeholder demo:", lantern.title, "→", r.status);
}
console.log("stats:", JSON.stringify((await j("/api/stats")).d));
console.log("\nOPEN: " + BASE + "/#/work/" + emis.id);
