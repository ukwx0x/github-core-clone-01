// The HTTP server: one Forge, four surfaces (git smart HTTP, REST v3,
// GraphQL, MCP) behind one router. Every reply carries a request id; every
// API call but /healthz needs the trial bearer token; nothing a request does
// can crash the process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { advertisementV0, advertisementV2, GitParseError, handleReceivePack, handleUploadPack, isGitPath } from './gitproto.ts';
import { handleRest, type RestResult } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EMPTY_BODY = Buffer.alloc(0);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) resolve(EMPTY_BODY);
      else if (chunks.length === 1) resolve(chunks[0]!);
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** True when the request headers promise a body. A bodyless request is never read. */
function mayHaveBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  if (length !== undefined) {
    const value = Array.isArray(length) ? length[0] : length;
    if (value !== undefined && Number(value) > 0) return true;
  }
  return req.headers['transfer-encoding'] !== undefined;
}

function readBodyIfAny(req: IncomingMessage): Promise<Buffer> {
  return mayHaveBody(req) ? readBody(req) : Promise.resolve(EMPTY_BODY);
}

export function createApp(): Server {
  const forge = new Forge();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const expectedAuth = expectedToken === '' ? null : `Bearer ${expectedToken}`;
  let requestCount = 0;

  const sendJson = (res: ServerResponse, requestId: string, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': requestId,
      ...extra,
    });
    res.end(text);
  };

  /** Send a pre-serialized JSON body, byte-identical to sendJson of the same value. */
  const sendJsonText = (res: ServerResponse, requestId: string, status: number, bodyText: string, extra: Record<string, string> = {}): void => {
    const text = `${bodyText}\n`;
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': requestId,
      ...extra,
    });
    res.end(text);
  };

  const sendBuffer = (res: ServerResponse, requestId: string, status: number, contentType: string, body: Buffer): void => {
    res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': requestId });
    res.end(body);
  };

  const sendEmpty = (res: ServerResponse, requestId: string, status: number): void => {
    res.writeHead(status, { 'x-github-request-id': requestId });
    res.end();
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCount += 1;
    const requestId = `forge-${requestCount.toString(16).padStart(8, '0')}`;
    void (async () => {
      try {
        await handle(req, res, requestId);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, requestId, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        } else {
          res.end();
        }
      }
    })();
  });

  async function handle(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://entry');
    } catch {
      sendJson(res, requestId, 404, { message: 'Not Found' });
      return;
    }
    const pathname = url.pathname;

    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, requestId, 200, { ok: true });
      return;
    }

    const authorized = (): boolean => {
      if (expectedAuth === null) return true;
      return req.headers.authorization === expectedAuth;
    };

    const deny = (isMcp: boolean): void => {
      if (isMcp) {
        sendJson(res, requestId, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
      } else {
        sendJson(res, requestId, 401, { message: 'Bad credentials' });
      }
    };

    // MCP: POST /mcp speaks JSON-RPC; DELETE ends a legacy session.
    if (pathname === '/mcp') {
      if (method === 'DELETE') {
        sendEmpty(res, requestId, 204);
        return;
      }
      if (method !== 'POST') {
        sendJson(res, requestId, 404, { message: 'Not Found' });
        return;
      }
      if (!authorized()) {
        deny(true);
        return;
      }
      const body = await readBodyIfAny(req);
      const outcome = handleMcp(forge, body.toString('utf8'));
      if (outcome.empty === true) {
        sendEmpty(res, requestId, outcome.status);
        return;
      }
      sendJson(res, requestId, outcome.status, outcome.body);
      return;
    }

    // GraphQL: POST /api/graphql only.
    if (pathname === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(res, requestId, 404, { message: 'Not Found' });
        return;
      }
      if (!authorized()) {
        deny(false);
        return;
      }
      const body = await readBodyIfAny(req);
      const outcome = handleGraphQL(forge, body.toString('utf8'));
      sendJson(res, requestId, outcome.status, outcome.body);
      return;
    }

    // REST v3: /api/v3 and everything under it.
    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      const restPath = pathname.slice('/api/v3'.length);
      const segments = restPath.split('/').filter((segment) => segment !== '').map((segment) => {
        if (!segment.includes('%')) return segment;
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
      const openRoute = segments.length === 0 || (segments.length === 1 && segments[0] === 'meta');
      if (!openRoute && !authorized()) {
        deny(false);
        return;
      }
      const body = await readBodyIfAny(req);
      let json: unknown = null;
      let jsonError = false;
      if (body.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch {
          jsonError = true;
        }
      }
      const outcome: RestResult = handleRest(forge, {
        method,
        segments,
        query: url.searchParams,
        json,
        jsonError,
        host: req.headers.host ?? 'localhost',
        pathname,
      });
      if (outcome.empty === true) {
        sendEmpty(res, requestId, outcome.status);
        return;
      }
      if (outcome.bodyText !== undefined) {
        sendJsonText(res, requestId, outcome.status, outcome.bodyText, outcome.headers ?? {});
        return;
      }
      sendJson(res, requestId, outcome.status, outcome.body, outcome.headers ?? {});
      return;
    }

    // Git smart HTTP: /<owner>/<repo>.git/<service>.
    const git = isGitPath(pathname);
    if (git !== null) {
      if (!authorized()) {
        deny(false);
        return;
      }
      const repo = forge.resolveRepo(git.owner, git.repo);
      if (repo === null) {
        sendJson(res, requestId, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'GET' && git.rest === 'info/refs') {
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, requestId, 404, { message: 'Not Found' });
          return;
        }
        const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
        const body = wantsV2 ? advertisementV2() : advertisementV0(repo, service);
        sendBuffer(res, requestId, 200, `application/x-${service}-advertisement`, body);
        return;
      }
      if (method === 'POST' && git.rest === 'git-upload-pack') {
        const body = await readBody(req);
        try {
          const out = handleUploadPack(repo, body);
          sendBuffer(res, requestId, 200, 'application/x-git-upload-pack-result', out);
        } catch (err) {
          if (err instanceof GitParseError) sendJson(res, requestId, 400, { message: err.message });
          else throw err;
        }
        return;
      }
      if (method === 'POST' && git.rest === 'git-receive-pack') {
        const body = await readBody(req);
        try {
          const out = handleReceivePack(repo, body);
          sendBuffer(res, requestId, 200, 'application/x-git-receive-pack-result', out);
        } catch (err) {
          if (err instanceof GitParseError) sendJson(res, requestId, 400, { message: err.message });
          else throw err;
        }
        return;
      }
      sendJson(res, requestId, 404, { message: 'Not Found' });
      return;
    }

    sendJson(res, requestId, 404, { message: 'Not Found' });
  }
}
