// Run with: node --test .github/scripts/update-homelab-stats.test.mjs
//
// Every fixture here is invented. Domains use the reserved .test TLD and
// addresses come from 192.0.2.0/24 (TEST-NET-1), so nothing in this public
// file describes the real homelab.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SOURCES,
  STAT_KEYS,
  SourceMissingError,
  SourceFormatError,
  ImplausibleValueError,
  MarkerError,
  StatsError,
  parseTopology,
  parseInventory,
  parseIngress,
  parseRemoteHosts,
  combineStats,
  validateStats,
  collectStats,
  lastDocsChange,
  formatDate,
  renderReadme,
  renderStatsJson,
} from "./update-homelab-stats.mjs";

const TOPOLOGY = JSON.stringify({
  hosts: [{ id: "host:alpha" }, { id: "host:beta" }, { id: "host:gamma" }],
  networks: [],
  services: [
    { id: "app", file: "apps.yml", healthcheck: true, memory: "512m", running: true },
    { id: "db", file: "apps.yml", healthcheck: true, memory: "1024m", running: true },
    { id: "proxy", file: "edge.yml", healthcheck: false, memory: null, running: true },
    { id: "cron", file: "jobs.yml", memory: "-", running: false },
  ],
});

const INVENTORY = `# Inventory drift

- Declared services: **4**
- Containers on the daemon: **5**

## Running but not declared

None.
`;

const INGRESS = `# Ingress

4 proxy hosts configured in nginx-proxy-manager.

| Domain | Upstream | Port | TLS forced | Enabled | Status |
| --- | --- | --- | --- | --- | --- |
| \`app.example.test\` | \`app\` | 80 | yes | yes | ok |
| \`old.example.test\` | \`gone\` | 80 | yes | yes | **DANGLING** |
| \`off.example.test\` | \`app\` | 80 | yes | no | ok |
| \`gpu.example.test\` | \`192.0.2.20\` | 3000 | yes | yes | external IP |

Dangling upstreams: **1**.

## Certificates

| Certificate | Expires |
| --- | --- |
| app.example.test | 2027-01-01 00:00:00 |
`;

const REMOTE = `# Remote hosts

## edge

\`ubuntu@192.0.2.10\`, 3 containers.

| Container | Image | State |
| --- | --- | --- |
| \`web\` | nginx:latest | running |

### Ingress on edge

3 proxy hosts. \`Upstream\` is resolved against this
host's own container names.

| Domain | Upstream | Port | Enabled | Status |
| --- | --- | --- | --- | --- |
| \`*.example.test\` | \`192.0.2.30\` | 80 | yes | external IP |
| \`status.example.test\` | \`web\` | 80 | yes | ok |
| \`stale.example.test\` | \`missing\` | 80 | yes | **DANGLING** |

## spare

\`admin@192.0.2.11\`, 2 containers.
`;

const STATS = {
  docs_updated: "2026-11-07",
  batcave_containers: 5,
  homelab_containers: 10,
  services_declared: 4,
  compose_files: 3,
  services_healthchecked: 2,
  services_mem_limited: 2,
  https_sites: 3,
  hosts: 3,
};

// Asserts `fn` throws an instance of `type` whose message leaks none of `secrets`.
function assertThrowsClean(fn, type, secrets = []) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof type, `expected ${type.name}, got ${err.name}: ${err.message}`);
    assert.ok(err instanceof StatsError);
    for (const secret of secrets) assert.ok(!err.message.includes(secret), `message leaks ${secret}`);
    return true;
  });
}

test("parseTopology counts services, compose files, health checks, memory limits and hosts", () => {
  assert.deepEqual(parseTopology(TOPOLOGY), {
    services_declared: 4,
    compose_files: 3,
    services_healthchecked: 2,
    services_mem_limited: 2,
    hosts: 3,
  });
});

test("parseTopology reports invalid JSON without quoting the input", () => {
  assertThrowsClean(() => parseTopology('{"services": ["PRIVATE-name-1"'), SourceFormatError, [
    "PRIVATE",
  ]);
});

test("parseTopology rejects JSON without services or hosts", () => {
  assertThrowsClean(() => parseTopology('{"hosts": []}'), SourceFormatError);
  assertThrowsClean(() => parseTopology('{"services": []}'), SourceFormatError);
  assertThrowsClean(() => parseTopology("null"), SourceFormatError);
});

