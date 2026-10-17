process.env.GROQ_API_KEY = "test-key";
process.env.POOL_MIN_GAP_MS = "0";
process.env.POOL_COOLDOWN_MS = "0";
process.env.POOL_DEADLINE_MS = "500";
import { translatePooled, configuredProviders, poolStatus } from "../src/engines/pool.js";

console.log("configured:", JSON.stringify(configuredProviders()));
const fetchFn = async (url) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: "OK" } }] }) });
try {
  const r = await translatePooled("hello", { target: "sv", source: "en", providers: ["groq"], fetchFn });
  console.log("result:", JSON.stringify(r));
} catch (e) {
  console.log("ERROR:", e.message);
}
import { translateText } from "../src/engines/index.js";
const ok = async (url) => { console.log("  fetch:", String(url).slice(0, 60)); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: "VIA TRANSFERTEXT" } }] }) }; };
try {
  const r = await translateText("Hard text here.", { source: "en", target: "en", difficulty: "easy", ai: { apiKey: "k" }, providers: ["groq"], fetchFn: ok });
  console.log("translateText:", JSON.stringify(r).slice(0, 200));
} catch (e) {
  console.log("translateText ERROR:", e.message.slice(0, 300));
}
console.log("pool:", JSON.stringify(poolStatus()));

