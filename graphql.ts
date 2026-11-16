// A small GraphQL executor: tokenizer, parser, and resolvers over the same
// store REST and git use. No schema library, no code generation: documents are
// parsed, variables are coerced, and unknown fields are reported as GraphQL
// errors with HTTP 200, exactly as the suite expects.

import { decodeGlobalId, encodeCursor, decodeCursor, encodeGlobalId, isValidRefName, type Forge, type Issue, type Pull, type Repo } from './store.ts';
import { branchTip, diffFiles, invalidateIssueText, resolveRefToCommit, squashMerge, tryMergeTrees } from './rest.ts';

// ---------------------------------------------------------------- tokenizer

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
  value: string;
}

class GraphQLError extends Error {}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end === -1) throw new GraphQLError('unterminated block string');
        let value = input.slice(i + 3, end).replace(/\\"""/g, '"""');
        if (value.startsWith('\n')) value = value.slice(1);
        if (value.endsWith('\n')) value = value.slice(0, -1);
        tokens.push({ kind: 'string', value });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < input.length) {
        const c = input[j]!;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\') {
          const esc = input[j + 1]!;
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' }[esc] ?? esc;
            j += 2;
          }
          continue;
        }
        if (c === '\n') throw new GraphQLError('newline in string');
        value += c;
        j += 1;
      }
      if (!closed) throw new GraphQLError('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new GraphQLError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- AST and parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface DirectiveNode {
  name: string;
  args: Record<string, ValueNode>;
}

type SelectionNode =
  | { kind: 'field'; alias: string | null; name: string; args: Record<string, ValueNode>; directives: DirectiveNode[]; selection: SelectionNode[] | null }
  | { kind: 'spread'; name: string; directives: DirectiveNode[] }
  | { kind: 'inline'; typeCondition: string | null; directives: DirectiveNode[]; selection: SelectionNode[] };

