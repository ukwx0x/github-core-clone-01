// The forge's in-memory state: git objects, refs, repositories, issues and pull
// requests. Everything lives in Maps; objects are immutable once stored, so the
// parse caches below are safe for the life of the process. All timestamps come
// from MAKEFUN_TRIAL_NOW, never from the wall clock, so replays are identical.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
}

/** The SHA-1 object id of a git object: sha1("<type> <len>\0" + bytes). */
export function oidOf(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

/**
 * The git check-ref-format subset the forge enforces: a refs/ name with no
 * double dots, no control characters or git metacharacters, no empty
 * components, no leading or trailing dot in a component, and no .lock suffix.
 */
export function isValidRefName(ref: string): boolean {
  if (!ref.startsWith('refs/') || ref.length < 6 || ref === 'refs/') return false;
  if (ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) return false;
  if (ref.includes('..') || ref.includes('//') || ref.includes('@{')) return false;
  for (let i = 0; i < ref.length; i += 1) {
    const code = ref.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
    const ch = ref[i]!;
    if (ch === ' ' || ch === '~' || ch === '^' || ch === ':' || ch === '?' || ch === '*' || ch === '[' || ch === '\\') return false;
  }
  for (const component of ref.split('/')) {
    if (component === '' || component === '.' || component.startsWith('.') || component.endsWith('.lock')) return false;
  }
  return true;
}

/** Parse a commit object's headers and message. Unknown headers are ignored. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space === -1 || nul === -1 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Parse a tag object's target. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

/** Git's tree sort: directory names compare with a trailing slash. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

/** Serialize tree entries in git order. */
export function buildTreeBytes(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
  userLogin: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: IssueComment[];
  userLogin: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  userLogin: string;
}

export interface FlatEntry {
  oid: string;
  mode: string;
}

export class Repo {
  readonly name: string;
  readonly dbId: number;
  privateFlag: boolean;
  description: string;
  ownerLogin: string | null;
  readonly defaultBranch = DEFAULT_BRANCH;
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  nextNumber = 1;
  nextCommentId = 1;
  readonly seq: number;
  readonly commitCache = new Map<string, ParsedCommit>();
  readonly treeCache = new Map<string, TreeEntry[]>();
  readonly flatCache = new Map<string, Map<string, FlatEntry>>();
  readonly deflateCache = new Map<string, Buffer>();
  /** Serialized issue JSON by issue number, valid only at renderRev. */
  readonly issueTextCache = new Map<number, { rev: number; text: string }>();
  /** Bumped whenever a label changes, which changes every issue rendering. */
  renderRev = 0;
  /** Cached fetch responses, keyed by fetch args plus the object store size. */
  readonly fetchCache = new Map<string, Buffer>();
  /** Total bytes held in fetchCache, capped so large packs cannot bloat memory. */
  fetchCacheBytes = 0;

  constructor(name: string, dbId: number, priv: boolean, description: string, ownerLogin: string | null, seq: number) {
    this.name = name;
    this.dbId = dbId;
    this.privateFlag = priv;
    this.description = description;
    this.ownerLogin = ownerLogin;
    this.seq = seq;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid.toLowerCase());
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = oidOf(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObjectWithOid(oid: string, type: ObjType, data: Buffer): void {
    const key = oid.toLowerCase();
    if (!this.objects.has(key)) this.objects.set(key, { type, data });
  }

  parseCommit(oid: string): ParsedCommit | null {
    const key = oid.toLowerCase();
    const cached = this.commitCache.get(key);
    if (cached !== undefined) return cached;
    const obj = this.objects.get(key);
    if (obj === undefined || obj.type !== 'commit') return null;
    const parsed = parseCommit(obj.data);
    this.commitCache.set(key, parsed);
    return parsed;
  }

  parseTree(oid: string): TreeEntry[] | null {
    const key = oid.toLowerCase();
    const cached = this.treeCache.get(key);
    if (cached !== undefined) return cached;
    const obj = this.objects.get(key);
    if (obj === undefined || obj.type !== 'tree') return null;
    const parsed = parseTree(obj.data);
    this.treeCache.set(key, parsed);
    return parsed;
  }

  /** Follow tag objects to the commit they point at, or null. */
  peelToCommit(oid: string): string | null {
    let current = oid.toLowerCase();
    for (let hop = 0; hop < 16; hop += 1) {
      const obj = this.objects.get(current);
      if (obj === undefined) return null;
      if (obj.type === 'commit') return current;
      if (obj.type === 'tag') {
        current = parseTag(obj.data).object.toLowerCase();
        continue;
      }
      return null;
    }
    return null;
  }

  /** The flat path map of a commit's tree, cached. Iterative, so deep trees cannot overflow the stack. */
  flatTree(commitOid: string): Map<string, FlatEntry> | null {
    const key = commitOid.toLowerCase();
    const cached = this.flatCache.get(key);
    if (cached !== undefined) return cached;
    const commit = this.parseCommit(key);
    if (commit === null) return null;
    const flat = new Map<string, FlatEntry>();
    const stack: Array<{ treeOid: string; prefix: string }> = [{ treeOid: commit.tree, prefix: '' }];
    while (stack.length > 0) {
      const { treeOid, prefix } = stack.pop()!;
      const entries = this.parseTree(treeOid);
      if (entries === null) return null;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i]!;
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') stack.push({ treeOid: entry.oid, prefix: path });
        else flat.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
    this.flatCache.set(key, flat);
    return flat;
  }

  /** True when `ancestor` is reachable from `descendant` through parent links. */
  isAncestor(ancestor: string, descendant: string): boolean {
    const target = ancestor.toLowerCase();
    const start = descendant.toLowerCase();
    if (target === start) return true;
    const first = this.parseCommit(start);
    if (first !== null) {
      for (const parent of first.parents) if (parent.toLowerCase() === target) return true;
    }
    const seen = new Set<string>([start]);
    const stack = first === null ? [start] : first.parents.map((parent) => parent.toLowerCase());
    let steps = 0;
    while (stack.length > 0 && steps < 200000) {
      steps += 1;
      const current = stack.pop()!;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.parseCommit(current);
      if (commit !== null) for (const parent of commit.parents) stack.push(parent.toLowerCase());
    }
    return false;
  }

  /** A merge base of two commits: the first common ancestor found from `b`. */
  mergeBase(a: string, b: string): string | null {
    const ancestors = new Set<string>();
    const stack = [a.toLowerCase()];
    let steps = 0;
    while (stack.length > 0 && steps < 200000) {
      steps += 1;
      const current = stack.pop()!;
      if (ancestors.has(current)) continue;
      ancestors.add(current);
      const commit = this.parseCommit(current);
      if (commit !== null) for (const parent of commit.parents) stack.push(parent.toLowerCase());
    }
    const seen = new Set<string>();
    const queue = [b.toLowerCase()];
    steps = 0;
    for (let qi = 0; qi < queue.length && steps < 200000; qi += 1) {
      steps += 1;
      const current = queue[qi]!;
      if (ancestors.has(current)) return current;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.parseCommit(current);
      if (commit !== null) for (const parent of commit.parents) queue.push(parent.toLowerCase());
    }
    return null;
  }

  /** All commit oids reachable from `tip`, newest first (depth-first, parents in order). */
  walkCommits(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip.toLowerCase()];
    let steps = 0;
    while (stack.length > 0 && steps < 200000) {
      steps += 1;
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.parseCommit(current);
      if (commit === null) continue;
      out.push(current);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!.toLowerCase());
    }
    return out;
  }

  /** Build (and store) nested tree objects for a flat path map; return the root tree oid. */
  buildTreeFromFlat(flat: ReadonlyMap<string, FlatEntry>): string {
    interface Node {
      entries: Map<string, TreeEntry>;
    }
    const root: Node = { entries: new Map() };
    const nodes = new Map<string, Node>([['', root]]);
    const nodeFor = (dir: string): Node => {
      let node = nodes.get(dir);
      if (node !== undefined) return node;
      node = { entries: new Map() };
      nodes.set(dir, node);
      // Every ancestor directory gets a node too, so a path nested two or
      // more levels deep keeps all of its intermediate trees.
      const slash = dir.lastIndexOf('/');
      if (slash >= 0) nodeFor(dir.slice(0, slash));
      return node;
    };
    for (const [path, entry] of flat) {
      const slash = path.lastIndexOf('/');
      const dir = slash === -1 ? '' : path.slice(0, slash);
      const name = slash === -1 ? path : path.slice(slash + 1);
      nodeFor(dir).entries.set(name, { mode: entry.mode, name, oid: entry.oid });
    }
    // Child directories grouped by parent once, so tree building is linear
    // in the number of directories instead of quadratic.
    const childDirs = new Map<string, string[]>();
    for (const dir of nodes.keys()) {
      if (dir === '') continue;
      const slash = dir.lastIndexOf('/');
      const parent = slash === -1 ? '' : dir.slice(0, slash);
      const list = childDirs.get(parent);
      if (list === undefined) childDirs.set(parent, [dir]);
      else list.push(dir);
    }
    const depthOf = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
    const dirs = [...nodes.keys()].sort((x, y) => depthOf(y) - depthOf(x));
    const treeOidOf = new Map<string, string>();
    for (const dir of dirs) {
      const node = nodes.get(dir)!;
      const entries: TreeEntry[] = [...node.entries.values()];
      for (const childDir of childDirs.get(dir) ?? []) {
        const slash = childDir.lastIndexOf('/');
        const name = slash === -1 ? childDir : childDir.slice(slash + 1);
        entries.push({ mode: '40000', name, oid: treeOidOf.get(childDir)! });
      }
      const bytes = buildTreeBytes(entries);
      treeOidOf.set(dir, this.putObject('tree', bytes));
    }
    return treeOidOf.get('')!;
  }
}

