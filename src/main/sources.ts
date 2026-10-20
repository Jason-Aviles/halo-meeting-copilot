import { app } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_JIRA_JQL, type SourceInfo } from "../shared/types";
import { getSecret, getSettings } from "./settings";

/** Most text kept from one source; a large repo is cut here, docs first. */
const MAX_SOURCE_CHARS = 200_000;
/** Files bigger than this are skipped (generated code, data dumps, lockfiles). */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FOLDER_FILES = 400;
const MAX_GITHUB_FILES = 60;
const MAX_JIRA_ISSUES = 50;

/** Text and code files worth reading. Anything else is skipped. */
const TEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc", ".org",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".csv", ".tsv", ".xml", ".html", ".css", ".scss",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".lua", ".luau", ".sql", ".sh", ".ps1", ".vue", ".svelte",
]);
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "release", "target", "vendor", ".next",
  "__pycache__", ".venv", "venv", "coverage", ".idea", ".vscode",
]);
const SKIP_FILES = /(^|[\\/])(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|.*\.min\.(js|css))$/i;
/**
 * Hidden folders are skipped, except these: they hold AI agent definitions and
 * project instructions (.claude/agents/frontend.md, .github/copilot-instructions.md).
 */
const AGENT_DIRS = new Set([".claude", ".github", ".cursor", ".windsurf", ".agents"]);
/** Instruction files with no extension that are worth reading. */
const AGENT_FILES = new Set([".cursorrules", ".windsurfrules", ".clinerules"]);
/** Files that describe how the project works; read right after the README. */
const KEY_DOCS = /^(agents|claude|gemini|contributing|architecture|copilot-instructions)\.md$/;

const dir = () => path.join(app.getPath("userData"), "sources");
const indexFile = () => path.join(dir(), "index.json");
const textFile = (id: string) => path.join(dir(), `${id}.txt`);

let cache: SourceInfo[] | undefined;

function load(): SourceInfo[] {
  if (!cache) {
    try {
      cache = JSON.parse(fs.readFileSync(indexFile(), "utf8")) as SourceInfo[];
    } catch {
      cache = [];
    }
  }
  return cache;
}

function save(): SourceInfo[] {
  enabledText = undefined;
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(load(), null, 2));
  return listSources();
}

export function listSources(): SourceInfo[] {
  return load().map((s) => ({ ...s }));
}

/**
 * Docs come first: READMEs, then other prose, then code, shallow before deep.
 * When a source is cut to size, the most useful files survive.
 */
function rank(file: string): number {
  const base = path.basename(file).toLowerCase();
  const depth = file.split(/[\\/]/).length;
  const ext = path.extname(base);
  const agentFile = /[\\/]agents[\\/]/.test(file.toLowerCase()) && ext === ".md";
  const tier = base.startsWith("readme")
    ? 0
    : KEY_DOCS.test(base) || AGENT_FILES.has(base) || agentFile
      ? 1
      : [".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"].includes(ext)
        ? 2
        : 3;
  return tier * 1000 + depth;
}

/** Joins files under headers until the budget runs out. */
function combine(files: Array<{ name: string; text: string }>): { text: string; files: number } {
  let text = "";
  let count = 0;
  for (const f of files) {
    const body = f.text.replace(/\r\n/g, "\n").trim();
    if (!body || body.includes("\u0000")) continue;
    const part = `--- ${f.name} ---\n${body}\n\n`;
    if (text.length + part.length > MAX_SOURCE_CHARS) {
      // Fit what's left of the budget, but don't bother with a tiny tail.
      const room = MAX_SOURCE_CHARS - text.length;
      if (room > 2_000) {
        text += part.slice(0, room) + "\n[cut to fit]\n";
        count++;
      }
      break;
    }
    text += part;
    count++;
  }
  return { text: text.trim(), files: count };
}

function isTextFile(file: string): boolean {
  if (AGENT_FILES.has(path.basename(file).toLowerCase())) return true;
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()) && !SKIP_FILES.test(file);
}

function skipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || (name.startsWith(".") && !AGENT_DIRS.has(name));
}

function readFolder(root: string): { text: string; files: number } {
  const found: string[] = [];
  const walk = (d: string) => {
    if (found.length >= MAX_FOLDER_FILES * 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!skipDir(e.name)) walk(full);
      } else if (e.isFile() && isTextFile(full)) {
        found.push(path.relative(root, full));
      }
    }
  };
  walk(root);

  const files: Array<{ name: string; text: string }> = [];
  let total = 0;
  for (const rel of found.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, MAX_FOLDER_FILES)) {
    // Stop reading once the budget is full; the rest would be cut anyway.
    if (total > MAX_SOURCE_CHARS) break;
    const full = path.join(root, rel);
    try {
      if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
      const text = fs.readFileSync(full, "utf8");
      files.push({ name: rel.replace(/\\/g, "/"), text });
      total += text.length;
    } catch {
      // Unreadable files are skipped.
    }
  }
  return combine(files);
}

function readFile(file: string): { text: string; files: number } {
  if (fs.statSync(file).size > MAX_FILE_BYTES * 4) {
    throw new Error(`${path.basename(file)} is too large to use as a reference.`);
  }
  const text = fs.readFileSync(file, "utf8");
  // PDFs, Word files and images aren't plain text.
  if (text.includes("\u0000")) {
    throw new Error(`${path.basename(file)} isn't a text file. Save it as .txt or .md first.`);
  }
  return combine([{ name: path.basename(file), text }]);
}

/** Accepts github.com/owner/repo, optionally with /tree/<branch>/<subfolder>. */
export function parseGithubUrl(input: string): { owner: string; repo: string; ref?: string; sub: string } {
  const trimmed = input.trim().replace(/^git@github\.com:/, "https://github.com/");
  const url = new URL(/^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new Error("Enter a github.com repository link, like github.com/owner/repo");
  }
  const [owner, rawRepo, kind, ref, ...rest] = url.pathname.split("/").filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/, "");
  if (!owner || !repo) throw new Error("Enter a github.com repository link, like github.com/owner/repo");
  return { owner, repo, ...(kind === "tree" && ref ? { ref } : {}), sub: kind === "tree" ? rest.join("/") : "" };
}

/** A token is optional: it unlocks private repos and a much higher rate limit. */
function githubAuth(): Record<string, string> {
  const token = getSecret("githubToken");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function github(pathname: string): Promise<Response> {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Halo", ...githubAuth() },
    signal: AbortSignal.timeout(20_000),
  });
  const hasToken = Boolean(getSecret("githubToken"));
  if (res.status === 401) throw new Error("GitHub rejected your token. Check it hasn't expired.");
  if (res.status === 404) {
    throw new Error(
      hasToken
        ? "GitHub couldn't find that repository, or your token can't read it."
        : "GitHub couldn't find that repository. For a private repo, add a GitHub token.",
    );
  }
  if (res.status === 403 || res.status === 429) {
    throw new Error(
      hasToken
        ? "GitHub refused the request. Your token may lack access, or the rate limit was hit."
        : "GitHub's rate limit for requests without a token was hit. Add a token or try again in an hour.",
    );
  }
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);
  return res;
}

