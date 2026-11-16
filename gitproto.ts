// Git smart HTTP: pkt-line framing, packfile read/write (plain objects out,
// deltas resolved on read), the v2 and v0 upload-pack flows and receive-pack.
// All parsing is defensive: a malformed body is a 400, never a crash.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { DEFAULT_BRANCH, ZERO_OID, isOid, isValidRefName, oidOf, parseTag, type Forge, type GitObject, type ObjType, type Repo } from './store.ts';

export const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export function pktData(payload: Buffer): Buffer {
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

/** Parse a 4-hex-digit pkt-line length at buf[offset]; throws GitParseError on bad hex. */
function pktLenAt(buf: Buffer, offset: number): number {
  let len = 0;
  for (let i = 0; i < 4; i += 1) {
    const c = buf[offset + i]!;
    let v: number;
    if (c >= 0x30 && c <= 0x39) v = c - 0x30;
    else if (c >= 0x61 && c <= 0x66) v = c - 0x61 + 10;
    else if (c >= 0x41 && c <= 0x46) v = c - 0x41 + 10;
    else throw new GitParseError('bad pkt-line length');
    len = len * 16 + v;
  }
  return len;
}

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines. Throws GitParseError on bad framing. */
export class GitParseError extends Error {}

export function decodePktLines(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new GitParseError('truncated pkt-line header');
    const len = pktLenAt(buf, offset);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4 || len > 65520 || offset + len > buf.length) throw new GitParseError('bad pkt-line length');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return packets;
}

/** Split a receive-pack body into command packets and trailing pack bytes. */
export function splitCommands(buf: Buffer): { commands: Packet[]; pack: Buffer } {
  let offset = 0;
  const commands: Packet[] = [];
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new GitParseError('truncated pkt-line header');
    const len = pktLenAt(buf, offset);
    if (len === 0) {
      offset += 4;
      return { commands, pack: buf.subarray(offset) };
    }
    if (len < 4 || len > 65520 || offset + len > buf.length) throw new GitParseError('bad pkt-line length');
    commands.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  throw new GitParseError('command list has no flush packet');
}

// ---------------------------------------------------------------- pack reading

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new GitParseError('truncated varint');
    const byte = buf[pos]!;
    pos += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

/**
 * Whether the inflate engine's reported input count has been verified exact.
 * Null means untested: the first successful fast inflate is checked against a
 * second inflate of the reported prefix, and the result is remembered for the
 * life of the process. A corrupt stream never sets this, so a bad pack cannot
 * poison the calibration, and an engine that misreports falls back to the
 * search below on every call.
 */
let inflateBytesTrusted: boolean | null = null;

/** Inflate one zlib stream starting at buf[0]; binary-search the consumed length. */
function inflateOne(buf: Buffer, expectedSize: number): { data: Buffer; consumed: number } {
  if (buf.length === 0) throw new GitParseError('empty object data');
  // Fast path: one inflate, with the consumed length taken from the engine.
  // Trusted only after the one-time calibration above proves it exact.
  if (inflateBytesTrusted !== false) {
    try {
      const out = inflateSync(buf, { info: true }) as unknown as { buffer: Buffer; engine?: { bytesWritten?: unknown } };
      const consumed = out.engine?.bytesWritten;
      if (typeof consumed === 'number' && Number.isInteger(consumed) && consumed > 0 && consumed <= buf.length && out.buffer.length === expectedSize) {
        if (inflateBytesTrusted === true) return { data: out.buffer, consumed };
        const check = inflateSync(buf.subarray(0, consumed));
        if (check.length === expectedSize && check.equals(out.buffer)) {
          inflateBytesTrusted = true;
          return { data: out.buffer, consumed };
        }
        inflateBytesTrusted = false;
      }
    } catch {
      // Fall through to the version-proof search.
    }
  }
  let data: Buffer;
  try {
    data = inflateSync(buf);
  } catch {
    throw new GitParseError('object data does not inflate');
  }
  if (data.length !== expectedSize) throw new GitParseError('object size mismatch');
  let lo = 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const trial = inflateSync(buf.subarray(0, mid));
      if (trial.length === expectedSize) hi = mid;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  return { data, consumed: lo };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readVarint(delta, 0);
  if (source.value !== base.length) throw new GitParseError('delta base size mismatch');
  const target = readVarint(delta, source.next);
  const out: Buffer[] = [];
  let total = 0;
  let pos = target.next;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (pos >= delta.length) throw new GitParseError('truncated delta copy');
          offset |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (pos >= delta.length) throw new GitParseError('truncated delta copy');
          size |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new GitParseError('delta copy out of range');
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new GitParseError('truncated delta insert');
      out.push(delta.subarray(pos, pos + op));
      total += op;
      pos += op;
    } else {
      throw new GitParseError('delta opcode 0');
    }
  }
  if (total !== target.value) throw new GitParseError('delta target size mismatch');
  return Buffer.concat(out);
}

