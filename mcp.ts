// The MCP endpoint: JSON-RPC 2.0 over plain JSON replies. Both protocol eras
// are served: server/discover for the 2026-07-28 revision, and the initialize
// handshake for earlier revisions. Tools share the store with REST, so an
// object created here is the same object over REST, with stable ids.

import { encodeGlobalId, isValidRefName, type Forge, type Issue, type Pull, type Repo } from './store.ts';
import { branchTip, commentJson, invalidateIssueText, issueJson, pullJson, repoJson, resolveRefToCommit, squashMerge } from './rest.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const REVISION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tool list, built once: two tools/list answers are byte-identical. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The login of the repository owner.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from one branch into another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
      },
      required: [],
    },
  },
  {
    name: 'create_comment',
    description: 'Add a comment to an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
        body: { type: 'string', description: 'The comment body.' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
  },
  {
    name: 'get_file_contents',
    description: 'Read a file from a repository at a ref, as base64.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        path: { type: 'string', description: 'The repository-relative file path.' },
        ref: { type: 'string', description: 'The branch, tag, or commit to read from.' },
      },
      required: ['owner', 'repo', 'path'],
    },
  },
  {
    name: 'list_branches',
    description: 'List the branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'close_issue',
    description: 'Close an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'get_pull_request',
    description: 'Read one pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_branch',
    description: 'Create a branch at an existing commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        branch: { type: 'string', description: 'The branch name to create.' },
        sha: { type: 'string', description: 'The commit the branch starts at.' },
      },
      required: ['owner', 'repo', 'branch', 'sha'],
    },
  },
]);

