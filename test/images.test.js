import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { inflateSync } from "node:zlib";
import JSZip from "jszip";
import { Store, LocalBackend } from "../src/store.js";
import {
  parseBufferWithImages, parseBuffer, extractImageIds, encodePng, imageMarker,
} from "../src/files.js";
import { ingestText, getChapter, getWork, translateChapter, saveStoryImages } from "../src/library.js";

const idOf = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);
// 2x2 RGB fixture (12 bytes) — deterministic pixels.
const PIX = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
const pngOf = (pix = PIX) => encodePng(2, 2, pix, false);

let dir, store;
before(async () => { dir = await mkdtemp(path.join(tmpdir(), "ln-img-")); store = new Store(new LocalBackend(dir), { debounceMs: 1 }); });
after(async () => {
  await store.flush().catch(() => null);
  await new Promise((r) => setTimeout(r, 50));
  await rm(dir, { recursive: true, force: true }).catch(() => rm(dir, { recursive: true, force: true }).catch(() => null));
});

describe("encodePng (dependency-free PNG writer)", () => {
  it("writes a valid PNG with correct dimensions", () => {
    const png = pngOf();
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 2, "IHDR width");
    assert.equal(png.readUInt32BE(20), 2, "IHDR height");
    assert.equal(png[25], 2, "color type 2 = RGB");
    // IDAT must inflate to filter-byte + rows.
    const idatStart = png.indexOf(Buffer.from("IDAT")) + 4;
    const idatLen = png.readUInt32BE(idatStart - 8);
    const raw = inflateSync(png.subarray(idatStart, idatStart + idatLen));
    assert.equal(raw.length, (2 * 3 + 1) * 2);
    assert.deepEqual([...raw.subarray(1, 7)], [255, 0, 0, 0, 255, 0]);
  });
  it("supports RGBA", () => {
    const png = encodePng(1, 1, new Uint8Array([10, 20, 30, 40]), true);
    assert.equal(png[25], 6, "color type 6 = RGBA");
  });
});

describe("extractImageIds / imageMarker", () => {
  it("finds ids in order, deduplicated", () => {
    assert.deepEqual(extractImageIds(`a ${imageMarker("a1b2c3d4e5f6")} b ${imageMarker("001122334455")} c ${imageMarker("a1b2c3d4e5f6")}`), ["a1b2c3d4e5f6", "001122334455"]);
    assert.deepEqual(extractImageIds("no images here [[img:xyz]]"), []);
  });
  it("ids are content hashes: same bytes = same id, different bytes = different id", async () => {
    const a = await parseBufferWithImages("a.html", Buffer.from(`<p>x</p><img src="data:image/png;base64,${pngOf().toString("base64")}">`));
    const b = await parseBufferWithImages("b.html", Buffer.from(`<p>y</p><img src="data:image/png;base64,${pngOf().toString("base64")}">`));
    assert.equal(a.images[0].id, b.images[0].id, "identical bytes must dedupe to one id");
    const other = new Uint8Array([...PIX]); other[0] = 1;
    const c = await parseBufferWithImages("c.html", Buffer.from(`<p>z</p><img src="data:image/png;base64,${pngOf(other).toString("base64")}">`));
    assert.notEqual(c.images[0].id, a.images[0].id);
  });
});

describe("parseBufferWithImages: HTML", () => {
  it("keeps a data-uri illustration as a marker paragraph in reading order", async () => {
    const { text, images } = await parseBufferWithImages("ch.html", Buffer.from(
      `<h1>Ch 1</h1><p>First para.</p><img src="data:image/png;base64,${pngOf().toString("base64")}" alt="art"><p>Second para.</p>`
    ));
    assert.equal(images.length, 1);
    assert.equal(images[0].contentType, "image/png");
    assert.deepEqual(images[0].data.subarray(0, 4), pngOf().subarray(0, 4));
    const lines = paras(text);
    assert.deepEqual(lines, ["Ch 1", "First para.", imageMarker(images[0].id), "Second para."]);
    assert.ok(IMAGE_RE.test(text));
  });
});
const IMAGE_RE = /\[\[img:[0-9a-f]{12}\]\]/;
const paras = (t) => String(t).trim().split("\n\n");

