# Contributing

Thanks for helping. v2 is built test-first against a real CAP app, so the setup is short.

## Setup

Requires Node.js 22 or later.

```bash
npm install
npm run check     # typecheck, lint, all tests
npm run demo      # the demo bookshop at http://localhost:4004 (users alice, bob, carol)
```

| Command                  | What it does                                                                |
| ------------------------ | --------------------------------------------------------------------------- |
| `npm test`               | All tests: contract (CDS snippets) and behaviour (the demo app)             |
| `npm run test:contract`  | The fast loop: pure tests over compiled CDS snippets                        |
| `npm run test:behaviour` | `cds.test` against the demo app, over `/mcp`                                |
| `npm run test:coverage`  | All tests with the coverage thresholds CI enforces                          |
| `npm run conformance`    | The official MCP conformance suite against the demo (`npm run build` first) |
| `npm run inspect`        | The MCP Inspector, to try the demo by hand                                  |
| `npm run format:fix`     | Prettier                                                                    |

## How work is done here

- **Test first.** Every change starts with a failing test that demands it.
- **Never mock `@sap/cds`.** Contract tests compile CDS snippets; behaviour tests boot the demo
  app with `cds.test`. ESLint enforces this.
- **The demo app is the fixture.** A new feature gets an annotated target in `demo/` and a row
  in `demo/README.md` before its test.
- **Everything is opt-in, and CAP does the work.** No feature may switch itself on, and no code
  may bypass CAP's services, transactions or authorization.
- **No new runtime dependency** without an architecture decision record.

Read, in this order: [docs/plan.md](docs/plan.md) (why v2 exists),
[docs/architecture.md](docs/architecture.md) (modules and the request path),
[docs/annotations.md](docs/annotations.md) (the annotation contract, which the user guides
follow), [docs/testing.md](docs/testing.md), and the decisions in [docs/adr/](docs/adr/README.md).
[CLAUDE.md](CLAUDE.md) has the same rules in short form.

## Pull requests

Run `npm run check` and `npm run format` before you push. Change the user guides in
`docs/guide/` together with behaviour they describe; `test/contract/docs.test.ts` compiles their
CDS examples and checks their links.

## Releases

Maintainers release from GitHub Actions: the "Release" workflow (`.github/workflows/release.yml`),
run by hand on `main`. It runs release-it (`.release-it.json`): format, typecheck, lint, tests
with coverage, the conformance suite, version bump, build, `npm publish` with provenance, then
commit, tag `vX.Y.Z`, push, and a GitHub release with generated notes.

- The default is a `prerelease` with an id (`alpha`, `beta`, `rc`), published under that npm
  dist-tag. Make the first run a prerelease: release-it publishes before it pushes, so a rejected
  push costs only a prerelease version.
- `patch`, `minor` and `major` publish a stable version as `latest` and need the `stable` box
  ticked. From `2.0.0-alpha.x`, all three give `2.0.0`.

One-time setup, outside this repository:

- Set `repository` in `package.json` to the final GitHub repository (the workflow stops without
  it: npm checks provenance against it).
- On npmjs.com, add a trusted publisher for `@gavdi/cap-mcp` naming that repository and the
  workflow file `release.yml`. There is no `NPM_TOKEN`.
- A deploy key with write access, stored as the `DEPLOY_KEY` secret, so the workflow can push the
  release commit and tag to a protected `main`.

To see what a release would do without doing it, run `npx release-it --dry-run` in a clone with
a git remote and an upstream branch: it shows the commands and does not publish, commit, tag or
push.
