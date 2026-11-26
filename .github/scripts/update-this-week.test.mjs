// Run with: node --test .github/scripts/update-this-week.test.mjs
//
// Every fixture is invented.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  START,
  END,
  MarkerError,
  ThisWeekError,
  sinceDate,
  searchQuery,
  summarize,
  renderLine,
  replaceBlock,
} from "./update-this-week.mjs";

const pr = (nameWithOwner) => ({ repository: { nameWithOwner, owner: { login: nameWithOwner.split("/")[0] } } });

test("sinceDate starts the window exactly seven days back, to the second", () => {
  assert.equal(sinceDate(new Date("2026-03-10T01:30:45.678Z")), "2026-03-03T01:30:45Z");
  assert.equal(
    searchQuery("someone", "2026-03-03T01:30:45Z"),
    "is:pr is:merged is:public author:someone merged:>=2026-03-03T01:30:45Z",
  );
});

test("summarize counts per repository, most first, ties by name, short names for my own", () => {
  const nodes = [pr("me/beta"), pr("me/alpha"), pr("me/beta"), pr("other/lib"), pr("me/alpha"), {}];
  const s = summarize(nodes, "me");
  assert.equal(s.total, 5);
  assert.deepEqual(
    s.repos.map((r) => [r.label, r.count]),
    [["alpha", 2], ["beta", 2], ["other/lib", 1]],
  );
  assert.equal(s.repos[2].url, "https://github.com/other/lib");
});

test("renderLine names the top three and says 'most in' only when there are more", () => {
  const four = summarize([pr("me/a"), pr("me/a"), pr("me/b"), pr("me/c"), pr("me/d")], "me");
  assert.equal(
    renderLine(four),
    "**This week:** 5 pull requests merged across 4 repositories, most in [a](https://github.com/me/a) (2), [b](https://github.com/me/b) (1) and [c](https://github.com/me/c) (1).",
  );
  const two = summarize([pr("me/a"), pr("me/b")], "me");
  assert.ok(renderLine(two).includes("across 2 repositories, in [a]"));
});

test("renderLine handles one repository, one pull request and a quiet week", () => {
  assert.equal(
    renderLine(summarize([pr("me/a")], "me")),
    "**This week:** 1 pull request merged, all in [a](https://github.com/me/a) (1).",
  );
  assert.equal(renderLine({ total: 0, repos: [] }), "**This week:** a quiet one, no pull requests merged in the last 7 days.");
});

test("replaceBlock puts the line on its own line between the markers, idempotently", () => {
  const readme = `top\n${START}\nold\n${END}\nbottom\n`;
  const once = replaceBlock(readme, "new");
  assert.equal(once, `top\n${START}\nnew\n${END}\nbottom\n`);
  assert.equal(replaceBlock(once, "new"), once);
  // A block written the old single-line way is repaired on the next run.
  assert.equal(replaceBlock(`${START}old${END}`, "new"), `${START}\nnew\n${END}`);
});

test("replaceBlock refuses a README without the block", () => {
  assert.throws(
    () => replaceBlock("no markers here", "x"),
    (err) => err instanceof MarkerError && err instanceof ThisWeekError,
  );
});
