import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store, LocalBackend } from "../src/store.js";
import {
  ingestText, ensureChapter, getChapter, saveStoryImages, translateWholeStory, ENSURE_CODES,
} from "../src/library.js";
import { encodePng, imageMarker } from "../src/files.js";

// Eight novels, eight styles: heroic fantasy (Eminence-like), Japanese isekai,
// Chinese xianxia, Korean hunter system-windows, epistolary, chat log, poem
// with a refrain, and a formal decree with an embedded illustration.
const NOVELS = [
  {
    name: "shadow-garden", title: "Shadow Garden", lazy: ["Are you with me", "We are the Shadow Garden"],
    lines: [
      ["The moon hung over the royal capital.", "Månen hängde över den kungliga huvudstaden."],
      ["Are you with me?", "Är du med mig?"],
      ["Cid slipped into the shadows.", "Cid smög in i skuggorna."],
      ["We are the Shadow Garden.", "Vi är Shadow Garden."],
      ["Steel sang against steel.", "Stål sjöng mot stål."],
    ],
  },
  {
    name: "isekai", title: "Transfer to Another Classroom", lazy: ["Did you finish your homework", "You must run now"],
    lines: [
      ["Kazuya-senpai waited by the school gate.", "Kazuya-senpai väntade vid skolporten."],
      ["「Did you finish your homework?」", "Har du gjort läxan?"],
      ["The transfer student bowed deeply.", "Utbytesstudenten bugade sig djupt."],
      ["You must run now!", "Du måste springa nu!"],
      ["Cherry blossoms fell like snow.", "Körsbärsblommor föll som snö."],
    ],
  },
  {
    name: "xianxia", title: "Sword of the Nine Heavens", lazy: ["The heavenly tribulation approaches"],
    lines: [
      ["Elder Feng stroked his beard.", "Äldste Feng strök sitt skägg."],
      ["“The heavenly tribulation approaches.”", "Den himmelska prövningen närmar sig."],
      ["Lin Yun circulated his qi.", "Lin Yun cirkulerade sin qi."],
      ["A single sword light split the clouds.", "Ett enda svärdsljus delade molnen."],
    ],
  },
  {
    name: "hunter", title: "Solo Grind", lazy: ["You have acquired the Rusty Dagger"],
    lines: [
      ["[You have acquired the Rusty Dagger.]", "[Du har fått den rostiga dolken.]"],
      ["Jinwoo clenched his fists.", "Jinwoo knöt nävarna."],
      ["The dungeon gate shimmered blue.", "Fängelsehålans port skimrade blå."],
      ["[Quest complete: survive.]", "[Uppdrag slutfört: överlev.]"],
    ],
  },
  {
    name: "letters", title: "Winter Letters", lazy: ["The winter has been cruel this year"],
    lines: [
      ["Dear Margaret,", "Kära Margaret,"],
      ["The winter has been cruel this year.", "Vintern har varit grym i år."],
      ["Write back soon.", "Skriv tillbaka snart."],
      ["Yours, Eleanor", "Din, Eleanor"],
    ],
  },
  {
    name: "chat", title: "Raid Night", lazy: ["you carry the lantern, kai", "they took the bridge already"],
    lines: [
      ["anyone up for a raid?", "någon som vill raida?"],
      ["you carry the lantern, kai", "du bär lyktan, kai"],
      ["they took the bridge already", "de tog bron redan"],
      ["gg, that was fast", "gg, det gick fort"],
    ],
  },
  {
    name: "poem", title: "Road Song", lazy: ["Are you still with me"],
    lines: [
      ["The road is long.", "Vägen är lång."],
      ["The night is dark.", "Natten är mörk."],
      ["Are you still with me?", "Är du fortfarande med mig?"],
      ["The road is long.", "Vägen är lång."],
    ],
  },
  {
    name: "decree", title: "The Dusk Decree", lazy: ["They who shelter the fugitive face the noose"], images: 1,
    lines: [
      ["By order of the crown, all gates close at dusk.", "På kronans order stängs alla portar i skymningen."],
      ["They who shelter the fugitive face the noose.", "De som skyddar flyktingen möter galgen."],
      ["The decree is sealed.", "Dekretet är beseglat."],
    ],
  },
];

const PHRASEBOOK = new Map(NOVELS.flatMap((n) => n.lines.map(([en, sv]) => [bare(en), sv])));
const LAZY = new Set(NOVELS.flatMap((n) => n.lazy));

function bare(line) {
  return String(line).trim().replace(/^[^A-Za-zÀ-ÿ]+|[^A-Za-zÀ-ÿ]+$/g, "");
}

/** A lazy free-tier model: leaves LAZY lines in English on first sight (so a
 *  polish pass is needed), translates them once seen — and always obeys the
 *  numbered phrase-promotion call. Records every glossary it was given. */
