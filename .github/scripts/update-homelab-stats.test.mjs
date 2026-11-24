// Run with: node --test .github/scripts/update-homelab-stats.test.mjs
//
// Every fixture here is invented, so nothing in this public file describes the
// real homelab.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SOURCE,
  STAT_KEYS,
  STACKS_KEY,
  SourceMissingError,
  SourceFormatError,
  ImplausibleValueError,
  MarkerError,
  StatsError,
  parseStatsFile,
  validateStats,
  validateStacks,
  formatStacks,
  collectStats,
  lastDocsChange,
  formatDate,
  renderReadme,
  renderStatsJson,
} from "./update-homelab-stats.mjs";

const TOTALS = {
  batcave_containers: 5,
  homelab_containers: 10,
  services_declared: 4,
  compose_files: 3,
  services_healthchecked: 2,
  services_mem_limited: 2,
  https_sites: 3,
  hosts: 3,
  undeclared_containers: 0,
  missing_containers: 1,
  docker_networks: 2,
  stacks: [
    { name: "bravo", services: 2 },
    { name: "alpha", services: 1 },
    { name: "charlie-2", services: 1 },
  ],
};

const STATS = { docs_updated: "2026-11-07", ...TOTALS };

// Asserts `fn` throws an instance of `type` whose message leaks none of `secrets`.
function assertThrowsClean(fn, type, secrets = []) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof type, `expected ${type.name}, got ${err.name}: ${err.message}`);
    assert.ok(err instanceof StatsError);
    for (const secret of secrets) assert.ok(!err.message.includes(secret), `message leaks ${secret}`);
    return true;
  });
}

test("parseStatsFile returns exactly the contract keys", () => {
  assert.deepEqual(parseStatsFile(JSON.stringify(TOTALS)), TOTALS);
});

test("parseStatsFile ignores keys the contract does not name yet", () => {
  const extra = JSON.stringify({ ...TOTALS, timers: 7, networks: 5 });
  assert.deepEqual(Object.keys(parseStatsFile(extra)), [...STAT_KEYS, STACKS_KEY]);
});

test("parseStatsFile requires the stack list", () => {
  const { stacks, ...noStacks } = TOTALS;
  assert.throws(() => parseStatsFile(JSON.stringify(noStacks)), /has no stacks/);
});

test("parseStatsFile names every missing key", () => {
  const { https_sites, hosts, ...partial } = TOTALS;
  assertThrowsClean(() => parseStatsFile(JSON.stringify(partial)), SourceFormatError);
  assert.throws(() => parseStatsFile(JSON.stringify(partial)), /https_sites, hosts/);
});

test("parseStatsFile reports invalid JSON without quoting the input", () => {
  assertThrowsClean(() => parseStatsFile('{"hosts": PRIVATE-name-1'), SourceFormatError, [
    "PRIVATE",
  ]);
});

test("parseStatsFile rejects JSON that is not an object", () => {
  for (const text of ["null", "[1, 2]", "42", '"text"']) {
    assertThrowsClean(() => parseStatsFile(text), SourceFormatError);
  }
});

test("validateStats accepts the fixture", () => {
  assert.equal(validateStats({ ...STATS }).hosts, 3);
});

test("validateStats refuses a zero where the generator must have gone wrong", () => {
  assertThrowsClean(() => validateStats({ ...STATS, batcave_containers: 0 }), ImplausibleValueError);
  assertThrowsClean(() => validateStats({ ...STATS, https_sites: 0 }), ImplausibleValueError);
});

test("validateStats refuses non-integers, impossible ratios and bad dates", () => {
  assertThrowsClean(() => validateStats({ ...STATS, hosts: 2.5 }), ImplausibleValueError);
  assertThrowsClean(() => validateStats({ ...STATS, hosts: "4" }), ImplausibleValueError);
  assertThrowsClean(() => validateStats({ ...STATS, hosts: null }), ImplausibleValueError);
  assertThrowsClean(
    () => validateStats({ ...STATS, services_healthchecked: 9 }),
    ImplausibleValueError,
  );
  assertThrowsClean(() => validateStats({ ...STATS, homelab_containers: 4 }), ImplausibleValueError);
  assertThrowsClean(() => validateStats({ ...STATS, docs_updated: "Nov 7" }), ImplausibleValueError);
});

test("validateStats allows a zero for counts that can honestly be zero", () => {
  assert.doesNotThrow(() => validateStats({ ...STATS, services_healthchecked: 0 }));
  assert.doesNotThrow(() => validateStats({ ...STATS, missing_containers: 0 }));
});

test("validateStats refuses zero Docker networks", () => {
  assertThrowsClean(() => validateStats({ ...STATS, docker_networks: 0 }), ImplausibleValueError);
});

test("validateStacks sorts largest first, ties by name, and drops extra fields", () => {
  const shuffled = [
    { name: "charlie-2", services: 1, path: "/private/charlie-2.yml" },
    { name: "alpha", services: 1 },
    { name: "bravo", services: 2 },
  ];
  assert.deepEqual(validateStacks(shuffled, STATS), STATS.stacks);
});

test("validateStacks must agree with compose_files and services_declared", () => {
  const short = STATS.stacks.slice(0, 2);
  assertThrowsClean(() => validateStacks(short, STATS), ImplausibleValueError);
  const heavy = [...STATS.stacks.slice(0, 2), { name: "charlie-2", services: 3 }];
  assertThrowsClean(() => validateStacks(heavy, STATS), ImplausibleValueError);
  const twice = [...STATS.stacks.slice(0, 2), { name: "alpha", services: 1 }];
  assertThrowsClean(() => validateStacks(twice, STATS), ImplausibleValueError);
});

