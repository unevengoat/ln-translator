// Glossary: consistent names / terms across a whole novel.
// Format accepted: [{ source, target }] or { "source": "target" }.

export function parseGlossary(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .filter((e) => e && e.source && e.target)
      .map((e) => ({ source: String(e.source), target: String(e.target) }));
  }
  if (typeof input === "object") {
    return Object.entries(input).map(([source, target]) => ({
      source: String(source),
      target: String(target),
    }));
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return [];
    // Try JSON first.
    try {
      return parseGlossary(JSON.parse(trimmed));
    } catch {
      // Fallback: "source=target" or "source:target" or "source -> target" per line.
      return trimmed
        .split("\n")
        .map((line) => line.split(/=|->|:|,/).map((s) => s.trim()))
        .filter((p) => p.length >= 2 && p[0] && p[1])
        .map(([source, target]) => ({ source, target }));
    }
  }
  return [];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Protect glossary source terms with placeholders before sending to a
 * non-instruction-following engine (free MT), then restore to the target term.
 * Returns { text, restore(translated) }.
 */
export function protectTerms(text, glossary) {
  const entries = parseGlossary(glossary).filter((e) => e.source);
  if (!entries.length) return { text, restore: (t) => t, count: 0 };
  // Longest source first so "Kazuya-senpai" wins over "Kazuya".
  const sorted = [...entries].sort((a, b) => b.source.length - a.source.length);
  let protectedText = text;
  const tokenOf = new Map();
  sorted.forEach((e, i) => {
    const token = `__LNG${i}__`;
    tokenOf.set(token, e.target);
    protectedText = protectedText.replaceAll(e.source, token);
  });
  let count = 0;
  for (const t of tokenOf.keys()) if (protectedText.includes(t)) count++;
  const restore = (translated) => {
    let out = String(translated ?? "");
    // Exact pass first (engine left tokens untouched).
    for (const [token, target] of tokenOf) out = out.replaceAll(token, target);
    // Tolerant pass: MT often inserts spaces inside unknown tokens
    // ("__LNG0__" -> "__ LNG0 __"), so match with flexible whitespace.
    out = out.replace(/_\s*_\s*LNG\s*(\d+)\s*_\s*_/g, (m, i) => {
      const targets = [...tokenOf.values()];
      return targets[Number(i)] ?? m;
    });
    return out;
  };
  return { text: protectedText, restore, count };
}

/** Render glossary as prompt lines for the AI engine. */
export function glossaryPromptLines(glossary) {
  return parseGlossary(glossary).map((e) => `- "${e.source}" MUST be translated as "${e.target}"`);
}