export interface McpResult {
  status: number;
  body: unknown;
  empty?: boolean;
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(args: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** Owner and repo from direct properties, or split out of a full_name. */
function ownerRepo(args: Record<string, unknown>): { owner: string | null; repo: string | null } {
  let owner = firstString(args, ['owner', 'owner_login', 'org', 'user', 'login']);
  let repo = firstString(args, ['repo', 'repository', 'repository_name', 'repo_name']);
  const full = firstString(args, ['full_name', 'repo_full_name', 'repository_full_name']);
  if ((owner === null || repo === null) && full !== null && full.includes('/')) {
    const [o, r] = full.split('/', 2);
    if (owner === null) owner = o ?? null;
    if (repo === null) repo = r ?? null;
  }
  return { owner, repo };
}

/** An integer argument under any of its alias names, or NaN when absent or not numeric. */
function numberArg(args: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const raw = args[key];
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  }
  return NaN;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): { error?: { code: number; message: string }; result?: Record<string, unknown> } {
  const known = TOOLS.some((tool) => tool.name === name);
  if (!known) return { error: { code: -32602, message: `Unknown tool: ${name}` } };

  if (name === 'create_repo') {
    const repoName = firstString(args, ['name', 'repo', 'repository']);
    if (repoName === null) return { error: { code: -32602, message: 'create_repo needs a name' } };
    const owner = firstString(args, ['owner', 'owner_login']);
    if (owner !== null) forge.bindViewer(owner);
    const description = firstString(args, ['description', 'about', 'summary']) ?? '';
    const priv = typeof args.private === 'boolean' ? args.private : args.private === 'true';
    const repo = forge.createRepo(repoName, priv, description);
    if (repo === null) return { result: toolError(`Repository "${repoName}" already exists`) };
    if (owner !== null && repo.ownerLogin === null) repo.ownerLogin = owner;
    return { result: toolResult(repoJson(forge, repo)) };
  }

  const { owner, repo: repoName } = ownerRepo(args);
  if (name === 'list_repos') {
    const all = forge.listRepos();
    const filtered = owner === null ? all : all.filter((entry) => forge.ownerLoginOf(entry).toLowerCase() === owner.toLowerCase());
    return { result: toolResult(filtered.map((entry) => repoJson(forge, entry))) };
  }
  if (owner === null || repoName === null) return { error: { code: -32602, message: `${name} needs an owner and a repo` } };
  const repo = forge.resolveRepo(owner, repoName);
  if (repo === null) return { result: toolError(`Repository "${owner}/${repoName}" was not found`) };

  if (name === 'get_repo') {
    return { result: toolResult(repoJson(forge, repo)) };
  }
  if (name === 'create_issue') {
    const title = firstString(args, ['title', 'issue_title', 'subject']);
    if (title === null) return { error: { code: -32602, message: 'create_issue needs a title' } };
    const body = firstString(args, ['body', 'issue_body', 'content', 'text']) ?? '';
    const issue: Issue = {
      id: forge.nextRestId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [],
      seq: repo.nextNumber,
      comments: [],
      userLogin: forge.ownerLoginOf(repo),
    };
    forge.nextRestId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return { result: toolResult(issueJson(forge, repo, issue)) };
  }
  if (name === 'list_issues') {
    const state = firstString(args, ['state', 'status']) ?? 'open';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => b.seq - a.seq);
    const list = issues.map((issue) => issueJson(forge, repo, issue));
    return { result: toolResult(list) };
  }
  if (name === 'get_issue') {
    const number = numberArg(args, ['issue_number', 'issue', 'number']);
    if (!Number.isInteger(number)) return { error: { code: -32602, message: 'get_issue needs an issue_number' } };
    const issue = repo.issues.get(number);
    if (issue === undefined) return { result: toolError(`Issue #${number} was not found`) };
    return { result: toolResult(issueJson(forge, repo, issue)) };
  }
  if (name === 'close_issue') {
    const number = numberArg(args, ['issue_number', 'issue', 'number']);
    if (!Number.isInteger(number)) return { error: { code: -32602, message: 'close_issue needs an issue_number' } };
    const issue = repo.issues.get(number);
    if (issue === undefined) return { result: toolError(`Issue #${number} was not found`) };
    issue.state = 'closed';
    invalidateIssueText(repo, issue.number);
    return { result: toolResult(issueJson(forge, repo, issue)) };
  }
  if (name === 'create_comment') {
    const number = numberArg(args, ['issue_number', 'issue', 'number']);
    if (!Number.isInteger(number)) return { error: { code: -32602, message: 'create_comment needs an issue_number' } };
    const body = firstString(args, ['body', 'comment_body', 'content', 'text']);
    if (body === null) return { error: { code: -32602, message: 'create_comment needs a body' } };
    const issue = repo.issues.get(number);
    if (issue === undefined) return { result: toolError(`Issue #${number} was not found`) };
    const comment = { id: repo.nextCommentId, body, seq: repo.nextCommentId, userLogin: forge.ownerLoginOf(repo) };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    invalidateIssueText(repo, issue.number);
    return { result: toolResult(commentJson(forge, comment)) };
  }
  if (name === 'get_file_contents') {
    const path = firstString(args, ['path', 'file_path']);
    if (path === null) return { error: { code: -32602, message: 'get_file_contents needs a path' } };
    const ref = firstString(args, ['ref', 'branch', 'sha']);
    const commitOid = ref === null ? (branchTip(repo, 'main') === undefined ? null : repo.peelToCommit(branchTip(repo, 'main')!)) : resolveRefToCommit(repo, ref);
    if (commitOid === null) return { result: toolError(`Ref "${ref ?? 'main'}" was not found`) };
    const flat = repo.flatTree(commitOid);
    const file = flat?.get(path);
    if (file === undefined) return { result: toolError(`Path "${path}" was not found`) };
    const bytes = repo.getObject(file.oid)?.data ?? Buffer.alloc(0);
    return { result: toolResult({ path, sha: file.oid, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }) };
  }
  if (name === 'list_branches') {
    const branches: Array<Record<string, unknown>> = [];
    for (const [ref, oid] of [...repo.refs.entries()].sort()) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
    }
    return { result: toolResult(branches) };
  }
  if (name === 'create_branch') {
    const branch = firstString(args, ['branch', 'branch_name', 'name', 'ref']);
    const sha = firstString(args, ['sha', 'oid', 'commit']);
    if (branch === null || sha === null) return { error: { code: -32602, message: 'create_branch needs a branch and a sha' } };
    const short = branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
    const refName = `refs/heads/${short}`;
    if (!isValidRefName(refName)) return { result: toolError(`Branch "${short}" is not a valid branch name`) };
    const oid = sha.toLowerCase();
    if (repo.getObject(oid) === undefined) return { result: toolError(`Object "${sha}" was not found`) };
    if (repo.refs.has(refName)) return { result: toolError(`Branch "${short}" already exists`) };
    repo.refs.set(refName, oid);
    return { result: toolResult({ ref: refName, object: { sha: oid } }) };
  }
  if (name === 'create_pull_request') {
    const title = firstString(args, ['title', 'pr_title', 'subject']);
    const head = firstString(args, ['head', 'head_ref', 'head_branch', 'source_branch']);
    const base = firstString(args, ['base', 'base_ref', 'base_branch', 'target_branch']);
    if (title === null || head === null || base === null) {
      return { error: { code: -32602, message: 'create_pull_request needs a title, a head and a base' } };
    }
    const body = firstString(args, ['body', 'description', 'content', 'text']) ?? '';
    const headTip = branchTip(repo, head);
    const baseTip = branchTip(repo, base);
    if (headTip === undefined || baseTip === undefined) return { result: toolError('head and base branches must exist') };
    const pull: Pull = {
      id: forge.nextRestId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      seq: repo.nextNumber,
      userLogin: forge.ownerLoginOf(repo),
    };
    forge.nextRestId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return { result: toolResult(pullJson(forge, repo, pull)) };
  }
  if (name === 'merge_pull_request') {
    const number = numberArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number']);
    if (!Number.isInteger(number)) return { error: { code: -32602, message: 'merge_pull_request needs a pull_number' } };
    const pull = repo.pulls.get(number);
    if (pull === undefined) return { result: toolError(`Pull request #${number} was not found`) };
    if (pull.merged) return { result: toolError(`Pull request #${number} has already been merged`) };
    const sha = squashMerge(forge, repo, pull);
    if (sha === null) return { result: toolError(`Pull request #${number} cannot be merged cleanly`) };
    return { result: toolResult(pullJson(forge, repo, pull)) };
  }
  if (name === 'get_pull_request') {
    const number = numberArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number']);
    if (!Number.isInteger(number)) return { error: { code: -32602, message: 'get_pull_request needs a pull_number' } };
    const pull = repo.pulls.get(number);
    if (pull === undefined) return { result: toolError(`Pull request #${number} was not found`) };
    return { result: toolResult(pullJson(forge, repo, pull)) };
  }
  if (name === 'list_pull_requests') {
    const state = firstString(args, ['state', 'status']) ?? 'open';
    let pulls = [...repo.pulls.values()];
    if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
    pulls.sort((a, b) => b.seq - a.seq);
    return { result: toolResult(pulls.map((pull) => pullJson(forge, repo, pull))) };
  }
  return { error: { code: -32602, message: `Unknown tool: ${name}` } };
}

export function handleMcp(forge: Forge, bodyText: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(parsed)) return rpcError(null, -32600, 'Invalid Request', 400);
  const hasId = 'id' in parsed;
  const id = parsed.id ?? null;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};

  // Notifications carry no id and get no JSON-RPC answer.
  if (!hasId) return { status: 202, body: null, empty: true };
  if (method === '') return rpcError(id, -32600, 'Invalid Request: no method');

  if (method === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: REVISION,
      supportedVersions: [REVISION],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
        'io.modelcontextprotocol/protocolVersion': REVISION,
      },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (toolName === '') return rpcError(id, -32602, 'tools/call needs a tool name');
    const outcome = callTool(forge, toolName, args);
    if (outcome.error !== undefined) return rpcError(id, outcome.error.code, outcome.error.message);
    return rpcResult(id, outcome.result);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export { encodeGlobalId };
export type { Repo };
