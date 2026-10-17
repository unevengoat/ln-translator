// Guard against shipping broken front-end files: this is exactly the class of
// bug that silently broke the live site (a syntax error in public/app.js that
// the library tests could not see).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

describe("front-end syntax", () => {
  it("every shipped .js file parses", async () => {
    const files = [];
    for (const f of await readdir(PUBLIC)) if (f.endsWith(".js")) files.push(path.join(PUBLIC, f));
    for (const dir of ["src", "src/engines", "scripts"]) {
      const full = path.join(ROOT, dir);
      if (!existsSync(full)) continue;
      for (const f of await readdir(full)) if (f.endsWith(".js") || f.endsWith(".mjs")) files.push(path.join(full, f));
    }
    assert.ok(files.length > 10);
    for (const file of files) {
      assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }), `${file} failed to parse`);
    }
  });
});

describe("front-end assets", () => {
  it("index.html references files that exist", async () => {
    const html = await readFile(path.join(PUBLIC, "index.html"), "utf8");
    for (const ref of ["/app.js", "/styles.css", "/manifest.webmanifest"]) {
      assert.ok(html.includes(ref), `index.html should reference ${ref}`);
      assert.ok(existsSync(path.join(PUBLIC, ref.replace(/^\//, ""))), `${ref} must exist`);
    }
    for (const id of ["view-library", "view-reader", "view-add", "view-activity", "view-about"]) {
      assert.ok(html.includes(`id="${id}"`), `index.html should contain ${id}`);
    }
  });

  it("the PWA manifest is valid JSON with the required fields", async () => {
    const manifest = JSON.parse(await readFile(path.join(PUBLIC, "manifest.webmanifest"), "utf8"));
    for (const k of ["name", "short_name", "start_url", "icons"]) assert.ok(manifest[k], `manifest needs ${k}`);
  });

  it("every element id used by app.js exists in index.html", async () => {
    const app = await readFile(path.join(PUBLIC, "app.js"), "utf8");
    const html = await readFile(path.join(PUBLIC, "index.html"), "utf8");
    const ids = new Set([...app.matchAll(/\$\("([A-Za-z0-9_]+)"\)/g)].map((m) => m[1]));
    // ids created dynamically at runtime are allowed
    const dynamic = new Set(["auto_en", "auto_es", "auto_sv", "openNow", "chapterIndexTitle"]);
    const missing = [...ids].filter((id) => !html.includes(`id="${id}"`) && !dynamic.has(id));
    assert.deepEqual(missing, [], "app.js references ids that index.html does not define: " + missing.join(", "));
  });
});