/** Parse MAKEFUN_TRIAL_NOW (epoch seconds or an ISO date) into epoch seconds. */
export function trialNowSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    if (/^-?\d+$/.test(raw)) return Number(raw);
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return 1735689600;
}

export function trialNowIso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

/** Opaque, stable global ids: base64url of "Kind:part:part". */
export function encodeGlobalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

/** A positional cursor into an ordered list, opaque to callers. */
export function encodeCursor(index: number): string {
  return Buffer.from(`c:${index}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^c:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** LCS line diff counts between two texts. */
export function lineDiffCounts(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 400000) return { additions: b.length, deletions: a.length };
  const prev = new Array<number>(b.length + 1).fill(0);
  const curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]!);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j]!;
  }
  const lcs = prev[b.length]!;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  viewerLogin: string | null = null;
  nextDbId = 1;
  nextRestId = 1;
  repoSeq = 0;
  readonly nowSec: number;
  readonly nowIso: string;

  constructor() {
    this.nowSec = trialNowSec();
    this.nowIso = trialNowIso(this.nowSec);
  }

  /** Learn the viewer login from an owner-addressed request, once. */
  bindViewer(login: string): void {
    if (this.viewerLogin === null) this.viewerLogin = login;
  }

  createRepo(name: string, priv: boolean, description: string): Repo | null {
    if (this.repos.has(name)) return null;
    const repo = new Repo(name, this.nextDbId, priv, description, this.viewerLogin, this.repoSeq);
    this.nextDbId += 1;
    this.repoSeq += 1;
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /**
   * Resolve a repository addressed as owner/name. A repository belongs to the
   * login the token names; the same name under another owner is a 404, never a
   * 403. The owner binding is learned from the first owner-addressed request
   * (git checks run first, all under the viewer login), and a known viewer is
   * never rebound by a stranger's first touch of an unbound repository.
   */
  resolveRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (repo.ownerLogin !== null) {
      return repo.ownerLogin.toLowerCase() === owner.toLowerCase() ? repo : null;
    }
    if (this.viewerLogin !== null && this.viewerLogin.toLowerCase() !== owner.toLowerCase()) return null;
    repo.ownerLogin = owner;
    this.bindViewer(owner);
    return repo;
  }

  /** The login to show as a repository's owner, once any binding exists. */
  ownerLoginOf(repo: Repo): string {
    return repo.ownerLogin ?? this.viewerLogin ?? '';
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  /** A commit identity line for commits the forge itself writes. */
  identityLine(): string {
    return `Forge <forge@forge.local> ${this.nowSec} +0000`;
  }

  /** Create and store a commit object on a repository. */
  createCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const lines = [`tree ${treeOid}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    const identity = this.identityLine();
    lines.push(`author ${identity}`, `committer ${identity}`, '', message);
    return repo.putObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
  }
}