/** Fetches a public repo's docs: its README and other prose first, then code, within the budget. */
async function readGithub(location: string): Promise<{ text: string; files: number; title: string }> {
  const { owner, repo, ref: givenRef, sub } = parseGithubUrl(location);
  const meta = (await (await github(`/repos/${owner}/${repo}`)).json()) as { default_branch: string; full_name: string };
  const ref = givenRef ?? meta.default_branch;
  const tree = (await (await github(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`)).json()) as {
    tree: Array<{ path: string; type: string; size?: number }>;
  };

  const prefix = sub ? `${sub.replace(/\/+$/, "")}/` : "";
  const picks = tree.tree
    .filter((t) => t.type === "blob" && t.path.startsWith(prefix) && (t.size ?? 0) <= MAX_FILE_BYTES)
    .map((t) => t.path)
    .filter((p) => isTextFile(p) && !p.split("/").slice(0, -1).some(skipDir))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, MAX_GITHUB_FILES);

  // raw.githubusercontent.com doesn't count against the API rate limit.
  const files = await Promise.all(
    picks.map(async (p) => {
      // Branch names can contain slashes, so encode each segment rather than the whole ref.
      const segments = (s: string) => s.split("/").map(encodeURIComponent).join("/");
      const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${segments(ref)}/${segments(p)}`;
      try {
        const res = await fetch(raw, { headers: githubAuth(), signal: AbortSignal.timeout(20_000) });
        return res.ok ? [{ name: p, text: await res.text() }] : [];
      } catch {
        return [];
      }
    }),
  );
  return { ...combine(files.flat()), title: meta.full_name + (sub ? `/${sub}` : "") };
}

/** Atlassian Document Format: the rich text in Jira descriptions and comments. */
interface AdfNode {
  type?: string;
  text?: string;
  attrs?: { text?: string; url?: string };
  content?: AdfNode[];
}

const ADF_BLOCKS = new Set(["paragraph", "heading", "blockquote", "panel", "tableRow", "rule"]);

function adfText(node: AdfNode | null | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention" || node.type === "emoji") return node.attrs?.text ?? "";
  if (node.type === "inlineCard") return node.attrs?.url ?? "";
  const inner = (node.content ?? []).map(adfText).join("");
  if (node.type === "listItem") return `- ${inner.trim()}\n`;
  if (node.type === "codeBlock") return `\n${inner}\n\n`;
  return ADF_BLOCKS.has(node.type ?? "") ? `${inner}\n` : inner;
}

interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string };
    priority?: { name?: string };
    issuetype?: { name?: string };
    parent?: { key?: string; fields?: { summary?: string } };
    description?: AdfNode | null;
    comment?: { comments?: Array<{ author?: { displayName?: string }; body?: AdfNode }> };
  };
}

/**
 * Turns what the user pasted into JQL: issue links or keys ("PAY-412"), a
 * saved-filter link (?filter=123), a search link (?jql=…), or JQL as-is.
 * Linked issues bring their sub-tasks and epic children along.
 */
export function jiraQuery(input: string): string {
  const text = input.trim();
  if (!text) return DEFAULT_JIRA_JQL;

  for (const url of text.match(/https?:\/\/\S+/g) ?? []) {
    try {
      const params = new URL(url).searchParams;
      const jql = params.get("jql");
      if (jql) return jql;
      const filter = params.get("filter");
      if (filter && /^\d+$/.test(filter)) return `filter = ${filter}`;
    } catch {
      // Not a URL after all; fall through.
    }
  }

  const looksLikeJql = /[=~<>]|\b(and|or|in|is|not|order by)\b/i.test(text.replace(/https?:\/\/\S+/g, ""));
  const keys = [...new Set(text.match(/\b[A-Z][A-Z0-9_]+-\d+\b/g) ?? [])];
  if (keys.length && !looksLikeJql) {
    const list = keys.join(", ");
    return `key in (${list}) OR parent in (${list}) ORDER BY updated DESC`;
  }
  return text;
}

function jiraTitle(jql: string): string {
  if (jql.trim() === DEFAULT_JIRA_JQL) return "My open Jira tickets";
  const keys = /^key in \(([^)]*)\)/.exec(jql);
  if (keys) return `Jira: ${keys[1]}`;
  const filter = /^filter = (\d+)$/.exec(jql);
  if (filter) return `Jira filter ${filter[1]}`;
  return `Jira: ${jql.trim().slice(0, 60)}`;
}

