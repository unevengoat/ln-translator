// Probe provider accounts: key validity + currently available models.
// Keys ONLY from env vars. Read-only calls (list-models), no spend.
const probes = [
  {
    name: "openrouter",
    run: async () => {
      const r = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      });
      if (!r.ok) return `HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`;
      const { data } = await r.json();
      const free = data.filter((m) => m.pricing && Number(m.pricing.prompt) === 0).map((m) => m.id);
      return `${data.length} models, ${free.length} free: ${free.slice(0, 15).join(", ")}`;
    },
  },
  {
    name: "gemini",
    run: async () => {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(process.env.GEMINI_API_KEY || "")}`);
      const t = await r.text();
      if (!r.ok) return `HTTP ${r.status}: ${t.slice(0, 200)}`;
      const { models } = JSON.parse(t);
      return `${models.length} models: ${models.map((m) => m.name.replace("models/", "")).slice(0, 20).join(", ")}`;
    },
  },
  {
    name: "nvidia",
    run: async () => {
      const r = await fetch("https://integrate.api.nvidia.com/v1/models", {
        headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
      });
      const t = await r.text();
      if (!r.ok) return `HTTP ${r.status}: ${t.slice(0, 200)}`;
      return JSON.parse(t).data.map((m) => m.id).slice(0, 25).join(", ");
    },
  },
  {
    name: "cerebras",
    run: async () => {
      const r = await fetch("https://api.cerebras.ai/v1/models", {
        headers: { Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}` },
      });
      const t = await r.text();
      if (!r.ok) return `HTTP ${r.status}: ${t.slice(0, 200)}`;
      return JSON.parse(t).data.map((m) => m.id).join(", ");
    },
  },
  {
    name: "groq",
    run: async () => {
      const r = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      });
      const t = await r.text();
      if (!r.ok) return `HTTP ${r.status}: ${t.slice(0, 200)}`;
      return JSON.parse(t).data.map((m) => m.id).slice(0, 30).join(", ");
    },
  },
  {
    name: "pollinations-raw",
    run: async () => {
      const r = await fetch("https://text.pollinations.ai/openai", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(process.env.POLLINATIONS_API_KEY ? { Authorization: `Bearer ${process.env.POLLINATIONS_API_KEY}` } : {}) },
        body: JSON.stringify({ model: "openai", messages: [{ role: "user", content: "Say OK" }] }),
      });
      const t = await r.text();
      return `HTTP ${r.status}: ${t.slice(0, 400)}`;
    },
  },
];

for (const p of probes) {
  try {
    console.log(`\n### ${p.name}\n${await p.run()}`);
  } catch (e) {
    console.log(`\n### ${p.name}\nERROR: ${e.message}`);
  }
}
