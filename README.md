# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ukwx0x/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ukwx0x/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one process: git smart HTTP (protocol v0 and v2, fetch and push), REST v3 repositories, branches, commits, contents, issues, labels and pull requests, a GraphQL endpoint, and an MCP endpoint. Standard library only, no dependencies, no model calls. All state is in memory and all timestamps come from the trial clock, so runs replay identically.

## Run it

```sh
node --experimental-strip-types main.ts
```

The trial runs `node /bot/main.ts` on Node 22.18 or later with `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` set. The server binds an ephemeral port, registers it with the env, and exits once the env reports the trial is done.

## Layout

- `main.ts`: the entry lifecycle, bind, register, wait for done.
- `app.ts`: the HTTP router, auth, and request ids.
- `store.ts`: the in-memory object store, repositories, issues, pull requests, merges and diffs.
- `gitproto.ts`: pkt-lines, packfiles, fetch selection, upload-pack and receive-pack.
- `rest.ts`: the REST v3 surface.
- `graphql.ts`: the GraphQL parser and executor.
- `mcp.ts`: the MCP endpoint and its fifteen tools.

---

Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