const TYPE_NUMBERS: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

interface RawEntry {
  offset: number;
  kind: 'plain' | 'ofs' | 'ref';
  type?: ObjType;
  size: number;
  data?: Buffer;
  baseOffset?: number;
  baseOid?: string;
  delta?: Buffer;
}

/**
 * Parse a packfile into objects without touching the repository. Verifies the
 * header, the declared count, entry sizes and the SHA-1 trailer.
 */
export function readPack(pack: Buffer, resolveBase: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new GitParseError('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new GitParseError('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new GitParseError('unsupported pack version');
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (trailer !== actual) throw new GitParseError('pack trailer mismatch');
  const bodyEnd = pack.length - 20;

  const entries: RawEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    if (offset >= bodyEnd) throw new GitParseError('pack ends before its declared count');
    const entryOffset = offset;
    const first = pack[offset]!;
    offset += 1;
    const typeNum = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    while ((byte & 0x80) !== 0) {
      if (offset >= bodyEnd) throw new GitParseError('truncated object header');
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum >= 1 && typeNum <= 4) {
      const inflated = inflateOne(pack.subarray(offset, bodyEnd), size);
      offset += inflated.consumed;
      entries.push({ offset: entryOffset, kind: 'plain', type: TYPE_NUMBERS[typeNum]!, size, data: inflated.data });
    } else if (typeNum === 6) {
      if (offset >= bodyEnd) throw new GitParseError('truncated ofs-delta');
      let byte2 = pack[offset]!;
      offset += 1;
      let baseOffset = byte2 & 0x7f;
      while ((byte2 & 0x80) !== 0) {
        if (offset >= bodyEnd) throw new GitParseError('truncated ofs-delta');
        byte2 = pack[offset]!;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte2 & 0x7f);
      }
      const inflated = inflateOne(pack.subarray(offset, bodyEnd), size);
      offset += inflated.consumed;
      entries.push({ offset: entryOffset, kind: 'ofs', size, baseOffset: entryOffset - baseOffset, delta: inflated.data });
    } else if (typeNum === 7) {
      if (offset + 20 > bodyEnd) throw new GitParseError('truncated ref-delta');
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateOne(pack.subarray(offset, bodyEnd), size);
      offset += inflated.consumed;
      entries.push({ offset: entryOffset, kind: 'ref', size, baseOid, delta: inflated.data });
    } else {
      throw new GitParseError(`unknown pack entry type ${typeNum}`);
    }
  }
  if (offset !== bodyEnd) throw new GitParseError('pack has trailing bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const pending = new Set<number>();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.kind === 'plain') {
      const obj: GitObject = { type: entry.type!, data: entry.data! };
      byOffset.set(entry.offset, obj);
      objects.set(oidOf(obj.type, obj.data), obj);
    } else {
      pending.add(i);
    }
  }
  let progressed = true;
  while (pending.size > 0 && progressed) {
    progressed = false;
    for (const i of [...pending]) {
      const entry = entries[i]!;
      let base: GitObject | undefined;
      if (entry.kind === 'ofs') base = byOffset.get(entry.baseOffset!);
      else {
        base = objects.get(entry.baseOid!) ?? resolveBase(entry.baseOid!);
      }
      if (base === undefined) continue;
      const data = applyDelta(base.data, entry.delta!);
      const obj: GitObject = { type: base.type, data };
      byOffset.set(entry.offset, obj);
      objects.set(oidOf(obj.type, obj.data), obj);
      pending.delete(i);
      progressed = true;
    }
  }
  if (pending.size > 0) throw new GitParseError('delta base missing from pack and store');
  return objects;
}