function lazyModel() {
  const seen = new Set();
  const calls = [];
  const t = async (chunk, opts = {}) => {
    const text = String(chunk);
    calls.push({ chunk: text.slice(0, 80), glossary: [...(opts.glossary || [])].map((g) => g.source ?? g) });
    if ((opts.notes || "").includes("numbered list")) {
      const out = text.split("\n").map((l) => l.replace(/^(\s*\d+[.)]\s*)(.*)$/, (_, num, p) => {
        const key = p.trim();
        return num + (PHRASEBOOK.get(key) ?? key);
      }));
      return { text: out.join("\n"), provider: "stub", model: "stub" };
    }
    const out = text.split("\n").map((line) => {
      const key = bare(line);
      const sv = PHRASEBOOK.get(key);
      if (!sv) return line;
      if (LAZY.has(key) && !seen.has(key)) { seen.add(key); return line; }
      return line.slice(0, line.indexOf(key)) + sv + line.slice(line.indexOf(key) + key.length);
    });
    return { text: out.join("\n"), provider: "stub", model: "stub" };
  };
  t.calls = calls;
  return t;
}

let dir, store;
before(async () => { dir = await mkdtemp(path.join(tmpdir(), "ln-novels-")); store = new Store(new LocalBackend(dir), { debounceMs: 1 }); });
after(async () => {
  await store.flush().catch(() => null);
  await new Promise((r) => setTimeout(r, 50));
  await rm(dir, { recursive: true, force: true }).catch(() => rm(dir, { recursive: true, force: true }).catch(() => null));
});

describe("auto-ensure sweep: 8 novels, 8 styles", () => {
  for (const novel of NOVELS) {
    it(`${novel.name}: polish passes fix leftovers and pin them as terms`, async () => {
      const t = lazyModel();
      let text = novel.lines.map(([en]) => en).join("\n\n");
      const savedImages = [];
      if (novel.images) {
        const png = encodePng(2, 2, new Uint8Array([9, 9, 9, 4, 4, 4, 6, 6, 6, 1, 1, 1]), false);
        const id = createHash("sha256").update(png).digest("hex").slice(0, 12);
        await saveStoryImages(store, [{ id, contentType: "image/png", data: png }]);
        savedImages.push(id);
        const [first, ...rest] = novel.lines.map(([en]) => en);
        text = [first, imageMarker(id), ...rest].join("\n\n");
      }
      const { workId, chapterId } = await ingestText(store, { title: `Sweep ${novel.title}`, text, sourceLang: "en" });
      const r = await ensureChapter(store, { workId, chapterId, target: "sv", translate: t, maxPasses: 3 });
      assert.ok(r.passes >= 1, `expected at least one polish pass, got ${r.passes}`);

      const fixable = (r.warnings || []).filter((w) => ENSURE_CODES.has(w.code));
      assert.equal(fixable.length, 0, `still dirty after ensure: ${JSON.stringify(fixable)}`);

      // Every line translated, including the ones the first pass left behind.
      const ch = await getChapter(store, { workId, chapterId, lang: "sv" });
      for (const [, sv] of novel.lines) assert.ok(ch.translation.includes(sv), `missing translation: ${sv}`);
      for (const lazy of novel.lazy) {
        const enLine = novel.lines.find(([en]) => bare(en) === lazy)[0];
        assert.ok(!ch.translation.includes(enLine), `leftover English survived: ${enLine}`);
      }

      // Leftovers were promoted to glossary terms, and the retry saw them.
      const terms = await store.loadTerms(workId);
      for (const lazy of novel.lazy) {
        const hit = Object.entries(terms).find(([src]) => src.toLowerCase().includes(lazy.toLowerCase().slice(0, 12)));
        assert.ok(hit, `no term pinned for leftover: ${lazy}`);
        assert.equal(hit[1].langs?.sv?.canonical, PHRASEBOOK.get(lazy), `term mistranslated: ${lazy}`);
      }
      const retryCall = t.calls.find((c) => (c.glossary || []).some((g) => novel.lazy.some((l) => String(g).toLowerCase().includes(l.toLowerCase().slice(0, 12)))));
      assert.ok(retryCall, "no retry call carried the promoted phrases in its glossary");

      // Illustrations survive the whole loop.
      for (const id of savedImages) {
        assert.ok(ch.translation.includes(imageMarker(id)), "marker lost in translation");
        assert.ok((ch.images || []).some((im) => im.id === id), "image missing from chapter");
      }

      // A repeated refrain gets the same translation both times.
      const refrains = novel.lines.map(([, sv]) => sv).filter((sv, i, all) => all.indexOf(sv) !== i);
      for (const refrain of new Set(refrains)) {
        assert.equal(ch.translation.split(refrain).length - 1, novel.lines.filter(([, sv]) => sv === refrain).length, `refrain inconsistent: ${refrain}`);
      }
    });
  }

  it("whole-story translation also auto-ensures every chapter", async () => {
    const t = lazyModel();
    const novel = NOVELS[0];
    const { workId } = await ingestText(store, { title: `Whole ${novel.title}`, text: novel.lines.map(([en]) => en).join("\n\n"), sourceLang: "en" });
    const r = await translateWholeStory(store, { workId, target: "sv", translate: t });
    assert.equal(r.failed, 0);
    for (const c of r.chapters) {
      const fixable = (c.qa?.warns || 0) + (c.qa?.errors || 0);
      assert.equal(fixable, 0, `${c.title} still has warnings: ${JSON.stringify(c.qa)}`);
    }
  });
});