describe("parseBufferWithImages: EPUB", () => {
  it("extracts a packaged image referenced by the chapter", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("OEBPS/content.opf", `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="ch" href="ch.xhtml" media-type="application/xhtml+xml"/><item id="pic" href="img/pic.png" media-type="image/png"/></manifest><spine><itemref idref="ch"/></spine></package>`);
    zip.file("OEBPS/ch.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Before.</p><p><img src="img/pic.png"/></p><p>After.</p></body></html>`);
    zip.file("OEBPS/img/pic.png", pngOf());
    const { text, images } = await parseBufferWithImages("novel.epub", await zip.generateAsync({ type: "nodebuffer" }));
    assert.equal(images.length, 1);
    assert.equal(images[0].contentType, "image/png");
    assert.deepEqual(paras(text), ["Before.", imageMarker(images[0].id), "After."]);
  });
  it("ignores cover-only images never referenced by any chapter", async () => {
    const zip = new JSZip();
    zip.file("OEBPS/content.opf", `<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="ch" href="ch.xhtml" media-type="application/xhtml+xml"/><item id="cov" href="cover.png" media-type="image/png" properties="cover-image"/></manifest><spine><itemref idref="ch"/></spine></package>`);
    zip.file("OEBPS/ch.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Text only.</p></body></html>`);
    zip.file("OEBPS/cover.png", pngOf());
    const { text, images } = await parseBufferWithImages("n.epub", await zip.generateAsync({ type: "nodebuffer" }));
    assert.equal(text.trim(), "Text only.");
    assert.equal(images.length, 0);
  });
});

describe("parseBufferWithImages: DOCX", () => {
  const docxWith = async (drawingXml, relsXml, files = {}) => {
    const zip = new JSZip();
    zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body><w:p><w:r><w:t>Hello.</w:t></w:r></w:p>${drawingXml}<w:p><w:r><w:t>Bye.</w:t></w:r></w:p></w:body></w:document>`);
    zip.file("word/_rels/document.xml.rels", relsXml);
    for (const [p, data] of Object.entries(files)) zip.file(p, data);
    return parseBufferWithImages("ch.docx", await zip.generateAsync({ type: "nodebuffer" }));
  };
  const RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pic.png"/></Relationships>`;
  it("extracts an inline image between paragraphs", async () => {
    const drawing = `<w:p><w:r><w:drawing><wp:inline><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId2"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const { text, images } = await docxWith(drawing, RELS, { "word/media/pic.png": pngOf() });
    assert.equal(images.length, 1);
    assert.deepEqual(paras(text), ["Hello.", imageMarker(images[0].id), "Bye."]);
  });
  it("resolves absolute /docProps-style and odd-case rel targets", async () => {
    const drawing = `<w:p><w:r><w:drawing><wp:anchor><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId2"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`;
    const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="/word/Media/PIC.PNG"/></Relationships>`;
    const { images } = await docxWith(drawing, rels, { "word/Media/PIC.PNG": pngOf() });
    assert.equal(images.length, 1);
  });
  it("skips a drawing whose binary is missing instead of failing", async () => {
    const drawing = `<w:p><w:r><w:drawing><wp:inline><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId9"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const { text, images } = await docxWith(drawing, RELS, {});
    assert.equal(images.length, 0);
    assert.ok(text.includes("Hello.") && text.includes("Bye."));
  });
});

describe("parseBufferWithImages: ODT", () => {
  it("extracts Pictures/* images in reading order", async () => {
    const zip = new JSZip();
    zip.file("content.xml", `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"><office:body><office:text><text:p>Start.</text:p><text:p><draw:frame><draw:image xlink:href="Pictures/pic.png"/></draw:frame></text:p><text:p>End.</text:p></office:text></office:body></office:document-content>`);
    zip.file("Pictures/pic.png", pngOf());
    const { text, images } = await parseBufferWithImages("ch.odt", await zip.generateAsync({ type: "nodebuffer" }));
    assert.equal(images.length, 1);
    assert.deepEqual(paras(text), ["Start.", imageMarker(images[0].id), "End."]);
  });
});

describe("parseBufferWithImages: FB2", () => {
  it("extracts base64 binaries referenced by image hrefs", async () => {
    const b64 = pngOf().toString("base64");
    const fb2 = `<?xml version="1.0"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:xlink="http://www.w3.org/1999/xlink"><body><section><title><p>Ch</p></title><p>Text.</p><image xlink:href="#pic"/><p>More.</p></section></body><binary id="pic" content-type="image/png">${b64}</binary></FictionBook>`;
    const { text, images } = await parseBufferWithImages("n.fb2", Buffer.from(fb2));
    assert.equal(images.length, 1);
    assert.equal(images[0].contentType, "image/png");
    assert.deepEqual(images[0].data, pngOf());
    assert.deepEqual(paras(text), ["Ch", "Text.", imageMarker(images[0].id), "More."]);
  });
  it("handles coverpage image elements too", async () => {
    const b64 = pngOf().toString("base64");
    const fb2 = `<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:xlink="http://www.w3.org/1999/xlink"><description><title-info><coverpage><image xlink:href="#cov"/></coverpage></title-info></description><body><section><p>Body.</p></section></body><binary id="cov" content-type="image/png">${b64}</binary></FictionBook>`;
    const { images } = await parseBufferWithImages("n.fb2", Buffer.from(fb2));
    assert.equal(images.length, 1);
  });
});

/** Minimal two-page PDF: text lines + the same painted 64x64 RGB image on both pages. */
function buildPdfWithImage() {
  const W = 64, H = 64;
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = (i * 7) % 256; rgb[i * 3 + 1] = (i * 13) % 256; rgb[i * 3 + 2] = (i * 29) % 256; }
  const pageRes = `<< /XObject << /Im0 6 0 R >> /Font << /F1 7 0 R >> >>`;
  const content1 = Buffer.from("BT /F1 12 Tf 50 150 Td (Hello chapter one.) Tj ET\nq 64 0 0 64 50 50 cm /Im0 Do Q\n", "latin1");
  const content2 = Buffer.from("BT /F1 12 Tf 50 150 Td (Hello chapter two.) Tj ET\nq 64 0 0 64 50 50 cm /Im0 Do Q\n", "latin1");
  const streamObj = (buf) => ({ raw: Buffer.concat([Buffer.from(`<< /Length ${buf.length} >>\nstream\n`, "latin1"), buf, Buffer.from("\nendstream", "latin1")]) });
  const objs = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R /Resources ${pageRes} >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 8 0 R /Resources ${pageRes} >>`,
    streamObj(content1),
    { raw: Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${rgb.length} >>\nstream\n`, "latin1"), rgb, Buffer.from("\nendstream", "latin1")]) },
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    streamObj(content2),
  ];
  const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets = [0];
  objs.forEach((o, i) => {
    const body = typeof o === "string"
      ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, "latin1")
      : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), o.raw, Buffer.from("\nendobj\n", "latin1")]);
    offsets.push(parts.reduce((n, p) => n + p.length, 0));
    parts.push(body);
  });
  const xrefAt = parts.reduce((n, p) => n + p.length, 0);
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`, "latin1"));
  return Buffer.concat(parts);
}

describe("parseBufferWithImages: PDF text + illustrations", () => {
  it("returns the page text and the painted image as PNG", async () => {
    const { text, images } = await parseBufferWithImages("vol.pdf", buildPdfWithImage());
    assert.match(text, /Hello chapter one/);
    assert.match(text, /Hello chapter two/);
    assert.equal(images.length, 1, "one stored image even though it is painted twice");
    assert.equal(images[0].contentType, "image/png");
    assert.deepEqual([...images[0].data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(images[0].data.readUInt32BE(16), 64, "PNG width matches the PDF image");
    assert.equal(images[0].data.readUInt32BE(20), 64, "PNG height matches the PDF image");
    const occurrences = text.split(imageMarker(images[0].id)).length - 1;
    assert.equal(occurrences, 2, "a marker after each page's text");
    assert.equal(images[0].id, idOf(images[0].data), "id is the content hash");
  });
  it("is deterministic: same bytes = same id", async () => {
    const one = buildPdfWithImage();
    const a = await parseBufferWithImages("vol.pdf", one);
    const b = await parseBufferWithImages("vol.pdf", Buffer.from(one));
    assert.equal(a.images[0].id, b.images[0].id);
  });
});

describe("every upload format parses (with images where the format supports them)", () => {
  const tinyPngB64 = () => pngOf().toString("base64");
  const expectPng = (im) => {
    assert.equal(im.contentType, "image/png");
    assert.deepEqual([...im.data.subarray(0, 4)], [137, 80, 78, 71]);
  };
  it("txt and markdown come through as plain text", async () => {
    for (const [name, raw] of [["n.txt", "First.\n\nSecond."], ["n.md", "# Title\n\nBody *emph*.\n"]]) {
      const r = await parseBufferWithImages(name, Buffer.from(raw));
      assert.ok(r.text.includes("First") || r.text.includes("Body"), `${name}: prose kept`);
      assert.equal(r.images.length, 0, `${name}: no images possible`);
    }
  });
  it("rtf extracts pngblip and jpegblip pictures in order and skips broken ones", async () => {
    const hex = pngOf().toString("hex");
    const jpeg = Buffer.alloc(32, 7); jpeg[0] = 0xff; jpeg[1] = 0xd8;
    const raw = `{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0\\fs24 Before.\\par{\\pict\\pngblip\\picw64\\pich64 ${hex}}\\par Middle.\\par{\\pict\\jpegblip\\picw32\\pich32 ${jpeg.toString("hex")}}\\par{\\pict\\pngblip\\picw10 NOT-HEX!!}\\par After.\\par}`;
    const r = await parseBufferWithImages("n.rtf", Buffer.from(raw));
    assert.equal(r.images.length, 2, "both valid pictures extracted, broken one skipped");
    expectPng(r.images[0]);
    assert.equal(r.images[1].contentType, "image/jpeg");
    assert.deepEqual(paras(r.text), ["Before.", imageMarker(r.images[0].id), "Middle.", imageMarker(r.images[1].id), "After."]);
    // The text-only path must not leak hex dumps into the novel.
    const plain = await parseBuffer("n.rtf", Buffer.from(raw));
    assert.ok(!/[0-9a-f]{32,}/i.test(plain.replace(/\[\[img:[0-9a-f]{12}\]\]/g, "")), "no hex dump in text");
    assert.ok(plain.includes("Before.") && plain.includes("After."));
  });
  it("zip bundles parse every member, images included", async () => {
    const zip = new JSZip();
    zip.file("ch1.txt", "Chapter one text.");
    zip.file("ch2.html", `<p>Chapter two text.</p><img src="data:image/png;base64,${tinyPngB64()}">`);
    const r = await parseBufferWithImages("bundle.zip", await zip.generateAsync({ type: "nodebuffer" }));
    assert.ok(r.text.includes("Chapter one text.") && r.text.includes("Chapter two text."));
    assert.equal(r.images.length, 1);
    expectPng(r.images[0]);
    assert.ok(r.text.includes(imageMarker(r.images[0].id)));
  });
  it("office, ebook and pdf formats keep their illustrations in reading order", async () => {
    // docx
    const dzip = new JSZip();
    dzip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>A.</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId2"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:p><w:r><w:t>B.</w:t></w:r></w:p></w:body></w:document>`);
    dzip.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="x" Target="media/p.png"/></Relationships>`);
    dzip.file("word/media/p.png", pngOf());
    // odt
    const ozip = new JSZip();
    ozip.file("content.xml", `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"><office:body><office:text><text:p>C.</text:p><text:p><draw:frame><draw:image xlink:href="Pictures/p.png"/></draw:frame></text:p><text:p>D.</text:p></office:text></office:body></office:document-content>`);
    ozip.file("Pictures/p.png", pngOf());
    // epub
    const ezip = new JSZip();
    ezip.file("OEBPS/content.opf", `<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/><item id="p" href="p.png" media-type="image/png"/></manifest><spine><itemref idref="c"/></spine></package>`);
    ezip.file("OEBPS/c.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>E.</p><p><img src="p.png"/></p><p>F.</p></body></html>`);
    ezip.file("OEBPS/p.png", pngOf());
    // fb2
    const fb2 = `<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:xlink="http://www.w3.org/1999/xlink"><body><section><p>G.</p><image xlink:href="#p"/><p>H.</p></section></body><binary id="p" content-type="image/png">${tinyPngB64()}</binary></FictionBook>`;
    const cases = [
      ["n.docx", await dzip.generateAsync({ type: "nodebuffer" }), ["A.", "B."]],
      ["n.odt", await ozip.generateAsync({ type: "nodebuffer" }), ["C.", "D."]],
      ["n.epub", await ezip.generateAsync({ type: "nodebuffer" }), ["E.", "F."]],
      ["n.fb2", Buffer.from(fb2), ["G.", "H."]],
      ["n.pdf", buildPdfWithImage(), ["Hello chapter one", "Hello chapter two"]],
      ["n.html", Buffer.from(`<p>I.</p><img src="data:image/png;base64,${tinyPngB64()}"><p>J.</p>`), ["I.", "J."]],
    ];
    for (const [name, buf, prose] of cases) {
      const r = await parseBufferWithImages(name, buf);
      for (const p of prose) assert.ok(r.text.includes(p), `${name}: keeps "${p}"`);
      assert.ok(r.images.length >= 1, `${name}: illustration extracted`);
      expectPng(r.images[0]);
      assert.ok(r.text.includes(imageMarker(r.images[0].id)), `${name}: marker in reading order`);
    }
  });
});