// ---------------------------------------------------------------- pack writing

function encodeEntryHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  let rest = size >> 4;
  if (rest > 0) first |= 0x80;
  bytes.push(first);
  while (rest > 0) {
    let byte = rest & 0x7f;
    rest >>= 7;
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** One pack entry's bytes for an object, cached on the repository. */
function packEntry(repo: Repo, oid: string, obj: GitObject): Buffer {
  const cached = repo.deflateCache.get(oid);
  if (cached !== undefined) return cached;
  const header = encodeEntryHeader(TYPE_CODES[obj.type], obj.data.length);
  const entry = Buffer.concat([header, deflateSync(obj.data)]);
  repo.deflateCache.set(oid, entry);
  return entry;
}

/** Build a packfile of plain objects (no deltas), deduplicated, with trailer. */
export function writePack(repo: Repo, oids: readonly string[]): Buffer {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const oid of oids) {
    const key = oid.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const obj = repo.getObject(key);
    if (obj !== undefined) unique.push(key);
  }
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(unique.length, 8);
  parts.push(header);
  for (const oid of unique) parts.push(packEntry(repo, oid, repo.getObject(oid)!));
  // The trailer is the SHA-1 of everything before it, hashed incrementally so
  // the pack is assembled in a single concatenation.
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part);
  parts.push(hash.digest());
  return Buffer.concat(parts);
}

/** A 32-byte empty pack (version 2, zero objects), built once: it never changes. */
const EMPTY_PACK: Buffer = (() => {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(0, 8);
  return Buffer.concat([header, createHash('sha1').update(header).digest()]);
})();

export function emptyPack(): Buffer {
  return EMPTY_PACK;
}

// ---------------------------------------------------------------- fetch selection

function treeClosure(repo: Repo, treeOid: string, out: Set<string>): void {
  const stack = [treeOid.toLowerCase()];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (out.has(current)) continue;
    const entries = repo.parseTree(current);
    if (entries === null) continue;
    out.add(current);
    for (const entry of entries) {
      if (entry.mode === '40000') stack.push(entry.oid.toLowerCase());
      else out.add(entry.oid.toLowerCase());
    }
  }
}

/** All objects reachable from `roots`, stopping parent traversal at boundaries. */
function reachClosure(repo: Repo, roots: readonly string[], boundaries: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const commitQueue: string[] = [];
  const seenCommits = new Set<string>();
  const visit = (oid: string, tagDepth: number): void => {
    const key = oid.toLowerCase();
    const obj = repo.getObject(key);
    if (obj === undefined) return;
    if (obj.type === 'tag') {
      out.add(key);
      if (tagDepth < 16) visit(parseTag(obj.data).object, tagDepth + 1);
      return;
    }
    if (obj.type === 'commit') {
      if (seenCommits.has(key)) return;
      seenCommits.add(key);
      commitQueue.push(key);
      return;
    }
    out.add(key);
  };
  for (const root of roots) visit(root, 0);
  while (commitQueue.length > 0) {
    const oid = commitQueue.pop()!;
    out.add(oid);
    const commit = repo.parseCommit(oid);
    if (commit === null) continue;
    treeClosure(repo, commit.tree, out);
    if (boundaries.has(oid)) continue;
    for (const parent of commit.parents) visit(parent, 0);
  }
  return out;
}