/** Fetches the issues a JQL query matches, with their descriptions and latest comments. */
async function readJira(jql: string): Promise<{ text: string; files: number; title: string }> {
  const { jiraSite: site, jiraEmail: email } = getSettings();
  const token = getSecret("jiraToken");
  if (!site || !email || !token) throw new Error("Add your Jira site, email and API token first.");

  const params = new URLSearchParams({
    jql,
    maxResults: String(MAX_JIRA_ISSUES),
    fields: "summary,status,priority,issuetype,parent,description,comment",
  });
  const res = await fetch(`https://${site}/rest/api/3/search/jql?${params}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Jira rejected your email or API token.");
  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as { errorMessages?: string[] };
    throw new Error(`Jira didn't accept that query: ${body.errorMessages?.join(" ") || "check the JQL"}`);
  }
  if (!res.ok) throw new Error(`Jira error ${res.status}`);
  const { issues = [] } = (await res.json()) as { issues?: JiraIssue[] };

  const files = issues.map((issue) => {
    const f = issue.fields;
    const facts = [f.issuetype?.name, f.status?.name, f.priority?.name && `${f.priority.name} priority`]
      .filter(Boolean)
      .join(" · ");
    const parts = [`${issue.key}: ${f.summary ?? ""}`, facts];
    if (f.parent?.key) parts.push(`Parent: ${f.parent.key} ${f.parent.fields?.summary ?? ""}`);
    const description = adfText(f.description).trim();
    if (description) parts.push(`\n${description}`);
    // The latest few comments usually say where the work stands.
    for (const c of (f.comment?.comments ?? []).slice(-3)) {
      parts.push(`\nComment from ${c.author?.displayName ?? "someone"}: ${adfText(c.body).trim()}`);
    }
    return { name: `${issue.key} (https://${site}/browse/${issue.key})`, text: parts.join("\n") };
  });

  return { ...combine(files), title: jiraTitle(jql) };
}

async function capture(kind: SourceInfo["kind"], location: string): Promise<{ text: string; files: number; title: string }> {
  if (kind === "github") return readGithub(location);
  if (kind === "jira") return readJira(location);
  const title = path.basename(location) || location;
  return { ...(kind === "folder" ? readFolder(location) : readFile(location)), title };
}

export async function addSource(kind: SourceInfo["kind"], location: string): Promise<SourceInfo[]> {
  const sources = load();
  const existing = sources.find((s) => s.kind === kind && s.location === location);
  if (existing) return refreshSource(existing.id);

  const got = await capture(kind, location);
  // A Jira query with no matches today is still worth keeping to refresh later.
  if (!got.text && kind !== "jira") throw new Error(`No readable text found in ${got.title}.`);
  const id = randomUUID();
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(textFile(id), got.text);
  sources.push({
    id,
    kind,
    location,
    title: got.title,
    enabled: true,
    chars: got.text.length,
    files: got.files,
    refreshedAt: Date.now(),
  });
  return save();
}

export async function refreshSource(id: string): Promise<SourceInfo[]> {
  const source = load().find((s) => s.id === id);
  if (!source) return listSources();
  const got = await capture(source.kind, source.location);
  fs.writeFileSync(textFile(id), got.text);
  Object.assign(source, { chars: got.text.length, files: got.files, refreshedAt: Date.now() });
  return save();
}

export function removeSource(id: string): SourceInfo[] {
  cache = load().filter((s) => s.id !== id);
  fs.rmSync(textFile(id), { force: true });
  return save();
}

export function setSourceEnabled(id: string, enabled: boolean): SourceInfo[] {
  const source = load().find((s) => s.id === id);
  if (source) source.enabled = enabled;
  return save();
}

/** Built once and reused for every answer until the list changes. */
let enabledText: string | undefined;

/** The text of every enabled source, each under its title, for the prompt. */
export function enabledSourceText(): string {
  return (enabledText ??= load()
    .filter((s) => s.enabled)
    .flatMap((s) => {
      try {
        return [`<reference title="${s.title.replace(/"/g, "'")}">\n${fs.readFileSync(textFile(s.id), "utf8")}\n</reference>`];
      } catch {
        return [];
      }
    })
    .join("\n\n"));
}
