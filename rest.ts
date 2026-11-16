// The REST v3 surface: repositories, branches, commits, contents, git refs,
// labels, issues, comments and pull requests. Every reply is JSON with a
// request id (the router adds the header); errors carry a string `message`.

import { DEFAULT_BRANCH, ZERO_OID, isOid, isValidRefName, lineDiffCounts, parseTag, type FlatEntry, type Forge, type Issue, type Pull, type Repo } from './store.ts';

export interface RestContext {
  method: string;
  segments: string[];
  query: URLSearchParams;
  json: unknown;
  jsonError: boolean;
  host: string;
  pathname: string;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  empty?: boolean;
  /** Pre-serialized JSON body (without the trailing newline the router adds). */
  bodyText?: string;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function okText(status: number, bodyText: string, headers?: Record<string, string>): RestResult {
  return { status, body: null, headers, bodyText };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = forge.ownerLoginOf(repo);
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: owner === '' ? repo.name : `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: forge.nowIso,
    updated_at: forge.nowIso,
  };
}

export function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed' };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: issue.userLogin, id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: forge.nowIso,
    updated_at: forge.nowIso,
  };
}

export function commentJson(forge: Forge, comment: { id: number; body: string; userLogin: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.userLogin, id: 1, type: 'User' },
    created_at: forge.nowIso,
    updated_at: forge.nowIso,
  };
}

/**
 * The serialized form of issueJson, cached per issue. An issue rendering
 * depends only on the issue itself, the repository labels, and the fixed
 * trial clock, so the cache is dropped when the issue changes (PATCH, a new
 * comment) and invalidated for the whole repository when a label changes.
 */
export function issueJsonText(forge: Forge, repo: Repo, issue: Issue): string {
  const cached = repo.issueTextCache.get(issue.number);
  if (cached !== undefined && cached.rev === repo.renderRev) return cached.text;
  const text = JSON.stringify(issueJson(forge, repo, issue));
  repo.issueTextCache.set(issue.number, { rev: repo.renderRev, text });
  return text;
}

/** Drop one issue's cached rendering after a mutation. */
export function invalidateIssueText(repo: Repo, number: number): void {
  repo.issueTextCache.delete(number);
}

export function branchTip(repo: Repo, branch: string): string | undefined {
  const name = branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
  return repo.refs.get(`refs/heads/${name}`);
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${forge.ownerLoginOf(repo)}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${forge.ownerLoginOf(repo)}:${pull.baseRef}` },
    user: { login: pull.userLogin, id: 1, type: 'User' },
    created_at: forge.nowIso,
    updated_at: forge.nowIso,
  };
}

/** Resolve a ref-ish (branch name, full ref, or oid) to a commit oid. */
export function resolveRefToCommit(repo: Repo, ref: string): string | null {
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const tip = repo.refs.get(candidate);
    if (tip !== undefined) return repo.peelToCommit(tip);
  }
  if (isOid(ref)) return repo.peelToCommit(ref);
  return null;
}

function normalizeBranch(branch: string): string {
  let name = branch;
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  const colon = name.lastIndexOf(':');
  if (colon >= 0) name = name.slice(colon + 1);
  return name;
}

// ---------------------------------------------------------------- git data helpers

interface Identity {
  name: string;
  email: string;
  date: string;
}

function parseIdentityLine(line: string): Identity | null {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return null;
  return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
}

function identityFromInput(value: unknown, forge: Forge): { name: string; email: string; sec: number } {
  const rec = isRecord(value) ? value : {};
  const name = typeof rec.name === 'string' && rec.name !== '' ? rec.name : 'Forge';
  const email = typeof rec.email === 'string' && rec.email !== '' ? rec.email : 'forge@forge.local';
  let sec = forge.nowSec;
  if (typeof rec.date === 'string') {
    const ms = Date.parse(rec.date);
    if (!Number.isNaN(ms)) sec = Math.floor(ms / 1000);
  }
  return { name, email, sec };
}

function identityLineOf(id: { name: string; email: string; sec: number }): string {
  return `${id.name} <${id.email}> ${id.sec} +0000`;
}

interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  author: Identity | null;
  committer: Identity | null;
}

function commitInfo(repo: Repo, sha: string): CommitInfo | null {
  const obj = repo.getObject(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author: Identity | null = null;
  let committer: Identity | null = null;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parseIdentityLine(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseIdentityLine(line.slice(10));
  }
  return { tree, parents, message, author, committer };
}

function gitCommitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const info = commitInfo(repo, sha);
  if (info === null) return null;
  const author = info.author ?? { name: '', email: '', date: '' };
  const committer = info.committer ?? author;
  return {
    sha,
    message: info.message,
    tree: { sha: info.tree },
    parents: info.parents.map((parent) => ({ sha: parent })),
    author,
    committer,
    commit: { message: info.message, tree: { sha: info.tree }, author, committer },
  };
}

/** Decode strict base64 (whitespace tolerated, as GitHub wraps content). Null when malformed. */
function decodeBase64Strict(text: string): Buffer | null {
  const compact = text.replace(/[\r\n\t ]+/g, '');
  if (compact === '') return Buffer.alloc(0);
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.toString('base64') !== compact) return null;
  return bytes;
}

/** Flatten a tree object into a path map, iteratively. False when a tree is missing. */
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, FlatEntry>): boolean {
  const stack: Array<{ treeOid: string; prefix: string }> = [{ treeOid, prefix }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const entries = repo.parseTree(frame.treeOid);
    if (entries === null) return false;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i]!;
      const path = frame.prefix === '' ? entry.name : `${frame.prefix}/${entry.name}`;
      if (entry.mode === '40000') stack.push({ treeOid: entry.oid, prefix: path });
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return true;
}