export interface FetchSelection {
  objects: string[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * The pack for a fetch: the depth-limited closure of the wants minus the
 * have-closure (shallow-aware), plus shallow/unshallow lines and ACKs.
 */
export function selectFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): FetchSelection {
  const boundarySet = new Set(shallowBoundaries.map((oid) => oid.toLowerCase()));
  const haveClosure = reachClosure(repo, haves, boundarySet);

  const distances = new Map<string, number>();
  const queue: Array<{ oid: string; dist: number }> = [];
  const enqueueWant = (oid: string): void => {
    let current = oid.toLowerCase();
    for (let hop = 0; hop < 16; hop += 1) {
      const obj = repo.getObject(current);
      if (obj === undefined) return;
      if (obj.type === 'tag') {
        if (!distances.has(current)) distances.set(current, -1);
        current = parseTag(obj.data).object.toLowerCase();
        continue;
      }
      if (obj.type === 'commit') {
        if (!distances.has(current)) {
          distances.set(current, 0);
          queue.push({ oid: current, dist: 0 });
        }
        return;
      }
      if (!distances.has(current)) distances.set(current, -1);
      return;
    }
  };
  for (const want of wants) enqueueWant(want);
  const wantClosure = new Set<string>();
  for (const [oid, dist] of distances) if (dist === -1) wantClosure.add(oid);
  const deliveredCommits = new Set<string>();
  for (let qi = 0; qi < queue.length; qi += 1) {
    const { oid, dist } = queue[qi]!;
    if (depth !== null && dist >= depth) continue;
    if (deliveredCommits.has(oid)) continue;
    deliveredCommits.add(oid);
    wantClosure.add(oid);
    const commit = repo.parseCommit(oid);
    if (commit === null) continue;
    treeClosure(repo, commit.tree, wantClosure);
    for (const parent of commit.parents) {
      const key = parent.toLowerCase();
      if (!distances.has(key)) {
        distances.set(key, dist + 1);
        queue.push({ oid: key, dist: dist + 1 });
      }
    }
  }

  const objects: string[] = [];
  for (const oid of wantClosure) if (!haveClosure.has(oid)) objects.push(oid);
  const delivered = new Set(objects);
  const known = new Set([...delivered, ...haveClosure]);

  const shallow: string[] = [];
  for (const oid of deliveredCommits) {
    if (!delivered.has(oid)) continue;
    const commit = repo.parseCommit(oid);
    if (commit === null) continue;
    if (commit.parents.some((parent) => !known.has(parent.toLowerCase()))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const boundary of boundarySet) {
    const commit = repo.parseCommit(boundary);
    if (commit === null) continue;
    if (commit.parents.every((parent) => known.has(parent.toLowerCase()))) unshallow.push(boundary);
  }
  const acks: string[] = [];
  for (const have of haves) if (repo.getObject(have) !== undefined) acks.push(have.toLowerCase());
  return { objects, shallow, unshallow, acks };
}

// ---------------------------------------------------------------- ref listing

export interface ListedRef {
  oid: string;
  name: string;
  peeled?: string;
}

export function listRefs(repo: Repo): ListedRef[] {
  const refs: ListedRef[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: ListedRef = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const obj = repo.getObject(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = repo.peelToCommit(oid);
        if (peeled !== null && peeled !== oid.toLowerCase()) entry.peeled = peeled;
      }
    }
    refs.push(entry);
  }
  return refs;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktData(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (packets.length === 0) packets.push(pktData(Buffer.concat([Buffer.from([1]), emptyPack()])));
  return packets;
}

// ---------------------------------------------------------------- advertisements

/** The v2 capability advertisement, built once: it carries no repository state. */
const ADVERTISEMENT_V2: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow\n'),
  pktLine('agent\n'),
  pktLine('object-format=sha1\n'),
  FLUSH,
]);

export function advertisementV2(): Buffer {
  return ADVERTISEMENT_V2;
}

