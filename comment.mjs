// Creates or updates one pull request comment listing the findings that the
// pull request adds (diagnostics whose fingerprint is not on the base
// commit). Exports `render` for tests; runs only when executed directly.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MARKER = "<!-- midwrite-action -->";
const RANK = { error: 3, warning: 2, info: 1 };
const MAX_LISTED = 25;
const WHAT_IT_MEANS = "https://github.com/astra-void/midwrite#what-a-warning-means";

export function newFindings(report) {
  const hasBaseline = Boolean(report.summary?.baseline);
  return report.diagnostics.filter((d) => !hasBaseline || d.baseline === "new");
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function render(report, { repo, sha, server = "https://github.com", workdir = "", baseStatus = "ok", minSeverity = "warning" }) {
  const fresh = newFindings(report);
  const threshold = RANK[minSeverity] ?? RANK.warning;
  const listed = fresh
    .filter((d) => (RANK[d.severity] ?? 0) >= threshold)
    .sort((a, b) => (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0));
  const quieter = fresh.length - listed.length;
  const prefix = workdir && workdir !== "." ? `${workdir.replace(/^\.\//, "").replace(/\/$/, "")}/` : "";
  const link = (loc) => {
    const file = `${prefix}${loc.file}`;
    return repo && sha
      ? `[${file}:${loc.line}](${server}/${repo}/blob/${sha}/${encodeURI(file)}#L${loc.line})`
      : `${file}:${loc.line}`;
  };

  const lines = [MARKER];
  if (listed.length === 0) {
    lines.push("### Midwrite: no new findings at or above `" + minSeverity + "`");
  } else {
    lines.push(`### Midwrite: ${plural(listed.length, "new potential failure path")} in this pull request`);
  }
  lines.push("");
  if (baseStatus === "failed" || baseStatus === "none") {
    lines.push("> The base commit could not be analyzed, so every finding is treated as new.", "");
  } else if (baseStatus === "partial") {
    lines.push("> Some base files could not be analyzed; a few findings listed as new may already exist.", "");
  }

  for (const d of listed.slice(0, MAX_LISTED)) {
    const icon = d.severity === "error" ? "🛑" : d.severity === "warning" ? "⚠️" : "ℹ️";
    lines.push(`${icon} **${d.code}** ${d.title} — ${link(d.location)} in \`${d.function}\` (confidence: ${d.confidence})`);
    lines.push("");
    lines.push(`> ${d.message}`);
    lines.push("");
    const details = [];
    if (d.failureSequence?.length) details.push(...d.failureSequence.map((s) => `   ${s}`), "");
    if (d.mitigation) details.push(`**Mitigation:** ${d.mitigation}`);
    if (details.length) {
      lines.push("<details><summary>Failure sequence and mitigation</summary>", "", ...details, "", "</details>", "");
    }
  }
  if (listed.length > MAX_LISTED) {
    lines.push(`…and ${listed.length - MAX_LISTED} more; see the code scanning results or the job log.`, "");
  }

  const counts = [];
  if (quieter > 0) counts.push(`${plural(quieter, "new lower-severity finding")} not listed`);
  const b = report.summary?.baseline;
  if (b) counts.push(`${b.existing} already on the base branch`, `${b.resolved} resolved by this pull request`);
  if (counts.length) lines.push(`<sub>${counts.join(" · ")}</sub>`, "");

  lines.push(
    `<sub>Static analysis by [Midwrite](https://github.com/astra-void/midwrite) ${report.tool?.version ?? ""}. ` +
      `Each finding is a potential partial-failure window, not a confirmed bug; many are intentional (retries, best-effort sends). ` +
      `[What a warning means](${WHAT_IT_MEANS}).</sub>`,
  );
  return { body: lines.join("\n"), listed: listed.length };
}

async function api(path, init = {}) {
  const base = process.env.GITHUB_API_URL || "https://api.github.com";
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = process.env.PR_NUMBER;
  const report = JSON.parse(readFileSync(process.env.REPORT, "utf8"));
  const { body, listed } = render(report, {
    repo,
    sha: process.env.HEAD_SHA,
    server: process.env.GITHUB_SERVER_URL,
    workdir: process.env.WORKDIR,
    baseStatus: process.env.BASE_STATUS,
    minSeverity: process.env.COMMENT_SEVERITY || "warning",
  });

  let existing = null;
  for (let page = 1; !existing; page++) {
    const batch = await api(`/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    existing = batch.find((c) => c.body?.includes(MARKER)) ?? null;
    if (batch.length < 100) break;
  }
  if (existing) {
    await api(`/repos/${repo}/issues/comments/${existing.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
    console.log(`Updated comment ${existing.html_url}`);
  } else if (listed > 0) {
    const created = await api(`/repos/${repo}/issues/${pr}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    console.log(`Created comment ${created.html_url}`);
  } else {
    console.log("No new findings and no earlier comment: nothing posted.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    // A pull request from a fork gets a read-only token: report, don't fail.
    console.log(`::warning::Midwrite could not comment on the pull request: ${error.message}`);
  });
}