/** The flat path map of a commit, tag, or tree oid. Null when it cannot resolve. */
function flatOfOid(repo: Repo, oid: string): Map<string, FlatEntry> | null {
  const obj = repo.getObject(oid);
  if (obj === undefined) return null;
  if (obj.type === 'commit') return repo.flatTree(oid);
  if (obj.type === 'tree') {
    const out = new Map<string, FlatEntry>();
    return flattenTree(repo, oid, '', out) ? out : null;
  }
  if (obj.type === 'tag') {
    const peeled = repo.peelToCommit(oid);
    return peeled === null ? null : repo.flatTree(peeled);
  }
  return null;
}

/** The tree oid of a commit, tag, or tree oid. Null when it cannot resolve. */
function treeOidOfOid(repo: Repo, oid: string): string | null {
  const obj = repo.getObject(oid);
  if (obj === undefined) return null;
  if (obj.type === 'tree') return oid.toLowerCase();
  if (obj.type === 'commit') return repo.parseCommit(oid)?.tree ?? null;
  if (obj.type === 'tag') {
    const peeled = repo.peelToCommit(oid);
    return peeled === null ? null : (repo.parseCommit(peeled)?.tree ?? null);
  }
  return null;
}

/** GitHub API mode spelling: directory modes carry the leading zero. */
function apiMode(mode: string): string {
  return mode === '40000' ? '040000' : mode;
}

/** Normalize an API mode to the store spelling, or null when it is not a git mode. */
function normalizeMode(mode: unknown, type: string): string | null {
  const value = typeof mode === 'string' ? mode : type === 'tree' ? '040000' : '100644';
  if (value === '040000' || value === '40000') return '40000';
  if (value === '100644' || value === '100755' || value === '120000' || value === '160000') return value;
  return null;
}

function typeOfMode(mode: string): string {
  if (mode === '40000') return 'tree';
  if (mode === '160000') return 'commit';
  return 'blob';
}

function treeListJson(repo: Repo, treeOid: string, recursive: boolean, prefix: string): Array<Record<string, unknown>> | null {
  const out: Array<Record<string, unknown>> = [];
  const stack: Array<{ treeOid: string; prefix: string; index: number; entries: ReturnType<Repo['parseTree']> }> = [];
  const first = repo.parseTree(treeOid);
  if (first === null) return null;
  stack.push({ treeOid, prefix, index: 0, entries: first });
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.entries!.length) {
      stack.pop();
      continue;
    }
    const entry = frame.entries![frame.index]!;
    frame.index += 1;
    const path = frame.prefix === '' ? entry.name : `${frame.prefix}/${entry.name}`;
    const record: Record<string, unknown> = { path, mode: apiMode(entry.mode), type: typeOfMode(entry.mode), sha: entry.oid };
    const obj = repo.getObject(entry.oid);
    if (obj !== undefined && obj.type === 'blob') record.size = obj.data.length;
    out.push(record);
    if (recursive && entry.mode === '40000') {
      const children = repo.parseTree(entry.oid);
      if (children === null) return null;
      stack.push({ treeOid: entry.oid, prefix: path, index: 0, entries: children });
    }
  }
  return out;
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const rawPerPage = Number(query.get('per_page'));
  const rawPage = Number(query.get('page'));
  const perPage = Number.isInteger(rawPerPage) && rawPerPage > 0 ? Math.min(rawPerPage, 100) : 30;
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(ctx: RestContext, perPage: number, page: number, total: number): Record<string, string> | undefined {
  if (page * perPage >= total) return undefined;
  const params = new URLSearchParams(ctx.query);
  params.set('per_page', String(perPage));
  params.set('page', String(page + 1));
  const url = `http://${ctx.host}${ctx.pathname}?${params.toString()}`;
  return { link: `<${url}>; rel="next"` };
}