test("validateStacks refuses bad entries without quoting them", () => {
  const withName = (name) => [...STATS.stacks.slice(0, 2), { name, services: 1 }];
  for (const name of ["PRIVATE-Stack", "a<!--b", "has space", "`tick`", "", 7]) {
    assertThrowsClean(() => validateStacks(withName(name), STATS), ImplausibleValueError, [
      "PRIVATE",
      "<!--",
    ]);
  }
  const zero = [...STATS.stacks.slice(0, 2), { name: "charlie-2", services: 0 }];
  assertThrowsClean(() => validateStacks(zero, STATS), ImplausibleValueError);
  for (const stacks of [[], {}, null, "media 25"]) {
    assertThrowsClean(() => validateStacks(stacks, STATS), ImplausibleValueError);
  }
});

test("formatStacks renders one README line", () => {
  assert.equal(formatStacks(STATS.stacks), "bravo 2 · alpha 1 · charlie-2 1");
});

test("renderReadme fills a stacks marker and stays idempotent", () => {
  const readme = "Stacks: <!--hl:stacks-->old 1<!--/hl-->\n";
  const once = renderReadme(readme, STATS);
  assert.equal(once, "Stacks: <!--hl:stacks-->bravo 2 · alpha 1 · charlie-2 1<!--/hl-->\n");
  assert.equal(renderReadme(once, STATS), once);
});

test("formatDate renders the README date style in UTC", () => {
  assert.equal(formatDate("2026-11-07"), "Nov 7, 2026");
  assert.equal(formatDate("2026-01-31"), "Jan 31, 2026");
});

test("renderReadme replaces marked values and keeps backticks", () => {
  const readme =
    "Batcave, my <!--hl:batcave_containers-->56<!--/hl-->-container server.\n" +
    "| Containers | <!--hl:homelab_containers-->`80`<!--/hl--> |\n" +
    "Last change <!--hl:docs_updated-->Oct 1, 2026<!--/hl-->.\n";
  assert.equal(
    renderReadme(readme, STATS),
    "Batcave, my <!--hl:batcave_containers-->5<!--/hl-->-container server.\n" +
      "| Containers | <!--hl:homelab_containers-->`10`<!--/hl--> |\n" +
      "Last change <!--hl:docs_updated-->Nov 7, 2026<!--/hl-->.\n",
  );
});

test("renderReadme is idempotent", () => {
  const readme = "A <!--hl:hosts-->`1`<!--/hl--> and <!--hl:docs_updated-->x<!--/hl-->\n";
  const once = renderReadme(readme, STATS);
  assert.equal(renderReadme(once, STATS), once);
});

test("renderReadme preserves CRLF line endings", () => {
  const readme = "a <!--hl:hosts-->1<!--/hl-->\r\nb\r\n";
  assert.equal(renderReadme(readme, STATS), "a <!--hl:hosts-->3<!--/hl-->\r\nb\r\n");
});

test("renderReadme rejects an unknown stat", () => {
  assertThrowsClean(() => renderReadme("<!--hl:uptime-->99<!--/hl-->", STATS), MarkerError);
});

test("renderReadme rejects malformed markers instead of skipping them", () => {
  assertThrowsClean(() => renderReadme("<!--hl:hosts-->3 and no close", STATS), MarkerError);
  assertThrowsClean(() => renderReadme("<!--hl:Hosts-->3<!--/hl-->", STATS), MarkerError);
});

test("renderReadme fails when there are no markers at all", () => {
  assertThrowsClean(() => renderReadme("# Profile\n", STATS), MarkerError);
});

test("renderStatsJson writes every key in a fixed order with a trailing newline", () => {
  const json = renderStatsJson({ ...STATS });
  assert.ok(json.endsWith("}\n"));
  assert.deepEqual(Object.keys(JSON.parse(json)), ["docs_updated", ...STAT_KEYS, STACKS_KEY]);
  assert.deepEqual(JSON.parse(json).stacks, STATS.stacks);
  const shuffled = Object.fromEntries(Object.entries(STATS).reverse());
  assert.equal(renderStatsJson(shuffled), json);
});

test("collectStats reads the totals file from a docs checkout", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "homelab-docs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.dirname(path.join(dir, SOURCE)), { recursive: true });
  await writeFile(path.join(dir, SOURCE), JSON.stringify(TOTALS));
  assert.deepEqual(await collectStats(dir, "2026-11-07"), STATS);

  await writeFile(path.join(dir, SOURCE), JSON.stringify({ ...TOTALS, hosts: 0 }));
  await assert.rejects(collectStats(dir, "2026-11-07"), ImplausibleValueError);

  await rm(path.join(dir, SOURCE));
  await assert.rejects(collectStats(dir, "2026-11-07"), SourceMissingError);
});

test("lastDocsChange honours HOMELAB_DOCS_UPDATED", () => {
  const env = { HOMELAB_DOCS_UPDATED: "2026-11-07T06:01:35Z" };
  assert.equal(lastDocsChange("/nonexistent", env), "2026-11-07");
  assertThrowsClean(
    () => lastDocsChange("/nonexistent", { HOMELAB_DOCS_UPDATED: "soon" }),
    ImplausibleValueError,
  );
});

test("lastDocsChange explains a missing history", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "no-git-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assertThrowsClean(() => lastDocsChange(dir, {}), SourceMissingError);
});