interface VarDef {
  name: string;
  defaultValue: ValueNode | null;
}

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: VarDef[];
  selection: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new GraphQLError(`expected ${value}, got ${token.value}`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GraphQLError(`expected a name, got ${token.value}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new GraphQLError('fragment needs "on"');
        const typeCondition = this.expectName();
        const selection = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selection });
        continue;
      }
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, varDefs: [], selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kind = token.value as OperationNode['kind'];
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.parseVarDefs();
        this.parseDirectives();
        operations.push({ kind, name, varDefs, selection: this.parseSelectionSet() });
        continue;
      }
      throw new GraphQLError(`unexpected token ${token.value} at document level`);
    }
    return { operations, fragments };
  }

  private parseVarDefs(): VarDef[] {
    const defs: VarDef[] = [];
    if (!this.skipPunct('(')) return defs;
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseTypeName();
      let defaultValue: ValueNode | null = null;
      if (this.skipPunct('=')) defaultValue = this.parseValue();
      this.parseDirectives();
      defs.push({ name, defaultValue });
    }
    return defs;
  }

  private parseTypeName(): void {
    if (this.skipPunct('[')) {
      this.parseTypeName();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    if (this.peek().kind === 'punct' && this.peek().value === '}') throw new GraphQLError('a selection set must select at least one field');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      if (this.peek().kind === 'eof') throw new GraphQLError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value !== 'on') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const directives = this.parseDirectives();
      const selection = this.parseSelectionSet();
      return { kind: 'inline', typeCondition, directives, selection };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, directives, selection };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (!this.skipPunct('(')) return args;
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      const name = this.expectName();
      const args = this.parseArguments();
      directives.push({ name, args });
    }
    return directives;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'literal', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'literal', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new GraphQLError(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------- values and objects

interface GObj {
  t: string;
  v: unknown;
}

function coerce(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return node.name in variables ? variables[node.name] : null;
    case 'literal':
      return node.value;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => coerce(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = coerce(value, variables);
      return out;
    }
  }
}

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', 'user', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'createRef'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'isFork', 'createdAt', 'updatedAt', 'ref'],
  User: ['login', 'id', 'name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closed', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt', 'author', 'isDraft', 'additions', 'deletions', 'changedFiles'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  CommentConnection: ['nodes', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'pageInfo', 'totalCount'],
  Label: ['id', 'name', 'color'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  Ref: ['name', 'target'],
  Commit: ['oid', 'message'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  ReopenIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  CreateRefPayload: ['ref'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType'],
};

const ENUM_VALUES: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
};

interface PageArgs {
  first: number | null;
  after: string | null;
}

function pageOf<T>(items: readonly T[], args: Record<string, unknown>): { slice: T[]; pageInfo: GObj; total: number } {
  const first = typeof args.first === 'number' ? args.first : null;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  const start = after === null ? 0 : after + 1;
  const end = first === null ? items.length : Math.min(items.length, start + first);
  const slice = items.slice(start, end);
  const endCursor = slice.length === 0 ? null : encodeCursor(start + slice.length - 1);
  const startCursor = slice.length === 0 ? null : encodeCursor(start);
  return {
    slice: [...slice],
    pageInfo: { t: 'PageInfo', v: { hasNextPage: end < items.length, endCursor, hasPreviousPage: start > 0, startCursor } },
    total: items.length,
  };
}

function repoOf(forge: Forge, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const dbId = Number(decoded.parts[0]);
  for (const repo of forge.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

function issueOf(forge: Forge, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const dbId = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  for (const repo of forge.repos.values()) {
    if (repo.dbId !== dbId) continue;
    const issue = repo.issues.get(number);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function pullOf(forge: Forge, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const dbId = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  for (const repo of forge.repos.values()) {
    if (repo.dbId !== dbId) continue;
    const pull = repo.pulls.get(number);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

function issueGObj(repo: Repo, issue: Issue): GObj {
  return { t: 'Issue', v: { repo, issue } };
}

function pullGObj(repo: Repo, pull: Pull): GObj {
  return { t: 'PullRequest', v: { repo, pull } };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// ---------------------------------------------------------------- executor

class Executor {
  readonly errors: Array<{ message: string }> = [];
  private depth = 0;
  private readonly forge: Forge;
  private readonly document: DocumentNode;
  private readonly variables: Record<string, unknown>;

  constructor(forge: Forge, document: DocumentNode, variables: Record<string, unknown>) {
    this.forge = forge;
    this.document = document;
    this.variables = variables;
  }

  execute(operation: OperationNode): Record<string, unknown> {
    const root: GObj = operation.kind === 'mutation' ? { t: 'Mutation', v: null } : { t: 'Query', v: null };
    return this.executeSelectionSet(operation.selection, root);
  }

  private directivesAllow(directives: readonly DirectiveNode[]): boolean {
    for (const directive of directives) {
      const args = this.coerceArgs(directive.args);
      if (directive.name === 'skip' && args.if === true) return false;
      if (directive.name === 'include' && args.if !== true) return false;
    }
    return true;
  }

  private coerceArgs(args: Record<string, ValueNode>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) out[key] = coerce(value, this.variables);
    return out;
  }

  private executeSelectionSet(selections: readonly SelectionNode[], obj: GObj): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.depth > 60) return out;
    this.depth += 1;
    for (const selection of selections) {
      if (selection.kind === 'spread') {
        if (!this.directivesAllow(selection.directives)) continue;
        const fragment = this.document.fragments.get(selection.name);
        if (fragment === undefined) continue;
        if (fragment.typeCondition !== obj.t) continue;
        Object.assign(out, this.executeSelectionSet(fragment.selection, obj));
        continue;
      }
      if (selection.kind === 'inline') {
        if (!this.directivesAllow(selection.directives)) continue;
        if (selection.typeCondition !== null && selection.typeCondition !== obj.t) continue;
        Object.assign(out, this.executeSelectionSet(selection.selection, obj));
        continue;
      }
      if (!this.directivesAllow(selection.directives)) continue;
      const key = selection.alias ?? selection.name;
      out[key] = this.executeField(selection, obj);
    }
    this.depth -= 1;
    return out;
  }

  private executeField(field: Extract<SelectionNode, { kind: 'field' }>, obj: GObj): unknown {
    if (field.name === '__typename') return obj.t;
    const allowed = TYPE_FIELDS[obj.t];
    if (allowed !== undefined && !allowed.includes(field.name)) {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${obj.t}".` });
      return null;
    }
    const args = this.coerceArgs(field.args);
    const value = this.resolve(obj, field.name, args);
    if (field.selection === null || value === null || value === undefined) return value ?? null;
    if (Array.isArray(value)) {
      return value.map((entry) => (entry !== null && typeof entry === 'object' && 't' in (entry as object) ? this.executeSelectionSet(field.selection!, entry as GObj) : entry));
    }
    if (typeof value === 'object' && value !== null && 't' in value) {
      return this.executeSelectionSet(field.selection, value as GObj);
    }
    return value;
  }

  private resolve(obj: GObj, field: string, args: Record<string, unknown>): unknown {
    const forge = this.forge;
    switch (obj.t) {
      case 'Query':
        return this.resolveQuery(field, args);
      case 'Mutation':
        return this.resolveMutation(field, args);
      case 'Repository':
        return this.resolveRepository(obj.v as Repo, field, args);
      case 'User': {
        const login = (obj.v as { login: string }).login;
        if (field === 'login') return login;
        if (field === 'name') return login;
        if (field === 'id') return encodeGlobalId('User', login);
        return null;
      }
      case 'Issue': {
        const { repo, issue } = obj.v as { repo: Repo; issue: Issue };
        if (field === 'id') return encodeGlobalId('Issue', repo.dbId, issue.number);
        if (field === 'number') return issue.number;
        if (field === 'title') return issue.title;
        if (field === 'state') return issueState(issue);
        if (field === 'body') return issue.body;
        if (field === 'createdAt' || field === 'updatedAt') return forge.nowIso;
        if (field === 'closed') return issue.state === 'closed';
        if (field === 'author') return { t: 'User', v: { login: issue.userLogin } };
        if (field === 'comments') {
          const comments = [...issue.comments].sort((a, b) => a.seq - b.seq);
          return { t: 'CommentConnection', v: { page: pageOf(comments, args), repo } };
        }
        if (field === 'labels') {
          const labels = issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' }));
          return { t: 'LabelConnection', v: { page: pageOf(labels, args), repo } };
        }
        return null;
      }
      case 'PullRequest': {
        const { repo, pull } = obj.v as { repo: Repo; pull: Pull };
        if (field === 'id') return encodeGlobalId('PullRequest', repo.dbId, pull.number);
        if (field === 'number') return pull.number;
        if (field === 'title') return pull.title;
        if (field === 'body') return pull.body;
        if (field === 'state') return pullState(pull);
        if (field === 'merged') return pull.merged;
        if (field === 'headRefName') return pull.headRef;
        if (field === 'baseRefName') return pull.baseRef;
        if (field === 'mergeable') return this.mergeable(repo, pull);
        if (field === 'files') return this.pullFiles(repo, pull, args);
        if (field === 'createdAt' || field === 'updatedAt') return forge.nowIso;
        if (field === 'author') return { t: 'User', v: { login: pull.userLogin } };
        if (field === 'isDraft') return false;
        if (field === 'additions' || field === 'deletions' || field === 'changedFiles') {
          const files = this.pullDiffFiles(repo, pull);
          if (field === 'changedFiles') return files.length;
          return files.reduce((sum, file) => sum + (typeof file[field] === 'number' ? (file[field] as number) : 0), 0);
        }
        return null;
      }
      case 'IssueConnection': {
        const conn = obj.v as { page: ReturnType<typeof pageOf<Issue>>; repo: Repo };
        if (field === 'nodes') return conn.page.slice.map((issue) => issueGObj(conn.repo, issue));
        if (field === 'pageInfo') return conn.page.pageInfo;
        if (field === 'totalCount') return conn.page.total;
        return null;
      }
      case 'PullRequestConnection': {
        const conn = obj.v as { page: ReturnType<typeof pageOf<Pull>>; repo: Repo };
        if (field === 'nodes') return conn.page.slice.map((pull) => pullGObj(conn.repo, pull));
        if (field === 'pageInfo') return conn.page.pageInfo;
        if (field === 'totalCount') return conn.page.total;
        return null;
      }
      case 'PullRequestChangedFileConnection': {
        const conn = obj.v as { page: ReturnType<typeof pageOf<Record<string, unknown>>> };
        if (field === 'nodes') return conn.page.slice.map((file) => ({ t: 'PullRequestChangedFile', v: file }));
        if (field === 'pageInfo') return conn.page.pageInfo;
        if (field === 'totalCount') return conn.page.total;
        return null;
      }
      case 'CommentConnection': {
        const conn = obj.v as { page: ReturnType<typeof pageOf<Issue['comments'][number]>>; repo: Repo };
        if (field === 'nodes') {
          return conn.page.slice.map((comment) => ({
            t: 'Comment',
            v: { id: encodeGlobalId('Comment', conn.repo.dbId, comment.id), body: comment.body, userLogin: comment.userLogin },
          }));
        }
        if (field === 'pageInfo') return conn.page.pageInfo;
        if (field === 'totalCount') return conn.page.total;
        return null;
      }
      case 'LabelConnection': {
        const conn = obj.v as { page: ReturnType<typeof pageOf<{ name: string; color: string }>>; repo: Repo };
        if (field === 'nodes') return conn.page.slice.map((label) => ({ t: 'Label', v: { repo: conn.repo, name: label.name, color: label.color } }));
        if (field === 'pageInfo') return conn.page.pageInfo;
        if (field === 'totalCount') return conn.page.total;
        return null;
      }
      case 'Label': {
        const label = obj.v as { repo: Repo; name: string; color: string };
        if (field === 'id') return encodeGlobalId('Label', label.repo.dbId, label.name);
        if (field === 'name') return label.name;
        if (field === 'color') return label.color;
        return null;
      }
      case 'PullRequestChangedFile': {
        const file = obj.v as Record<string, unknown>;
        if (field === 'path') return file.filename ?? '';
        if (field === 'additions') return file.additions ?? 0;
        if (field === 'deletions') return file.deletions ?? 0;
        return null;
      }
      case 'PageInfo': {
        const info = obj.v as Record<string, unknown>;
        return info[field] ?? null;
      }
      case 'Ref': {
        const ref = obj.v as { repo: Repo; name: string; oid?: string };
        if (field === 'name') return ref.name;
        if (field === 'target') {
          const tip = ref.oid ?? ref.repo.refs.get(ref.name) ?? ref.repo.refs.get(`refs/heads/${ref.name}`);
          if (tip === undefined) return null;
          const commitOid = ref.repo.peelToCommit(tip);
          if (commitOid === null) return null;
          const parsed = ref.repo.parseCommit(commitOid);
          return { t: 'Commit', v: { oid: commitOid, message: parsed?.message ?? '' } };
        }
        return null;
      }
      case 'Commit': {
        const commit = obj.v as { oid: string; message: string };
        if (field === 'oid') return commit.oid;
        if (field === 'message') return commit.message;
        return null;
      }
      case 'Comment': {
        const comment = obj.v as { id: string; body: string; userLogin?: string };
        if (field === 'id') return comment.id;
        if (field === 'body') return comment.body;
        if (field === 'author') return { t: 'User', v: { login: comment.userLogin ?? forge.viewerLogin ?? '' } };
        if (field === 'createdAt' || field === 'updatedAt') return forge.nowIso;
        return null;
      }
      case 'CommentEdge': {
        const edge = obj.v as { node: GObj; cursor: string };
        if (field === 'node') return edge.node;
        if (field === 'cursor') return edge.cursor;
        return null;
      }
      case 'CreateIssuePayload':
      case 'CloseIssuePayload':
      case 'ReopenIssuePayload': {
        const payload = obj.v as { repo: Repo; issue: Issue } | null;
        if (field === 'issue' && payload !== null) return issueGObj(payload.repo, payload.issue);
        return null;
      }
      case 'CreateRefPayload': {
        const payload = obj.v as { repo: Repo; name: string; oid: string } | null;
        if (field === 'ref' && payload !== null) return { t: 'Ref', v: { repo: payload.repo, name: payload.name.replace(/^refs\/(heads|tags)\//, ''), oid: payload.oid } };
        return null;
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        const payload = obj.v as { repo: Repo; pull: Pull } | null;
        if (field === 'pullRequest' && payload !== null) return pullGObj(payload.repo, payload.pull);
        return null;
      }
      case 'AddCommentPayload': {
        const payload = obj.v as { node: GObj; cursor: string } | null;
        if (field === 'commentEdge' && payload !== null) return { t: 'CommentEdge', v: payload };
        return null;
      }
      case '__Type': {
        const name = (obj.v as { name: string }).name;
        if (field === 'name') return name;
        if (field === 'kind') return ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT';
        if (field === 'description') return null;
        if (field === 'fields') {
          const fields = TYPE_FIELDS[name];
          if (fields === undefined) return null;
          return fields.map((fieldName) => ({ t: '__Field', v: { name: fieldName } }));
        }
        if (field === 'enumValues') {
          const values = ENUM_VALUES[name];
          if (values === undefined) return null;
          return values.map((value) => ({ t: '__EnumValue', v: { name: value } }));
        }
        return null;
      }
      case '__Field':
      case '__EnumValue': {
        const entry = obj.v as { name: string };
        if (field === 'name') return entry.name;
        if (field === 'description') return null;
        return null;
      }
      case '__Schema':
        if (field === 'queryType') return { t: '__Type', v: { name: 'Query' } };
        if (field === 'mutationType') return { t: '__Type', v: { name: 'Mutation' } };
        return null;
      default:
        return null;
    }
  }

  private resolveQuery(field: string, args: Record<string, unknown>): unknown {
    const forge = this.forge;
    if (field === 'viewer') return { t: 'User', v: { login: forge.viewerLogin ?? '' } };
    if (field === 'user') {
      const login = typeof args.login === 'string' ? args.login : '';
      if (forge.viewerLogin !== null && forge.viewerLogin.toLowerCase() === login.toLowerCase()) {
        return { t: 'User', v: { login: forge.viewerLogin } };
      }
      return null;
    }
    if (field === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = forge.resolveRepo(owner, name);
      return repo === null ? null : { t: 'Repository', v: repo };
    }
    if (field === 'node') {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoOf(forge, id);
        return repo === null ? null : { t: 'Repository', v: repo };
      }
      if (decoded.kind === 'Issue') {
        const found = issueOf(forge, id);
        return found === null ? null : issueGObj(found.repo, found.issue);
      }
      if (decoded.kind === 'PullRequest') {
        const found = pullOf(forge, id);
        return found === null ? null : pullGObj(found.repo, found.pull);
      }
      if (decoded.kind === 'Comment') {
        const dbId = Number(decoded.parts[0]);
        const commentId = Number(decoded.parts[1]);
        for (const repo of forge.repos.values()) {
          if (repo.dbId !== dbId) continue;
          for (const issue of repo.issues.values()) {
            const comment = issue.comments.find((entry) => entry.id === commentId);
            if (comment !== undefined) {
              return { t: 'Comment', v: { id, body: comment.body, userLogin: comment.userLogin } };
            }
          }
        }
        return null;
      }
      if (decoded.kind === 'Label') {
        const dbId = Number(decoded.parts[0]);
        const name = decoded.parts.slice(1).join(':');
        for (const repo of forge.repos.values()) {
          if (repo.dbId !== dbId) continue;
          const label = repo.labels.get(name);
          if (label !== undefined) return { t: 'Label', v: { repo, name: label.name, color: label.color } };
        }
        return null;
      }
      return null;
    }
    if (field === '__type') {
      const name = typeof args.name === 'string' ? args.name : '';
      if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
      return { t: '__Type', v: { name } };
    }
    if (field === '__schema') return { t: '__Schema', v: null };
    return null;
  }

  private resolveRepository(repo: Repo, field: string, args: Record<string, unknown>): unknown {
    const forge = this.forge;
    if (field === 'id') return encodeGlobalId('Repository', repo.dbId);
    if (field === 'databaseId') return repo.dbId;
    if (field === 'name') return repo.name;
    if (field === 'nameWithOwner') {
      const owner = forge.ownerLoginOf(repo);
      return owner === '' ? repo.name : `${owner}/${repo.name}`;
    }
    if (field === 'owner') return { t: 'User', v: { login: forge.ownerLoginOf(repo) } };
    if (field === 'defaultBranchRef') {
      const tip = branchTip(repo, repo.defaultBranch);
      return tip === undefined ? null : { t: 'Ref', v: { repo, name: repo.defaultBranch, oid: tip } };
    }
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'hasIssuesEnabled') return true;
    if (field === 'description') return repo.description;
    if (field === 'isPrivate') return repo.privateFlag;
    if (field === 'isFork') return false;
    if (field === 'createdAt' || field === 'updatedAt') return forge.nowIso;
    if (field === 'ref') {
      const qualifiedName = typeof args.qualifiedName === 'string' ? args.qualifiedName : '';
      const tip = repo.refs.get(qualifiedName) ?? repo.refs.get(`refs/heads/${qualifiedName}`) ?? repo.refs.get(`refs/tags/${qualifiedName}`);
      if (tip === undefined) return null;
      const shortName = qualifiedName.replace(/^refs\/(heads|tags)\//, '');
      return { t: 'Ref', v: { repo, name: shortName, oid: tip } };
    }
    if (field === 'issue') {
      const number = typeof args.number === 'number' ? args.number : -1;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueGObj(repo, issue);
    }
    if (field === 'issues') {
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? args.states.filter((entry): entry is string => typeof entry === 'string') : [];
      if (states.length > 0) {
        const wanted = new Set(states.map((state) => (state === 'CLOSED' ? 'closed' : 'open')));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.orderBy as Record<string, unknown> | undefined;
      const direction = orderBy !== undefined && typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
      issues.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
      return { t: 'IssueConnection', v: { page: pageOf(issues, args), repo } };
    }
    if (field === 'pullRequests') {
      const pulls = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
      return { t: 'PullRequestConnection', v: { page: pageOf(pulls, args), repo } };
    }
    if (field === 'pullRequest') {
      const number = typeof args.number === 'number' ? args.number : -1;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullGObj(repo, pull);
    }
    return null;
  }

  private mergeable(repo: Repo, pull: Pull): string {
    if (pull.state !== 'open') return 'UNKNOWN';
    const baseTip = branchTip(repo, pull.baseRef);
    const headTip = branchTip(repo, pull.headRef);
    if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
    const baseCommit = repo.peelToCommit(baseTip);
    const headCommit = repo.peelToCommit(headTip);
    if (baseCommit === null || headCommit === null) return 'UNKNOWN';
    return tryMergeTrees(repo, baseCommit, headCommit) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  private pullDiffFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
    const baseTip = branchTip(repo, pull.baseRef);
    const headTip = branchTip(repo, pull.headRef);
    if (baseTip === undefined || headTip === undefined) return [];
    const baseCommit = repo.peelToCommit(baseTip);
    const headCommit = repo.peelToCommit(headTip);
    if (baseCommit === null || headCommit === null) return [];
    return diffFiles(repo, baseCommit, headCommit);
  }

  private pullFiles(repo: Repo, pull: Pull, args: Record<string, unknown>): GObj {
    return { t: 'PullRequestChangedFileConnection', v: { page: pageOf(this.pullDiffFiles(repo, pull), args) } };
  }

  private inputOf(args: Record<string, unknown>): Record<string, unknown> {
    return args.input !== null && typeof args.input === 'object' && !Array.isArray(args.input) ? (args.input as Record<string, unknown>) : {};
  }

  private resolveMutation(field: string, args: Record<string, unknown>): unknown {
    const forge = this.forge;
    const input = this.inputOf(args);
    if (field === 'createIssue') {
      const repo = repoOf(forge, input.repositoryId);
      const title = typeof input.title === 'string' ? input.title : '';
      if (repo === null || title === '') {
        this.errors.push({ message: 'createIssue needs a repositoryId and a title' });
        return { t: 'CreateIssuePayload', v: null };
      }
      const issue: Issue = {
        id: forge.nextRestId,
        number: repo.nextNumber,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        seq: repo.nextNumber,
        comments: [],
        userLogin: forge.ownerLoginOf(repo),
      };
      forge.nextRestId += 1;
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return { t: 'CreateIssuePayload', v: { repo, issue } };
    }
    if (field === 'closeIssue') {
      const found = issueOf(forge, input.issueId);
      if (found === null) {
        this.errors.push({ message: 'closeIssue needs an issueId that exists' });
        return { t: 'CloseIssuePayload', v: null };
      }
      found.issue.state = 'closed';
      invalidateIssueText(found.repo, found.issue.number);
      return { t: 'CloseIssuePayload', v: found };
    }
    if (field === 'reopenIssue') {
      const found = issueOf(forge, input.issueId);
      if (found === null) {
        this.errors.push({ message: 'reopenIssue needs an issueId that exists' });
        return { t: 'ReopenIssuePayload', v: null };
      }
      found.issue.state = 'open';
      invalidateIssueText(found.repo, found.issue.number);
      return { t: 'ReopenIssuePayload', v: found };
    }
    if (field === 'createRef') {
      const repo = repoOf(forge, input.repositoryId);
      const name = typeof input.name === 'string' ? input.name : '';
      const oid = typeof input.oid === 'string' ? input.oid.toLowerCase() : '';
      if (repo === null || !isValidRefName(name) || oid === '' || repo.getObject(oid) === undefined) {
        this.errors.push({ message: 'createRef needs a repositoryId, a valid refs/ name, and an oid that exists' });
        return { t: 'CreateRefPayload', v: null };
      }
      if (repo.refs.has(name)) {
        this.errors.push({ message: 'createRef names a ref that already exists' });
        return { t: 'CreateRefPayload', v: null };
      }
      repo.refs.set(name, oid);
      return { t: 'CreateRefPayload', v: { repo, name, oid } };
    }
    if (field === 'createPullRequest') {
      const repo = repoOf(forge, input.repositoryId);
      const title = typeof input.title === 'string' ? input.title : '';
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headTip = repo === null || headRef === '' ? undefined : branchTip(repo, headRef);
      const baseTip = repo === null || baseRef === '' ? undefined : branchTip(repo, baseRef);
      if (repo === null || title === '' || headTip === undefined || baseTip === undefined) {
        this.errors.push({ message: 'createPullRequest needs a repositoryId, a title, and existing head and base branches' });
        return { t: 'CreatePullRequestPayload', v: null };
      }
      const pull: Pull = {
        id: forge.nextRestId,
        number: repo.nextNumber,
        title,
        body: typeof input.body === 'string' ? input.body : '',
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
      return { t: 'CreatePullRequestPayload', v: { repo, pull } };
    }
    if (field === 'mergePullRequest') {
      const found = pullOf(forge, input.pullRequestId);
      if (found === null) {
        this.errors.push({ message: 'mergePullRequest needs a pullRequestId that exists' });
        return { t: 'MergePullRequestPayload', v: null };
      }
      if (!found.pull.merged) {
        const sha = squashMerge(forge, found.repo, found.pull);
        if (sha === null) {
          this.errors.push({ message: 'the pull request cannot be merged cleanly' });
          return { t: 'MergePullRequestPayload', v: found };
        }
      }
      return { t: 'MergePullRequestPayload', v: found };
    }
    if (field === 'addComment') {
      const found = issueOf(forge, input.subjectId);
      const body = typeof input.body === 'string' ? input.body : '';
      if (found === null || body === '') {
        this.errors.push({ message: 'addComment needs a subjectId that exists and a body' });
        return { t: 'AddCommentPayload', v: null };
      }
      const comment = { id: found.repo.nextCommentId, body, seq: found.repo.nextCommentId, userLogin: forge.ownerLoginOf(found.repo) };
      found.repo.nextCommentId += 1;
      found.issue.comments.push(comment);
      invalidateIssueText(found.repo, found.issue.number);
      const globalId = encodeGlobalId('Comment', found.repo.dbId, comment.id);
      return { t: 'AddCommentPayload', v: { node: { t: 'Comment', v: { id: globalId, body, userLogin: comment.userLogin } }, cursor: encodeCursor(comment.seq) } };
    }
    return null;
  }
}

export interface GraphQLResult {
  status: number;
  body: unknown;
}

function runOperation(forge: Forge, payload: Record<string, unknown>): Record<string, unknown> {
  const query = typeof payload.query === 'string' ? payload.query : '';
  if (query === '') return { data: null, errors: [{ message: 'query is required' }] };
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const operationName = typeof payload.operationName === 'string' ? payload.operationName : null;
  let operation = document.operations[0] ?? null;
  if (operationName !== null) operation = document.operations.find((candidate) => candidate.name === operationName) ?? null;
  if (operation === null) return { data: null, errors: [{ message: 'no operation to run' }] };
  const provided = payload.variables !== null && typeof payload.variables === 'object' && !Array.isArray(payload.variables) ? (payload.variables as Record<string, unknown>) : {};
  const variables: Record<string, unknown> = {};
  for (const varDef of operation.varDefs) {
    if (varDef.name in provided) variables[varDef.name] = provided[varDef.name];
    else if (varDef.defaultValue !== null) variables[varDef.name] = coerce(varDef.defaultValue, provided);
  }
  for (const [key, value] of Object.entries(provided)) variables[key] = value;
  const executor = new Executor(forge, document, variables);
  const data = executor.execute(operation);
  if (executor.errors.length > 0) return { data, errors: executor.errors };
  return { data };
}

export function handleGraphQL(forge: Forge, bodyText: string): GraphQLResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { message: 'Malformed JSON in request body' } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => (entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? runOperation(forge, entry as Record<string, unknown>) : { data: null, errors: [{ message: 'each batch entry must be an object' }] }));
    return { status: 200, body: results };
  }
  if (parsed !== null && typeof parsed === 'object') {
    return { status: 200, body: runOperation(forge, parsed as Record<string, unknown>) };
  }
  return { status: 400, body: { message: 'A GraphQL request body must be a JSON object or an array' } };
}

export { resolveRefToCommit };