describe("illustrations survive ingest → store → chapter", () => {
  it("claims images on ingest, serves bytes, and lists them on the chapter", async () => {
    const png = pngOf();
    const id = idOf(png);
    await saveStoryImages(store, [{ id, contentType: "image/png", data: png }]);
    const { workId, chapterId } = await ingestText(store, {
      title: `Img work ${randomBytes(2).toString("hex")}`,
      text: `Opening.\n\n${imageMarker(id)}\n\nClosing.`,
      sourceLang: "en",
    });
    const work = await getWork(store, workId);
    assert.ok(work.images?.some((m) => m.id === id), "image meta claimed on the work");
    const got = await store.loadBuffer(`images/${id}.png`);
    assert.deepEqual(got, png, "bytes round-trip through the store");
    const ch = await getChapter(store, { workId, chapterId });
    assert.deepEqual(ch.images, [{ id, url: `/api/images/${id}` }]);
    assert.ok(ch.original.includes(imageMarker(id)), "marker preserved in chapter text");
  });
  it("a translated chapter keeps the markers next to the translation", async () => {
    const png = pngOf();
    const id = idOf(png);
    await saveStoryImages(store, [{ id, contentType: "image/png", data: png }]);
    const { workId, chapterId } = await ingestText(store, {
      title: `Img work 2 ${randomBytes(2).toString("hex")}`,
      text: `Hello.\n\n${imageMarker(id)}\n\nBye.`,
      sourceLang: "en",
    });
    const stub = async (chunk) => ({ text: String(chunk).replaceAll("Hello.", "Hej.").replaceAll("Bye.", "Adj\u00f6."), provider: "stub", model: "stub" });
    await translateChapter(store, { workId, chapterId, target: "sv", translate: stub });
    const ch = await getChapter(store, { workId, chapterId, lang: "sv" });
    assert.deepEqual(ch.images, [{ id, url: `/api/images/${id}` }]);
    assert.ok(ch.translation.includes(imageMarker(id)), "marker survives translation");
    assert.match(ch.translation, /Hej/);
  });
});
