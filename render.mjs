#!/usr/bin/env node
/**
 * Render every .illustrator file under the workspace with Automation
 * Illustrator's render.html in headless Chromium, writing SVG and/or PNG next
 * to each file:
 *
 *   flow.illustrator → flow.svg (Compare), flow.before.svg, flow.after.svg
 *
 * Each file renders in the orientation and theme its header records.
 * Exits non-zero when a file cannot be read, after rendering the rest.
 */
import { chown, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { chromium } from "playwright";

const FORMATS = { svg: ["svg"], png: ["png"], both: ["svg", "png"] };
const VIEWS = ["compare", "before", "after"];
const SKIP_DIRS = new Set([".git", "node_modules"]);
const EXTENSION = ".illustrator";

const format = (process.env.INPUT_FORMAT || "svg").trim().toLowerCase();
const views = (process.env.INPUT_VIEWS || VIEWS.join(","))
  .split(",")
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);
const appUrl = (process.env.ILLUSTRATOR_URL || "http://illustrator:80").replace(/\/+$/, "");
const workspace = process.env.GITHUB_WORKSPACE || "/workspace";
const scale = Number(process.env.INPUT_SCALE || "2");

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

if (!FORMATS[format]) fail(`Invalid format '${format}'. Must be one of: svg, png, both`);
const unknown = views.filter((v) => !VIEWS.includes(v));
if (unknown.length || views.length === 0) {
  fail(`Invalid views '${views.join(",")}'. Use any of: ${VIEWS.join(", ")}`);
}
if (!Number.isFinite(scale) || scale <= 0) fail(`Invalid scale '${process.env.INPUT_SCALE}'`);

async function* findFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* findFiles(join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(EXTENSION)) {
      yield join(dir, entry.name);
    }
  }
}

async function waitForApp() {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const res = await fetch(`${appUrl}/render.html`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail(`Automation Illustrator did not answer at ${appUrl}/render.html`);
}

/** Give outputs the source file's owner so the runner can commit them. */
async function writeLike(source, target, data) {
  await writeFile(target, data);
  const { uid, gid } = await stat(source);
  try {
    await chown(target, uid, gid);
  } catch {
    /* not root: the file already belongs to us */
  }
}

console.log("=== Automation Illustrator Render ===");
console.log(`Format:    ${format}`);
console.log(`Views:     ${views.join(", ")}`);
console.log(`App:       ${appUrl}`);
console.log(`Workspace: ${workspace}`);

const files = [];
for await (const file of findFiles(workspace)) files.push(file);
files.sort();
if (files.length === 0) {
  console.log("No .illustrator files found.");
  process.exit(0);
}
console.log(`\nFound ${files.length} file(s).`);

await waitForApp();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${appUrl}/render.html`);
await page.waitForFunction(() => document.documentElement.dataset.renderReady === "true", null, {
  timeout: 60_000,
});

let failures = 0;
for (const file of files) {
  const rel = relative(workspace, file);
  const text = await readFile(file, "utf8");
  const result = await page.evaluate(
    ([t, request]) => window.illustratorRender(t, request),
    [text, { views, formats: FORMATS[format], scale }],
  );
  if (!result.ok) {
    console.error(`  ✗ ${rel}: ${result.message}`);
    failures++;
    continue;
  }
  const stem = file.slice(0, -EXTENSION.length);
  const look = `${result.appearance.orientation}, ${result.appearance.theme.name}`;
  console.log(`  ${rel} (${look})`);
  for (const image of result.images) {
    const base = image.view === "compare" ? stem : `${stem}.${image.view}`;
    if (image.svg) {
      await writeLike(file, `${base}.svg`, image.svg);
      console.log(`    → ${relative(workspace, `${base}.svg`)}`);
    }
    if (image.png) {
      await writeLike(file, `${base}.png`, Buffer.from(image.png, "base64"));
      console.log(`    → ${relative(workspace, `${base}.png`)}`);
    }
  }
}

await browser.close();
if (failures) fail(`${failures} file(s) could not be rendered.`);
console.log("Done.");