test("parseInventory reads the daemon container count", () => {
  assert.deepEqual(parseInventory(INVENTORY), { batcave_containers: 5 });
});

test("parseInventory accepts CRLF line endings", () => {
  assert.deepEqual(parseInventory(INVENTORY.replace(/\n/g, "\r\n")), { batcave_containers: 5 });
});

test("parseInventory fails when the count line is missing", () => {
  assertThrowsClean(() => parseInventory("# Inventory drift\n\nNothing here.\n"), SourceFormatError);
});

test("parseIngress counts only enabled sites with a live upstream", () => {
  assert.deepEqual(parseIngress(INGRESS), { batcave_https_sites: 2 });
});

test("parseIngress fails when the table and its summary disagree, without naming domains", () => {
  const broken = INGRESS.replace("4 proxy hosts configured", "6 proxy hosts configured");
  assertThrowsClean(() => parseIngress(broken), SourceFormatError, ["example.test", "192.0.2"]);
});

test("parseIngress fails when the Status column is gone", () => {
  const broken = INGRESS.replace("| Enabled | Status |", "| Enabled | State |");
  assertThrowsClean(() => parseIngress(broken), SourceFormatError);
});

test("parseRemoteHosts sums containers and served sites, skipping wildcards", () => {
  assert.deepEqual(parseRemoteHosts(REMOTE), { remote_containers: 5, remote_https_sites: 1 });
});

test("parseRemoteHosts never puts a host address in an error", () => {
  const noCount = REMOTE.replace("`admin@192.0.2.11`, 2 containers.", "`admin@192.0.2.11`, unknown.");
  assertThrowsClean(() => parseRemoteHosts(noCount), SourceFormatError, ["192.0.2", "admin@"]);

  const mismatch = REMOTE.replace("3 proxy hosts.", "9 proxy hosts.");
  assertThrowsClean(() => parseRemoteHosts(mismatch), SourceFormatError, ["192.0.2", "example.test"]);
});

test("parseRemoteHosts fails when there are no host sections", () => {
  assertThrowsClean(() => parseRemoteHosts("# Remote hosts\n\nNone.\n"), SourceFormatError);
});

test("combineStats adds the remote hosts to batcave", () => {
  const stats = combineStats({
    topology: parseTopology(TOPOLOGY),
    inventory: parseInventory(INVENTORY),
    ingress: parseIngress(INGRESS),
    remote: parseRemoteHosts(REMOTE),
    docsUpdated: "2026-11-07",
  });
  assert.deepEqual(stats, STATS);
  assert.equal(validateStats(stats), stats);
});

test("validateStats refuses a zero where a parse must have gone wrong", () => {
  assertThrowsClean(() => validateStats({ ...STATS, batcave_containers: 0 }), ImplausibleValueError);
  assertThrowsClean(() => validateStats({ ...STATS, https_sites: 0 }), ImplausibleValueError);
});

test("validateStats refuses non-integers, impossible ratios and bad dates", () => {
  assertThrowsClean(() => validateStats({ ...STATS, hosts: 2.5 }), ImplausibleValueError);
  assertThrowsClean(() => validateStats({ ...STATS, hosts: undefined }), ImplausibleValueError);
  assertThrowsClean(
    () => validateStats({ ...STATS, services_healthchecked: 9 }),
    ImplausibleValueError,
  );
  assertThrowsClean(() => validateStats({ ...STATS, docs_updated: "Nov 7" }), ImplausibleValueError);
});

test("validateStats allows a zero for counts that can honestly be zero", () => {
  assert.doesNotThrow(() => validateStats({ ...STATS, services_healthchecked: 0 }));
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
  assert.deepEqual(Object.keys(JSON.parse(json)), ["docs_updated", ...STAT_KEYS]);
  const shuffled = Object.fromEntries(Object.entries(STATS).reverse());
  assert.equal(renderStatsJson(shuffled), json);
});

test("collectStats reads a docs checkout end to end", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "homelab-docs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = {
    [SOURCES.topology]: TOPOLOGY,
    [SOURCES.inventory]: INVENTORY,
    [SOURCES.ingress]: INGRESS,
    [SOURCES.remoteHosts]: REMOTE,
  };
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body);
  }
  assert.deepEqual(await collectStats(dir, "2026-11-07"), STATS);

  await rm(path.join(dir, SOURCES.ingress));
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