/** Three-way merge of head into base. Null when the merge conflicts. */
export function tryMergeTrees(repo: Repo, baseCommit: string, headCommit: string): Map<string, FlatEntry> | null {
  const baseFlat = repo.flatTree(baseCommit);
  const headFlat = repo.flatTree(headCommit);
  if (baseFlat === null || headFlat === null) return null;
  const mergeBase = repo.mergeBase(baseCommit, headCommit);
  const ancestorFlat = mergeBase === null ? new Map<string, FlatEntry>() : (repo.flatTree(mergeBase) ?? new Map<string, FlatEntry>());
  const merged = new Map<string, FlatEntry>();
  const paths = new Set([...ancestorFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const a = ancestorFlat.get(path);
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const aOid = a?.oid ?? null;
    const bOid = b?.oid ?? null;
    const hOid = h?.oid ?? null;
    if (hOid === bOid) {
      if (h !== undefined) merged.set(path, h);
    } else if (hOid === aOid) {
      if (b !== undefined) merged.set(path, b);
    } else if (bOid === aOid) {
      if (h !== undefined) merged.set(path, h);
    } else {
      return null;
    }
  }
  return merged;
}

/** Squash-merge a pull request. Returns the merge commit oid, or null on conflict. */
export function squashMerge(forge: Forge, repo: Repo, pull: Pull): string | null {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) return null;
  const baseCommit = repo.peelToCommit(baseTip);
  const headCommit = repo.peelToCommit(headTip);
  if (baseCommit === null || headCommit === null) return null;
  const merged = tryMergeTrees(repo, baseCommit, headCommit);
  if (merged === null) return null;
  const treeOid = repo.buildTreeFromFlat(merged);
  const message = `${pull.title} (#${pull.number})`;
  const commitOid = forge.createCommit(repo, treeOid, [baseCommit], message);
  repo.refs.set(`refs/heads/${normalizeBranch(pull.baseRef)}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso;
  pull.mergeCommitSha = commitOid;
  pull.baseSha = commitOid;
  return commitOid;
}

export function diffFiles(repo: Repo, baseCommit: string, headCommit: string): Array<Record<string, unknown>> {
  const baseFlat = repo.flatTree(baseCommit) ?? new Map<string, FlatEntry>();
  const headFlat = repo.flatTree(headCommit) ?? new Map<string, FlatEntry>();
  const out: Array<Record<string, unknown>> = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    const before = b === undefined ? '' : (repo.getObject(b.oid)?.data.toString('utf8') ?? '');
    const after = h === undefined ? '' : (repo.getObject(h.oid)?.data.toString('utf8') ?? '');
    const counts = lineDiffCounts(before, after);
    const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
    out.push({
      filename: path,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return out;
}

function treeOidAtPath(repo: Repo, commitOid: string, dirPath: string): string | null {
  const commit = repo.parseCommit(commitOid);
  if (commit === null) return null;
  if (dirPath === '') return commit.tree;
  let current = commit.tree;
  for (const segment of dirPath.split('/')) {
    const entries = repo.parseTree(current);
    if (entries === null) return null;
    const found = entries.find((entry) => entry.name === segment && entry.mode === '40000');
    if (found === undefined) return null;
    current = found.oid;
  }
  return current;
}

export function handleRest(forge: Forge, ctx: RestContext): RestResult {
  const { method, segments } = ctx;
  const body = isRecord(ctx.json) ? ctx.json : {};

  if (ctx.jsonError && body !== undefined && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    return err(400, 'Malformed JSON in request body');
  }

  // API root and meta: no repository involved.
  if (segments.length === 0) {
    if (method === 'GET') {
      return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return err(404, 'Not Found');
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') return ok(200, { installed_version: '1.0.0' });
    return err(404, 'Not Found');
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') {
      if (forge.viewerLogin === null) return err(404, 'Not Found');
      return ok(200, { login: forge.viewerLogin, id: 1, type: 'User' });
    }
    return err(404, 'Not Found');
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') {
      const name = asString(body.name);
      if (name === '') return err(422, 'name is required');
      const repo = forge.createRepo(name, asBool(body.private, false), asString(body.description));
      if (repo === null) return err(422, 'name already exists on this account');
      return ok(201, repoJson(forge, repo));
    }
    if (method === 'GET') {
      const { perPage, page } = pageParams(ctx.query);
      const all = forge.listRepos();
      return ok(200, paginate(all, perPage, page).map((repo) => repoJson(forge, repo)), linkHeader(ctx, perPage, page, all.length));
    }
    return err(404, 'Not Found');
  }

  if (segments[0] === 'rate_limit' && segments.length === 1) {
    if (method === 'GET') {
      const reset = forge.nowSec + 3600;
      const core = { limit: 5000, remaining: 5000, reset, used: 0 };
      return ok(200, { resources: { core, search: { ...core }, graphql: { ...core } }, rate: { ...core } });
    }
    return err(404, 'Not Found');
  }
  if (segments[0] === 'users' && segments.length >= 2) {
    const login = segments[1]!;
    const viewer = forge.viewerLogin;
    if (viewer === null || viewer.toLowerCase() !== login.toLowerCase()) return err(404, 'Not Found');
    if (segments.length === 2 && method === 'GET') {
      return ok(200, { login: viewer, id: 1, type: 'User', site_admin: false });
    }
    if (segments.length === 3 && segments[2] === 'repos' && method === 'GET') {
      const { perPage, page } = pageParams(ctx.query);
      const all = forge.listRepos();
      const paged = ctx.query.get('per_page') === null && ctx.query.get('page') === null ? all : paginate(all, perPage, page);
      return ok(200, paged.map((repo) => repoJson(forge, repo)), linkHeader(ctx, perPage, page, all.length));
    }
    return err(404, 'Not Found');
  }

  if (segments[0] !== 'repos' || segments.length < 3) return err(404, 'Not Found');
  const owner = segments[1]!;
  const repoName = segments[2]!;
  const repo = forge.resolveRepo(owner, repoName);
  if (repo === null) return err(404, 'Not Found');
  const rest = segments.slice(3);

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(forge, repo));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.privateFlag = body.private;
      return ok(200, repoJson(forge, repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repoName);
      return { status: 204, body: null, empty: true };
    }
    return err(404, 'Not Found');
  }

  const head = rest[0]!;

  // Branches.
  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches: Array<Record<string, unknown>> = [];
      for (const [ref, oid] of [...repo.refs.entries()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
      }
      if (ctx.query.get('per_page') === null && ctx.query.get('page') === null) return ok(200, branches);
      const { perPage, page } = pageParams(ctx.query);
      return ok(200, paginate(branches, perPage, page), linkHeader(ctx, perPage, page, branches.length));
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (tip === undefined) return err(404, 'Not Found');
      return ok(200, { name: branch, commit: { sha: tip }, protected: false });
    }
    return err(404, 'Not Found');
  }

  // Tags.
  if (head === 'tags') {
    if (rest.length === 1 && method === 'GET') {
      const tags: Array<Record<string, unknown>> = [];
      for (const [ref, oid] of [...repo.refs.entries()].sort()) {
        if (!ref.startsWith('refs/tags/')) continue;
        tags.push({ name: ref.slice('refs/tags/'.length), commit: { sha: oid } });
      }
      if (ctx.query.get('per_page') === null && ctx.query.get('page') === null) return ok(200, tags);
      const { perPage, page } = pageParams(ctx.query);
      return ok(200, paginate(tags, perPage, page), linkHeader(ctx, perPage, page, tags.length));
    }
    return err(404, 'Not Found');
  }

  // Compare two refs: /compare/<base>...<head>.
  if (head === 'compare') {
    if (rest.length >= 2 && method === 'GET') {
      const spec = rest.slice(1).join('/');
      let split = spec.indexOf('...');
      let sepLen = 3;
      if (split === -1) {
        split = spec.indexOf('..');
        sepLen = 2;
      }
      if (split === -1) return err(404, 'Not Found');
      const baseRef = spec.slice(0, split);
      const headRef = spec.slice(split + sepLen);
      const baseCommit = resolveRefToCommit(repo, baseRef);
      const headCommit = resolveRefToCommit(repo, headRef);
      if (baseCommit === null || headCommit === null) return err(404, 'Not Found');
      const baseSet = new Set(repo.walkCommits(baseCommit));
      const ahead = repo.walkCommits(headCommit).filter((sha) => !baseSet.has(sha));
      const headSet = new Set(repo.walkCommits(headCommit));
      const behind = repo.walkCommits(baseCommit).filter((sha) => !headSet.has(sha));
      const mergeBase = repo.mergeBase(baseCommit, headCommit);
      const commits = ahead.map((sha) => {
        const parsed = repo.parseCommit(sha)!;
        return { sha, commit: { message: parsed.message }, parents: parsed.parents.map((parent) => ({ sha: parent })) };
      });
      return ok(200, {
        merge_base_commit: { sha: mergeBase ?? baseCommit },
        base_commit: { sha: baseCommit },
        ahead_by: ahead.length,
        behind_by: behind.length,
        total_commits: ahead.length,
        commits,
        files: diffFiles(repo, baseCommit, headCommit),
      });
    }
    return err(404, 'Not Found');
  }

  // Commits.
  if (head === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const refParam = ctx.query.get('sha');
      let tip: string | null;
      if (refParam === null) {
        const branch = branchTip(repo, DEFAULT_BRANCH);
        tip = branch === undefined ? null : repo.peelToCommit(branch);
      } else {
        tip = resolveRefToCommit(repo, refParam);
        if (tip === null) return err(404, 'Not Found');
      }
      if (tip === null) return ok(200, []);
      const commits = repo.walkCommits(tip).map((sha) => {
        const parsed = repo.parseCommit(sha)!;
        return { sha, commit: { message: parsed.message }, parents: parsed.parents.map((parent) => ({ sha: parent })) };
      });
      const { perPage, page } = pageParams(ctx.query);
      const paged = ctx.query.get('per_page') === null ? commits : paginate(commits, perPage, page);
      return ok(200, paged, ctx.query.get('per_page') === null ? undefined : linkHeader(ctx, perPage, page, commits.length));
    }
    if (rest.length === 2 && method === 'GET') {
      const commitOid = resolveRefToCommit(repo, rest[1]!);
      if (commitOid === null) return err(404, 'Not Found');
      const parsed = repo.parseCommit(commitOid)!;
      return ok(200, { sha: commitOid, commit: { message: parsed.message }, parents: parsed.parents.map((parent) => ({ sha: parent })) });
    }
    return err(404, 'Not Found');
  }

  // Git Data: refs, blobs, trees, commits and tags.
  if (head === 'git' && rest[1] === 'blobs') {
    if (rest.length === 2 && method === 'POST') {
      if (typeof body.content !== 'string') return err(422, 'content is required');
      const encoding = asString(body.encoding, 'utf-8');
      if (encoding !== 'utf-8' && encoding !== 'base64') return err(422, 'encoding must be utf-8 or base64');
      const bytes = encoding === 'base64' ? decodeBase64Strict(body.content) : Buffer.from(body.content, 'utf8');
      if (bytes === null) return err(422, 'content is not valid base64');
      const sha = repo.putObject('blob', bytes);
      return ok(201, { sha, size: bytes.length, content: bytes.toString('base64'), encoding: 'base64' });
    }
    if (rest.length === 3 && method === 'GET') {
      const sha = rest[2]!.toLowerCase();
      const obj = repo.getObject(sha);
      if (obj === undefined || obj.type !== 'blob') return err(404, 'Not Found');
      return ok(200, { sha, size: obj.data.length, content: obj.data.toString('base64'), encoding: 'base64' });
    }
    return err(404, 'Not Found');
  }
  if (head === 'git' && rest[1] === 'trees') {
    if (rest.length === 2 && method === 'POST') {
      if (!Array.isArray(body.tree)) return err(422, 'tree is required');
      let flat: Map<string, FlatEntry>;
      if (typeof body.base_tree === 'string' && body.base_tree !== '') {
        const base = flatOfOid(repo, body.base_tree.toLowerCase());
        if (base === null) return err(422, 'base_tree does not exist in this repository');
        flat = new Map(base);
      } else {
        flat = new Map();
      }
      for (const raw of body.tree as unknown[]) {
        if (!isRecord(raw)) return err(422, 'each tree entry must be an object');
        const path = asString(raw.path);
        if (path === '' || path.startsWith('/') || path.endsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
          return err(422, 'each tree entry needs a valid path');
        }
        const type = asString(raw.type, 'blob');
        const mode = normalizeMode(raw.mode, type);
        if (mode === null) return err(422, 'each tree entry needs a valid mode');
        if (typeof raw.content === 'string') {
          if (mode === '40000') return err(422, 'a tree entry cannot carry content');
          const oid = repo.putObject('blob', Buffer.from(raw.content, 'utf8'));
          flat.set(path, { oid, mode });
          continue;
        }
        if (typeof raw.sha !== 'string' || !isOid(raw.sha)) return err(422, 'each tree entry needs a sha or content');
        const sha = raw.sha.toLowerCase();
        const obj = repo.getObject(sha);
        if (obj === undefined) return err(422, 'a tree entry sha does not exist in this repository');
        if (mode === '40000') {
          if (obj.type !== 'tree') return err(422, 'a tree entry sha must name a tree');
          const sub = new Map<string, FlatEntry>();
          if (!flattenTree(repo, sha, path, sub)) return err(422, 'a tree entry sha cannot be read');
          for (const [subPath, entry] of sub) flat.set(subPath, entry);
        } else {
          if (obj.type !== 'blob' && mode !== '160000') return err(422, 'a file entry sha must name a blob');
          flat.set(path, { oid: sha, mode });
        }
      }
      const sha = repo.buildTreeFromFlat(flat);
      const listing = [...flat.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, entry]) => {
          const obj = repo.getObject(entry.oid);
          return { path, mode: apiMode(entry.mode), type: typeOfMode(entry.mode), sha: entry.oid, size: obj?.data.length ?? 0 };
        });
      return ok(201, { sha, tree: listing });
    }
    if (rest.length === 3 && method === 'GET') {
      const treeOid = treeOidOfOid(repo, rest[2]!.toLowerCase());
      if (treeOid === null) return err(404, 'Not Found');
      const recursive = ctx.query.get('recursive') === '1';
      const listing = treeListJson(repo, treeOid, recursive, '');
      if (listing === null) return err(404, 'Not Found');
      return ok(200, { sha: treeOid, tree: listing, truncated: false });
    }
    return err(404, 'Not Found');
  }
  if (head === 'git' && rest[1] === 'commits') {
    if (rest.length === 2 && method === 'POST') {
      const message = asString(body.message);
      const tree = asString(body.tree).toLowerCase();
      if (message === '' || !isOid(tree)) return err(422, 'message and tree are required');
      const treeObj = repo.getObject(tree);
      if (treeObj === undefined || treeObj.type !== 'tree') return err(422, 'tree does not exist in this repository');
      const parents: string[] = [];
      if (body.parents !== undefined) {
        if (!Array.isArray(body.parents)) return err(422, 'parents must be an array');
        for (const raw of body.parents as unknown[]) {
          const sha = isRecord(raw) ? asString(raw.sha).toLowerCase() : '';
          if (!isOid(sha) || repo.getObject(sha) === undefined) return err(422, 'a parent does not exist in this repository');
          parents.push(sha);
        }
      }
      const author = identityFromInput(body.author, forge);
      const committer = identityFromInput(body.committer, forge);
      const lines = [`tree ${tree}`];
      for (const parent of parents) lines.push(`parent ${parent}`);
      lines.push(`author ${identityLineOf(author)}`, `committer ${identityLineOf(committer)}`, '', message);
      const sha = repo.putObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
      return ok(201, gitCommitJson(repo, sha)!);
    }
    if (rest.length === 3 && method === 'GET') {
      const sha = rest[2]!.toLowerCase();
      const found = gitCommitJson(repo, sha);
      if (found === null) return err(404, 'Not Found');
      return ok(200, found);
    }
    return err(404, 'Not Found');
  }
  if (head === 'git' && rest[1] === 'tags') {
    if (rest.length === 2 && method === 'POST') {
      const tag = asString(body.tag);
      const message = asString(body.message);
      const object = asString(body.object).toLowerCase();
      const type = asString(body.type);
      if (tag === '' || message === '' || !isOid(object) || !['commit', 'tree', 'blob', 'tag'].includes(type)) {
        return err(422, 'tag, message, object and type are required');
      }
      if (repo.getObject(object) === undefined) return err(422, 'object does not exist in this repository');
      const tagger = identityFromInput(body.tagger, forge);
      const lines = [`object ${object}`, `type ${type}`, `tag ${tag}`, `tagger ${identityLineOf(tagger)}`, '', message];
      const sha = repo.putObject('tag', Buffer.from(lines.join('\n'), 'utf8'));
      return ok(201, { sha, tag, message, object: { sha: object, type }, tagger: { name: tagger.name, email: tagger.email, date: new Date(tagger.sec * 1000).toISOString() } });
    }
    if (rest.length === 3 && method === 'GET') {
      const sha = rest[2]!.toLowerCase();
      const obj = repo.getObject(sha);
      if (obj === undefined || obj.type !== 'tag') return err(404, 'Not Found');
      const parsed = parseTag(obj.data);
      const text = obj.data.toString('utf8');
      const blank = text.indexOf('\n\n');
      const headText = blank === -1 ? text : text.slice(0, blank);
      const message = blank === -1 ? '' : text.slice(blank + 2);
      let tagger: Identity | null = null;
      for (const line of headText.split('\n')) {
        if (line.startsWith('tagger ')) tagger = parseIdentityLine(line.slice(7));
      }
      return ok(200, { sha, tag: parsed.tag, message, object: { sha: parsed.object, type: parsed.type }, tagger: tagger ?? { name: '', email: '', date: '' } });
    }
    return err(404, 'Not Found');
  }
  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const ref = asString(body.ref);
      const sha = asString(body.sha).toLowerCase();
      if (!ref.startsWith('refs/') || !isOid(sha)) return err(422, 'ref and sha are required');
      if (!isValidRefName(ref)) return err(422, 'ref is not a valid ref name');
      if (repo.getObject(sha) === undefined) return err(422, 'sha does not exist in this repository');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha } });
    }
    if (method === 'GET') {
      const wanted = rest.length === 2 ? 'refs/' : `refs/${rest.slice(2).join('/')}`;
      const exact = repo.refs.get(wanted);
      if (exact !== undefined) return ok(200, { ref: wanted, object: { sha: exact } });
      const matches = [...repo.refs.entries()].filter(([ref]) => ref.startsWith(wanted)).sort();
      if (matches.length === 0) return err(404, 'Not Found');
      return ok(200, matches.map(([ref, sha]) => ({ ref, object: { sha } })));
    }
    if ((method === 'PATCH' || method === 'DELETE') && rest.length >= 3) {
      const wanted = `refs/${rest.slice(2).join('/')}`;
      if (!repo.refs.has(wanted)) return err(404, 'Not Found');
      if (method === 'DELETE') {
        repo.refs.delete(wanted);
        return { status: 204, body: null, empty: true };
      }
      const sha = asString(body.sha).toLowerCase();
      if (!isOid(sha) || repo.getObject(sha) === undefined) return err(422, 'sha does not exist in this repository');
      repo.refs.set(wanted, sha);
      return ok(200, { ref: wanted, object: { sha } });
    }
    return err(404, 'Not Found');
  }

  // Contents.
  if (head === 'contents') {
    const contentPath = rest.slice(1).join('/');
    if (method === 'PUT') {
      const branch = normalizeBranch(asString(body.branch, DEFAULT_BRANCH));
      const branchRef = `refs/heads/${branch}`;
      if (!isValidRefName(branchRef)) return err(422, 'branch is not a valid branch name');
      const message = asString(body.message);
      const content = asString(body.content);
      if (content === '' && body.content !== '') return err(422, 'content is required');
      const bytes = decodeBase64Strict(content);
      if (bytes === null) return err(422, 'content is not valid base64');
      const givenSha = typeof body.sha === 'string' ? body.sha.toLowerCase() : null;
      let tip = repo.refs.get(branchRef);
      let parentCommits: string[] = [];
      let baseFlat: Map<string, FlatEntry>;
      if (tip !== undefined) {
        const commitOid = repo.peelToCommit(tip);
        if (commitOid === null) return err(422, 'branch tip is not a commit');
        parentCommits = [commitOid];
        baseFlat = repo.flatTree(commitOid) ?? new Map();
      } else {
        const defaultTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
        if (defaultTip !== undefined && branch !== DEFAULT_BRANCH) {
          const commitOid = repo.peelToCommit(defaultTip);
          if (commitOid !== null) {
            parentCommits = [commitOid];
            baseFlat = repo.flatTree(commitOid) ?? new Map();
          } else {
            baseFlat = new Map();
          }
        } else {
          baseFlat = new Map();
        }
      }
      const current = baseFlat.get(contentPath);
      if (givenSha !== null && current !== undefined && current.oid.toLowerCase() !== givenSha) {
        return err(409, 'sha does not match the current file');
      }
      if (current !== undefined && givenSha === null) {
        return err(422, 'sha is required to update an existing file');
      }
      const blobOid = repo.putObject('blob', bytes);
      const nextFlat = new Map(baseFlat);
      nextFlat.set(contentPath, { oid: blobOid, mode: current?.mode ?? '100644' });
      const treeOid = repo.buildTreeFromFlat(nextFlat);
      const commitOid = forge.createCommit(repo, treeOid, parentCommits, message);
      repo.refs.set(branchRef, commitOid);
      const name = contentPath.split('/').pop() ?? contentPath;
      return ok(current === undefined ? 201 : 200, {
        content: { name, path: contentPath, sha: blobOid, size: bytes.length, encoding: 'base64', content, type: 'file' },
        commit: { sha: commitOid, message },
      });
    }
    if (method === 'GET') {
      const refParam = ctx.query.get('ref');
      let commitOid: string | null;
      if (refParam === null) {
        const tip = branchTip(repo, DEFAULT_BRANCH);
        commitOid = tip === undefined ? null : repo.peelToCommit(tip);
      } else {
        commitOid = resolveRefToCommit(repo, refParam);
      }
      if (commitOid === null) return err(404, 'Not Found');
      const flat = repo.flatTree(commitOid);
      if (flat === null) return err(404, 'Not Found');
      const file = flat.get(contentPath);
      if (file !== undefined) {
        const obj = repo.getObject(file.oid);
        const bytes = obj?.data ?? Buffer.alloc(0);
        return ok(200, {
          type: 'file',
          encoding: 'base64',
          size: bytes.length,
          name: contentPath.split('/').pop() ?? contentPath,
          path: contentPath,
          sha: file.oid,
          content: bytes.toString('base64'),
        });
      }
      const dirTree = treeOidAtPath(repo, commitOid, contentPath);
      if (dirTree === null) return err(404, 'Not Found');
      const entries = repo.parseTree(dirTree) ?? [];
      const children = entries
        .map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: contentPath === '' ? entry.name : `${contentPath}/${entry.name}`,
          sha: entry.oid,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return ok(200, children);
    }
    if (method === 'DELETE') {
      const branch = normalizeBranch(asString(body.branch, DEFAULT_BRANCH));
      const branchRef = `refs/heads/${branch}`;
      if (!isValidRefName(branchRef)) return err(422, 'branch is not a valid branch name');
      const tip = repo.refs.get(branchRef);
      if (tip === undefined) return err(404, 'Not Found');
      const commitOid = repo.peelToCommit(tip);
      if (commitOid === null) return err(404, 'Not Found');
      const flat = repo.flatTree(commitOid) ?? new Map();
      const current = flat.get(contentPath);
      if (current === undefined) return err(404, 'Not Found');
      const givenSha = typeof body.sha === 'string' ? body.sha.toLowerCase() : null;
      if (givenSha !== null && current.oid.toLowerCase() !== givenSha) return err(409, 'sha does not match the current file');
      const nextFlat = new Map(flat);
      nextFlat.delete(contentPath);
      const treeOid = repo.buildTreeFromFlat(nextFlat);
      const nextCommit = forge.createCommit(repo, treeOid, [commitOid], asString(body.message));
      repo.refs.set(branchRef, nextCommit);
      return ok(200, { commit: { sha: nextCommit } });
    }
    return err(404, 'Not Found');
  }

  // Labels.
  if (head === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      const name = asString(body.name);
      if (name === '') return err(422, 'name is required');
      const color = asString(body.color, 'ededed');
      repo.labels.set(name, { name, color });
      repo.renderRev += 1;
      return ok(201, { name, color });
    }
    if (rest.length === 1 && method === 'GET') {
      return ok(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    if (rest.length >= 2) {
      const labelName = rest.slice(1).join('/');
      const label = repo.labels.get(labelName);
      if (label === undefined) return err(404, 'Not Found');
      if (method === 'GET') return ok(200, { name: label.name, color: label.color });
      if (method === 'DELETE') {
        repo.labels.delete(labelName);
        for (const issue of repo.issues.values()) {
          if (issue.labels.includes(labelName)) {
            issue.labels = issue.labels.filter((entry) => entry !== labelName);
            invalidateIssueText(repo, issue.number);
          }
        }
        repo.renderRev += 1;
        return { status: 204, body: null, empty: true };
      }
      if (method === 'PATCH') {
        const newName = typeof body.name === 'string' && body.name !== '' ? body.name : label.name;
        const newColor = typeof body.color === 'string' ? body.color : label.color;
        if (newName !== label.name) {
          repo.labels.delete(label.name);
          repo.labels.set(newName, { name: newName, color: newColor });
          for (const issue of repo.issues.values()) {
            if (issue.labels.includes(label.name)) {
              issue.labels = issue.labels.map((entry) => (entry === label.name ? newName : entry));
              invalidateIssueText(repo, issue.number);
            }
          }
        } else {
          repo.labels.set(label.name, { name: label.name, color: newColor });
        }
        repo.renderRev += 1;
        return ok(200, { name: newName, color: newColor });
      }
    }
    return err(404, 'Not Found');
  }

  // Issues.
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = asString(body.title);
        if (title === '') return err(422, 'title is required');
        const labelNames = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
        for (const label of labelNames) {
          if (!repo.labels.has(label)) return err(422, `Label "${label}" does not exist`);
        }
        const issue: Issue = {
          id: forge.nextRestId,
          number: repo.nextNumber,
          title,
          body: asString(body.body),
          state: 'open',
          labels: labelNames,
          seq: repo.nextNumber,
          comments: [],
          userLogin: forge.ownerLoginOf(repo),
        };
        forge.nextRestId += 1;
        repo.nextNumber += 1;
        repo.issues.set(issue.number, issue);
        return okText(201, issueJsonText(forge, repo, issue));
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const direction = ctx.query.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const { perPage, page } = pageParams(ctx.query);
        const paged = ctx.query.get('per_page') === null && ctx.query.get('page') === null ? issues : paginate(issues, perPage, page);
        const text = `[${paged.map((issue) => issueJsonText(forge, repo, issue)).join(',')}]`;
        return okText(200, text, linkHeader(ctx, perPage, page, issues.length));
      }
      return err(404, 'Not Found');
    }
    const number = Number(rest[1]);
    // Repository-wide issue comments: /issues/comments and /issues/comments/<id>.
    if (rest[1] === 'comments') {
      if (rest.length === 2 && method === 'GET') {
        const all = [...repo.issues.values()].flatMap((entry) => entry.comments).sort((a, b) => a.seq - b.seq);
        return ok(200, all.map((comment) => commentJson(forge, comment)));
      }
      if (rest.length === 3) {
        const commentId = Number(rest[2]);
        let found: { issue: Issue; index: number } | null = null;
        if (Number.isInteger(commentId)) {
          for (const entry of repo.issues.values()) {
            const index = entry.comments.findIndex((comment) => comment.id === commentId);
            if (index !== -1) {
              found = { issue: entry, index };
              break;
            }
          }
        }
        if (found === null) return err(404, 'Not Found');
        const comment = found.issue.comments[found.index]!;
        if (method === 'GET') return ok(200, commentJson(forge, comment));
        if (method === 'PATCH') {
          if (typeof body.body === 'string') comment.body = body.body;
          return ok(200, commentJson(forge, comment));
        }
        if (method === 'DELETE') {
          found.issue.comments.splice(found.index, 1);
          invalidateIssueText(repo, found.issue.number);
          return { status: 204, body: null, empty: true };
        }
      }
      return err(404, 'Not Found');
    }
    if (!Number.isInteger(number)) return err(404, 'Not Found');
    const issue = repo.issues.get(number);
    if (issue === undefined) return err(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return okText(200, issueJsonText(forge, repo, issue));
      if (method === 'PATCH') {
        if (typeof body.state === 'string') {
          if (body.state !== 'open' && body.state !== 'closed') return err(422, 'state must be open or closed');
          issue.state = body.state;
        }
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.labels !== undefined) {
          if (!Array.isArray(body.labels) || body.labels.some((entry) => typeof entry !== 'string')) {
            return err(422, 'labels must be an array of label names');
          }
          for (const label of body.labels as string[]) {
            if (!repo.labels.has(label)) return err(422, `Label "${label}" does not exist`);
          }
          issue.labels = [...(body.labels as string[])];
        }
        invalidateIssueText(repo, issue.number);
        return okText(200, issueJsonText(forge, repo, issue));
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') {
        const comment = { id: repo.nextCommentId, body: asString(body.body), seq: repo.nextCommentId, userLogin: forge.ownerLoginOf(repo) };
        repo.nextCommentId += 1;
        issue.comments.push(comment);
        invalidateIssueText(repo, issue.number);
        return ok(201, commentJson(forge, comment));
      }
      if (method === 'GET') return ok(200, issue.comments.map((comment) => commentJson(forge, comment)));
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'labels') {
      if (method === 'GET') return ok(200, issue.labels.map((name) => labelJson(repo, name)));
      if (method === 'POST' || method === 'PUT') {
        const raw = Array.isArray(ctx.json) ? ctx.json : isRecord(ctx.json) && Array.isArray(ctx.json.labels) ? ctx.json.labels : null;
        if (raw === null || raw.some((entry) => typeof entry !== 'string')) return err(422, 'labels must be an array of label names');
        for (const label of raw as string[]) {
          if (!repo.labels.has(label)) return err(422, `Label "${label}" does not exist`);
        }
        const names = raw as string[];
        issue.labels = method === 'PUT' ? [...names] : [...issue.labels, ...names.filter((name) => !issue.labels.includes(name))];
        invalidateIssueText(repo, issue.number);
        return ok(200, issue.labels.map((name) => labelJson(repo, name)));
      }
      if (method === 'DELETE') {
        issue.labels = [];
        invalidateIssueText(repo, issue.number);
        return { status: 204, body: null, empty: true };
      }
      return err(404, 'Not Found');
    }
    if (rest.length >= 4 && rest[2] === 'labels' && method === 'DELETE') {
      const labelName = rest.slice(3).join('/');
      if (!issue.labels.includes(labelName)) return err(404, 'Not Found');
      issue.labels = issue.labels.filter((entry) => entry !== labelName);
      invalidateIssueText(repo, issue.number);
      return { status: 204, body: null, empty: true };
    }
    return err(404, 'Not Found');
  }

  // Pull requests.
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = asString(body.title);
        const headRef = normalizeBranch(asString(body.head));
        const baseRef = normalizeBranch(asString(body.base));
        if (title === '' || headRef === '' || baseRef === '') return err(422, 'title, head and base are required');
        const headTip = branchTip(repo, headRef);
        const baseTip = branchTip(repo, baseRef);
        if (headTip === undefined || baseTip === undefined) return err(422, 'head and base branches must exist');
        const pull: Pull = {
          id: forge.nextRestId,
          number: repo.nextNumber,
          title,
          body: asString(body.body),
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          headRef,
          baseRef,
          headSha: headTip,
          baseSha: baseTip,
          seq: repo.nextNumber,
          userLogin: forge.ownerLoginOf(repo),
        };
        forge.nextRestId += 1;
        repo.nextNumber += 1;
        repo.pulls.set(pull.number, pull);
        return ok(201, pullJson(forge, repo, pull));
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.seq - a.seq);
        const { perPage, page } = pageParams(ctx.query);
        const paged = ctx.query.get('per_page') === null && ctx.query.get('page') === null ? pulls : paginate(pulls, perPage, page);
        return ok(200, paged.map((pull) => pullJson(forge, repo, pull)), linkHeader(ctx, perPage, page, pulls.length));
      }
      return err(404, 'Not Found');
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) return err(404, 'Not Found');
    const pull = repo.pulls.get(number);
    if (pull === undefined) return err(404, 'Not Found');
    if (rest.length === 2 && method === 'GET') return ok(200, pullJson(forge, repo, pull));
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const baseTip = branchTip(repo, pull.baseRef);
      const headTip = branchTip(repo, pull.headRef);
      if (baseTip === undefined || headTip === undefined) return err(404, 'Not Found');
      const baseCommit = repo.peelToCommit(baseTip);
      const headCommit = repo.peelToCommit(headTip);
      if (baseCommit === null || headCommit === null) return err(404, 'Not Found');
      return ok(200, diffFiles(repo, baseCommit, headCommit));
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull.merged) return err(405, 'Pull request has already been merged');
      const sha = squashMerge(forge, repo, pull);
      if (sha === null) return err(405, 'Merge conflict: the pull request cannot be merged cleanly');
      return ok(200, { merged: true, sha, message: 'Pull Request successfully merged' });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

export { ZERO_OID };