export function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k shallow thin-pack ofs-delta multi_ack_detailed symref=HEAD:refs/heads/main'
      : 'report-status side-band-64k delete-refs ofs-delta';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const mainTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? ZERO_OID;
  const refs = listRefs(repo);
  parts.push(pktLine(`${mainTip} HEAD\0${caps}\n`));
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\n`));
  } else {
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs and fetch

export function handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const refs = listRefs(repo);
  const mainTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  if (keep('HEAD')) {
    const headOid = mainTip ?? ZERO_OID;
    parts.push(pktLine(symrefs ? `${headOid} HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n` : `${headOid} HEAD\n`));
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

export function parseFetchArgs(args: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim().split(' ')[0]!);
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isInteger(n) && n > 0) depth = n;
    }
  }
  return { wants, haves, shallow, depth };
}

export function handleFetchV2(repo: Repo, fetchArgs: FetchArgs): Buffer {
  const cached = fetchCacheGet(repo, 'v2', fetchArgs);
  if (cached !== undefined) return cached;
  const out = buildFetchV2(repo, fetchArgs);
  fetchCachePut(repo, 'v2', fetchArgs, out);
  return out;
}

/**
 * The fetch cache: a fetch response depends only on the fetch arguments and
 * the object store, and the store is append-only (objects are immutable and
 * never overwritten), so the store size in the key makes a hit exact. A hit
 * returns bytes identical to a fresh computation. Entries are capped by total
 * bytes, and oversized responses are never cached.
 */
const FETCH_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const FETCH_CACHE_MAX_ENTRY = 4 * 1024 * 1024;

function fetchCacheKey(repo: Repo, variant: string, fetchArgs: FetchArgs): string {
  const norm = (oids: readonly string[]): string => oids.map((oid) => oid.toLowerCase()).join(',');
  return `${variant}\n${norm(fetchArgs.wants)}\n${norm(fetchArgs.haves)}\n${norm(fetchArgs.shallow)}\n${fetchArgs.depth ?? ''}\n${repo.objects.size}`;
}

function fetchCacheGet(repo: Repo, variant: string, fetchArgs: FetchArgs): Buffer | undefined {
  return repo.fetchCache.get(fetchCacheKey(repo, variant, fetchArgs));
}

function fetchCachePut(repo: Repo, variant: string, fetchArgs: FetchArgs, out: Buffer): void {
  if (out.length > FETCH_CACHE_MAX_ENTRY) return;
  if (repo.fetchCacheBytes + out.length > FETCH_CACHE_MAX_BYTES) {
    repo.fetchCache.clear();
    repo.fetchCacheBytes = 0;
  }
  const key = fetchCacheKey(repo, variant, fetchArgs);
  if (!repo.fetchCache.has(key)) {
    repo.fetchCache.set(key, out);
    repo.fetchCacheBytes += out.length;
  }
}

function buildFetchV2(repo: Repo, fetchArgs: FetchArgs): Buffer {
  const selection = selectFetch(repo, fetchArgs.wants, fetchArgs.haves, fetchArgs.shallow, fetchArgs.depth);
  const pack = selection.objects.length === 0 ? emptyPack() : writePack(repo, selection.objects);
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  if (selection.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(FLUSH);
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function handleFetchV0(repo: Repo, fetchArgs: FetchArgs): Buffer {
  const cached = fetchCacheGet(repo, 'v0', fetchArgs);
  if (cached !== undefined) return cached;
  const out = buildFetchV0(repo, fetchArgs);
  fetchCachePut(repo, 'v0', fetchArgs, out);
  return out;
}

function buildFetchV0(repo: Repo, fetchArgs: FetchArgs): Buffer {
  const selection = selectFetch(repo, fetchArgs.wants, fetchArgs.haves, fetchArgs.shallow, fetchArgs.depth);
  const pack = selection.objects.length === 0 ? emptyPack() : writePack(repo, selection.objects);
  const parts: Buffer[] = [];
  if (selection.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack dispatch

/** Parse a v2 request body: command line, header lines, delim, args, flush. */
export function parseV2Request(packets: Packet[]): { command: string; args: string[] } {
  const lines: string[] = [];
  let sawDelim = false;
  const args: string[] = [];
  let command: string | null = null;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind !== 'data') throw new GitParseError('unexpected control packet');
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (command === null) {
      if (!text.startsWith('command=')) throw new GitParseError('v2 request has no command');
      command = text.slice('command='.length);
      continue;
    }
    if (sawDelim) args.push(text);
    else lines.push(text);
  }
  if (command === null) throw new GitParseError('empty v2 request');
  void lines;
  return { command, args };
}

export function handleUploadPack(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const first = packets.find((packet) => packet.kind === 'data');
  if (first === undefined) throw new GitParseError('empty upload-pack body');
  const firstText = first.payload.toString('utf8');
  if (firstText.startsWith('command=')) {
    const { command, args } = parseV2Request(packets);
    if (command === 'ls-refs') return handleLsRefs(repo, args);
    if (command === 'fetch') return handleFetchV2(repo, parseFetchArgs(args));
    throw new GitParseError(`unknown v2 command ${command}`);
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return handleFetchV0(repo, parseFetchArgs(lines));
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = splitCommands(body);
  if (commands.length === 0) throw new GitParseError('push has no commands');
  let sideband = false;
  const parsed: PushCommand[] = [];
  commands.forEach((packet, index) => {
    if (packet.kind !== 'data') throw new GitParseError('bad command packet');
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        const caps = text.slice(nul + 1).split(' ');
        sideband = caps.includes('side-band-64k');
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1]) || !parts[2]!.startsWith('refs/')) {
      throw new GitParseError('bad push command line');
    }
    parsed.push({ oldOid: parts[0]!.toLowerCase(), newOid: parts[1]!.toLowerCase(), ref: parts[2]! });
  });

  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => repo.getObject(oid));
      for (const [oid, obj] of objects) repo.putObjectWithOid(oid, obj.type, obj.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpacker error';
    }
  }

  reportLines.push(unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`);
  for (const command of parsed) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    if (!isValidRefName(command.ref)) {
      reportLines.push(`ng ${command.ref} invalid ref name`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    const currentOid = current ?? ZERO_OID;
    if (command.oldOid !== currentOid) {
      reportLines.push(`ng ${command.ref} old oid does not match the current tip`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} ref does not exist`);
        continue;
      }
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}`);
      continue;
    }
    if (repo.getObject(command.newOid) === undefined) {
      reportLines.push(`ng ${command.ref} new object is not in the repository`);
      continue;
    }
    if (current !== undefined && command.oldOid === ZERO_OID) {
      reportLines.push(`ng ${command.ref} ref already exists`);
      continue;
    }
    if (current !== undefined) {
      const oldCommit = repo.peelToCommit(command.oldOid);
      const newCommit = repo.peelToCommit(command.newOid);
      if (oldCommit === null || newCommit === null || !repo.isAncestor(oldCommit, newCommit)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }

  const inner = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), FLUSH]);
  if (!sideband) return Buffer.concat([inner, FLUSH]);
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < inner.length; offset += CHUNK) {
    parts.push(pktData(Buffer.concat([Buffer.from([1]), inner.subarray(offset, Math.min(inner.length, offset + CHUNK))])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function isGitPath(path: string): { owner: string; repo: string; rest: string } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length < 2) return null;
  const repoSegment = segments[1]!;
  if (!repoSegment.endsWith('.git')) return null;
  const decode = (segment: string): string => (segment.includes('%') ? decodeURIComponent(segment) : segment);
  try {
    return {
      owner: decode(segments[0]!),
      repo: decode(repoSegment.slice(0, -4)),
      rest: segments.slice(2).map(decode).join('/'),
    };
  } catch {
    return null;
  }
}

export type { Forge };
