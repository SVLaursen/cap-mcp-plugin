# 0017 — Skills in the hint context

Status: accepted · 2026-11-25 (the maintainer chose this option among three, then accepted the ADR as written after the block review)

## Context

cap-okf (ADR 0013, 0014) informs agents about the app through `mcp:resources` (its documents)
and `mcp:hints` (lines in the server instructions and notes on tool descriptions). With Skills
over MCP (ADR 0016) an app also serves skills, and cap-okf should be able to inform agents
about those too: which skill fits a task, and which of its documents belong to a skill.

A skill itself cannot carry that information. The Skills specification requires a skill
entry's `frontmatter` to be identical to its `SKILL.md`, and hosts bind a user's approval to
the digest of every file, so neither the description nor the content may be changed per
caller or by another plugin. Three options were put to the maintainer:

1. **Skills in the hint context**: `mcp:hints` providers learn which skills are served, and
   point agents at them from the places agents already read (instructions, tool notes).
2. **Skill notes in `_meta`**: a new provider kind whose text goes into each skill entry's
   `_meta`, which the specification allows; but hosts and agents may ignore `_meta`.
3. Both.

The maintainer chose option 1.

## Decision

`HintContext`, the context every `mcp:hints` provider gets, gains `skills`: the skills this
request serves, as `{ uri, name, description }` (the `SKILL.md` URI and its frontmatter `name`
and `description`), sorted by URI.

```ts
interface HintContext {
  user: unknown;
  tenant?: string;
  locale?: string;
  /** The skills served (ADR 0016); empty without `cds.mcp.skills`. */
  skills: readonly HintSkill[];
}

interface HintSkill {
  uri: string; // e.g. "skill://handle-return/SKILL.md"
  name: string;
  description: string;
}
```

- **Additive.** Contract version 1 stays: listeners and providers written for ADR 0014 work
  unchanged. Without `cds.mcp.skills` the list is empty, so a provider never has to test for
  `undefined`.
- **The same for every caller.** One catalog serves every caller the endpoint lets in (ADR
  0016), so the list is built once at startup, frozen, and shared by every request. Providers
  still get user, tenant and locale to decide what to say to whom.
- **Read-only.** Providers cannot add, hide or change skills through it; the catalog is the
  app's (ADR 0016: no `mcp:skills` event in 2.0). What a provider writes about a skill is
  plain text in the instructions or a tool note, under the existing limits (1,500 and 400
  characters) and error handling of ADR 0014.
- **No new output.** Nothing reaches a client unless a provider writes it, so with no provider,
  or a provider that ignores `skills`, `/mcp` is byte for byte as before.

## Alternatives considered

- **Notes in a skill entry's `_meta`** (option 2): allowed by the specification and leaves the
  skill intact, but `_meta` is not model context for most hosts, so an agent would seldom see
  it. Can be added later as a new provider kind without changing this one.
- **Notes appended to the `SKILL.md` description in `resources/list`**: the specification says
  that description SHOULD come from the frontmatter, and a host that compares the two would
  see a mismatch. Rejected.
- **A `skills` argument only for a new provider kind**: would leave instructions and tool
  notes, where agents already look, without the information.

## Consequences

- `HintContext` and the new `HintSkill` type are part of the exported contract
  (docs/annotations.md); `contractVersion` stays 1. The change is additive at runtime: a
  provider written for ADR 0014 gets one more property and works unchanged. At the type level
  `skills` is required, so TypeScript code that builds a `HintContext` itself (a provider's own
  unit test) must add `skills: []`; this ships in 2.0 with ADR 0014, so no released contract
  breaks.
- The list is a snapshot of the catalog at startup. That holds while the catalog is static
  (ADR 0016: no reload in 2.0); wiring up `reload()` must rebuild it.
- The adapter keeps one frozen list per activation, from the catalog's entries.
- A provider that names a skill which is not served writes text pointing nowhere; checking
  `ctx.skills` first avoids that, and the docs say so.
