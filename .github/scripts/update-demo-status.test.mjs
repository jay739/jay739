// Run with: node --test .github/scripts/update-demo-status.test.mjs
//
// Every fixture is invented.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseStatusPage, parseHeartbeats, CardError } from "./generate-batcave-card.mjs";
import { START, END, MarkerError, demoLink, escapeMarkdown, renderLine, replaceBlock } from "./update-demo-status.mjs";

const NOW = new Date("2026-01-02T03:10:00Z");
const page = (names) => ({ publicGroupList: [{ name: "Demos", monitorList: names.map((name, i) => ({ id: i + 1, name })) }] });
const beats = (statuses, time = "2026-01-02 03:05:00.000") => ({
  heartbeatList: Object.fromEntries(statuses.map((s, i) => [i + 1, [{ status: s, time, msg: "", ping: 1 }]])),
  uptimeList: Object.fromEntries(statuses.map((_, i) => [`${i + 1}_24`, 1])),
});

test("renderLine shows each demo with a dot, a link and its state in words", () => {
  const groups = parseHeartbeats(beats([1, 0, 3]), parseStatusPage(page(["PDF to Podcast", "RAG Chatbot", "Image Generator"])), NOW);
  assert.equal(
    renderLine(groups),
    "**Try the live demos:** 🟢 [PDF to Podcast](https://jay739.dev/ai-tools?tool=podcast-generator) up · 🔴 [RAG Chatbot](https://jay739.dev/ai-tools?tool=chatbot) down right now · 🟡 [Image Generator](https://jay739.dev/ai-tools?tool=image-generator) in maintenance",
  );
});

test("a demo with no recent check says so instead of looking up", () => {
  const groups = parseHeartbeats(beats([1], "2026-01-01 20:00:00.000"), parseStatusPage(page(["PDF to Podcast"])), NOW);
  assert.ok(renderLine(groups).includes("⚪ [PDF to Podcast](https://jay739.dev/ai-tools?tool=podcast-generator) not checked"));
});

test("a demo with no deep link of its own links to the AI Tools page", () => {
  assert.equal(demoLink("Voice Cloner"), "https://jay739.dev/ai-tools");
  assert.equal(demoLink("constructor"), "https://jay739.dev/ai-tools");
  const groups = parseHeartbeats(beats([1]), parseStatusPage(page(["Voice Cloner"])), NOW);
  assert.ok(renderLine(groups).includes("🟢 [Voice Cloner](https://jay739.dev/ai-tools) up"));
});

test("escapeMarkdown keeps monitor names from breaking the link", () => {
  assert.equal(escapeMarkdown("a [b](c) *d*"), "a \\[b\\]\\(c\\) \\*d\\*");
});

test("replaceBlock writes the line on its own line and is idempotent", () => {
  const once = replaceBlock(`x\n${START}\n${END}\ny`, "line");
  assert.equal(once, `x\n${START}\nline\n${END}\ny`);
  assert.equal(replaceBlock(once, "line"), once);
  assert.throws(() => replaceBlock("none", "line"), (e) => e instanceof MarkerError && e instanceof CardError);
});
