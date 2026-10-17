import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, LocalBackend } from "../src/store.js";
import {
  hashPin, verifyPin, listProfiles, createProfile, loginProfile, authProfile, requireProfile,
  updateProfile, deleteProfile, getState, patchState, publicProfile,
} from "../src/profiles.js";
import { parseBuffer } from "../src/files.js";

let dir, store;
before(async () => { dir = await mkdtemp(path.join(tmpdir(), "ln-prof-")); store = new Store(new LocalBackend(dir), { debounceMs: 1 }); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

describe("profile PINs", () => {
  it("hashes with a salt and verifies only the right PIN", () => {
    const { salt, hash } = hashPin("1234");
    assert.equal(verifyPin("1234", salt, hash), true);
    assert.equal(verifyPin("9999", salt, hash), false);
    assert.equal(verifyPin("1234", salt, hashPin("1111").hash), false);
    const other = hashPin("1234");
    assert.notEqual(other.hash, hash, "same PIN must not produce the same hash (unique salt)");
  });
  it("treats a profile without a PIN as open", () => {
    assert.equal(verifyPin("", "", ""), true);
    assert.equal(verifyPin("anything", "", ""), true);
  });
});

describe("profiles", () => {
  it("creates profiles with avatars and never leaks PIN material", async () => {
    const a = await createProfile(store, { name: "Alex", pin: "1111" });
    const b = await createProfile(store, { name: "Sam" });
    assert.equal(a.name, "Alex");
    assert.equal(a.hasPin, true);
    assert.equal(b.hasPin, false);
    assert.ok(a.avatar && a.color);
    assert.equal(a.salt, undefined, "no salt in the public shape");
    assert.equal(a.hash, undefined, "no hash in the public shape");
    const list = await listProfiles(store);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((p) => p.name).sort(), ["Alex", "Sam"]);
  });

  it("logs in with the PIN and issues a working token", async () => {
    const [alex] = (await listProfiles(store)).filter((p) => p.name === "Alex");
    await assert.rejects(() => loginProfile(store, alex.id, "0000"), /Wrong PIN/);
    const { token, profile } = await loginProfile(store, alex.id, "1111");
    assert.ok(token.length > 20);
    assert.equal(profile.name, "Alex");
    const me = await authProfile(store, token);
    assert.equal(me.id, alex.id);
    assert.equal(await authProfile(store, "nonsense"), null);
  });

  it("refuses state access without the profile's own token", async () => {
    const [alex] = (await listProfiles(store)).filter((p) => p.name === "Alex");
    await assert.rejects(() => requireProfile(store, alex.id, "bad"), /locked/i);
    const { token } = await loginProfile(store, alex.id, "1111");
    const ok = await requireProfile(store, alex.id, token);
    assert.equal(ok.name, "Alex");
  });

  it("keeps reading state per profile", async () => {
    const [alex] = (await listProfiles(store)).filter((p) => p.name === "Alex");
    const [sam] = (await listProfiles(store)).filter((p) => p.name === "Sam");
    await patchState(store, alex.id, {
      progress: { "w1/c1/en/easy": { workId: "w1", chapterId: "c1", lang: "en", level: "easy", percent: 40, title: "Story · Ch 1" } },
      myList: { add: ["w1"] }, look: { theme: "night", size: 22 }, level: "easy",
    });
    const alexState = await getState(store, alex.id);
    assert.equal(alexState.myList.length, 1);
    assert.equal(alexState.progress["w1/c1/en/easy"].percent, 40);
    assert.equal(alexState.look.theme, "night");
    assert.equal(alexState.level, "easy");

    const samState = await getState(store, sam.id);
    assert.deepEqual(samState.myList, [], "profiles must not share private state");

    await patchState(store, alex.id, { myList: { remove: ["w1"] }, progress: { "w1/c1/en/easy": null } });
    const after = await getState(store, alex.id);
    assert.deepEqual(after.myList, []);
    assert.equal(after.progress["w1/c1/en/easy"], undefined);
  });

  it("updates a profile, drops sessions on PIN change, and deletes", async () => {
    const [sam] = (await listProfiles(store)).filter((p) => p.name === "Sam");
    const { token } = await loginProfile(store, sam.id, "");
    assert.ok(await authProfile(store, token));
    const updated = await updateProfile(store, sam.id, { name: "Sammy", pin: "4321" });
    assert.equal(updated.name, "Sammy");
    assert.equal(updated.hasPin, true);
    assert.equal(await authProfile(store, token), null, "PIN change invalidates old sessions");
    await deleteProfile(store, sam.id);
    assert.equal((await listProfiles(store)).length, 1);
  });
});

describe("extra file formats", () => {
  it("parses RTF", async () => {
    const rtf = String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Times;}}\fs24 Chapter 1\par Hello \'e9 world.\par\par Second paragraph.}`;
    const text = await parseBuffer("book.rtf", Buffer.from(rtf, "utf8"));
    assert.match(text, /Hello/);
    assert.match(text, /Second paragraph/);
    assert.doesNotMatch(text, /\\rtf|\\fonttbl/);
  });

  it("parses FB2", async () => {
    const fb2 = `<?xml version="1.0"?><FictionBook><body><section><title><p>Chapter 1</p></title><p>Kirito walked.</p><p>Asuna followed.</p></section></body></FictionBook>`;
    const text = await parseBuffer("book.fb2", Buffer.from(fb2, "utf8"));
    assert.match(text, /Chapter 1/);
    assert.match(text, /Kirito walked\./);
    assert.match(text, /Asuna followed\./);
  });

  it("parses DOCX and ODT (zip + xml)", async () => {
    const { default: JSZip } = await import("jszip");
    const docx = new JSZip();
    docx.file("word/document.xml", `<w:document><w:body><w:p><w:r><w:t>Chapter 1</w:t></w:r></w:p><w:p><w:r><w:t>Hello docx.</w:t></w:r></w:p></w:body></w:document>`);
    const dtext = await parseBuffer("book.docx", await docx.generateAsync({ type: "nodebuffer" }));
    assert.match(dtext, /Chapter 1/);
    assert.match(dtext, /Hello docx\./);

    const odt = new JSZip();
    odt.file("content.xml", `<office:document-content><text:p>Chapter 1</text:p><text:p>Hello odt.</text:p></office:document-content>`);
    const otext = await parseBuffer("book.odt", await odt.generateAsync({ type: "nodebuffer" }));
    assert.match(otext, /Hello odt\./);
  });

  it("parses a ZIP of chapters and keeps them ordered and split-able", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("10-chapter.txt", "Tenth chapter body.");
    zip.file("2-chapter.txt", "Second chapter body.");
    const text = await parseBuffer("bundle.zip", await zip.generateAsync({ type: "nodebuffer" }));
    assert.ok(text.indexOf("Second chapter body") < text.indexOf("Tenth chapter body"), "natural sort order");
    const { splitChapters } = await import("../src/library.js");
    assert.ok(splitChapters(text).length >= 2, "split marker inserted so chapters split");
  });

  it("rejects a zip with nothing readable", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("notes.xyz", "nope");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    await assert.rejects(() => parseBuffer("empty.zip", buf), /no readable files/i);
  });
});
