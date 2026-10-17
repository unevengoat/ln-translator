// Free engine: no API key. Primary = Google gtx endpoint, fallback = MyMemory.
import { googleCode } from "../languages.js";

const GTX = "https://translate.googleapis.com/translate_a/single";

async function googleTranslate(text, source, target, fetchFn = fetch) {
  const sl = source === "auto" ? "auto" : googleCode(source);
  const tl = googleCode(target);
  // gtx caps out around ~1500 chars per request; split defensively.
  const parts = [];
  for (let i = 0; i < text.length; i += 1400) parts.push(text.slice(i, i + 1400));
  let out = "";
  for (const q of parts) {
    const url = `${GTX}?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(q)}`;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`Google free endpoint HTTP ${res.status}`);
    const data = await res.json();
    // data[0] = array of [translated, original, ...] segments.
    out += (data?.[0] || []).map((seg) => seg?.[0] ?? "").join("");
  }
  if (!out.trim()) throw new Error("Google free endpoint returned empty result");
  return out;
}

async function myMemoryTranslate(text, source, target, fetchFn = fetch) {
  const langpair = `${source === "auto" ? "autodetect" : source}|${target}`;
  const parts = [];
  for (let i = 0; i < text.length; i += 450) parts.push(text.slice(i, i + 450)); // MyMemory 500-char limit
  let out = "";
  for (const q of parts) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(langpair)}`;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
    const data = await res.json();
    const t = data?.responseData?.translatedText;
    if (!t) throw new Error("MyMemory returned no translation: " + JSON.stringify(data).slice(0, 200));
    out += t;
    await new Promise((r) => setTimeout(r, 300)); // be polite to the free quota
  }
  return out;
}

export async function translateFree(text, { source = "auto", target = "en", fetchFn = fetch } = {}) {
  const errors = [];
  try {
    return cleanupFreeText(await googleTranslate(text, source, target, fetchFn), target);
  } catch (e) {
    errors.push("google: " + e.message);
  }
  try {
    return cleanupFreeText(await myMemoryTranslate(text, source, target, fetchFn), target);
  } catch (e) {
    errors.push("mymemory: " + e.message);
  }
  throw new Error("Free engine failed (" + errors.join("; ") + ")");
}

// MT output is literal and sloppy: missing spaces after punctuation
// ("Kirito.Are"), stray quotes from 「...」と ("? "and Asuna whispered").
// These mechanical fixes apply only to space-separated target languages.
const NO_SPACE_LANGS = new Set(["ja", "zh-CN", "zh-TW", "th", "my"]);

export function cleanupFreeText(text, target = "en") {
  let out = String(text ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (NO_SPACE_LANGS.has(target)) return out;
  // "word.Word" -> "word. Word". Digits excluded so "3.14" and "1,000" survive;
  // closing quotes excluded so today?" stays intact.
  out = out
    .replace(/([.!?,;:])(?=[A-Za-z‘([{])/g, "$1 ")
    .replace(/([,;:])(?=["“])/g, "$1 ")
    .replace(/[ \t]{2,}/g, " ");
  if (target === "en") {
    // Close JP dialogue quotes cleanly:  today? "and Asuna whispered.  ->  today?" Asuna whispered.
    out = out.replace(/([?!.…])\s*"\s*and ([A-Z][a-z]+(?: [A-Z][a-z]+)?) (whispered|said|asked|shouted|replied|murmured|cried|laughed|sighed|nodded)/g, '$1" $2 $3');
  }
  return out;
}
