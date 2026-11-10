---
name: next-task
description: Pick up the next open task from docs/backlog.md and complete it end to end (TDD, check, tick, commit). Use when asked to continue v2 development, work on the backlog, or "do the next task".
---

# Next task

1. **Orient.** Run `git status` and `git log --oneline -5`. If there are uncommitted changes,
   finish or explain them before starting something new. Run `npm test` to confirm the starting
   point is green.
2. **Choose.** Open `docs/backlog.md`. Take the first unticked task in the earliest milestone
   that is not finished. Skip tasks marked _(parallel)_ only if told to.
3. **Understand.** Read the test file the task names, the module stub it touches (its header
   comment is the contract), and the relevant section of `docs/annotations.md` or
   `docs/architecture.md`. For behaviour tasks, check the demo target in `demo/README.md`.
4. **If it is a SPIKE:** investigate (read CAP/SDK source in `node_modules`, write throwaway
   experiments under `_spike/`, which is git-ignored), write the ADR in `docs/adr/`, update `docs/adr/README.md`, add the
   resulting tasks to the backlog, tick the spike. No production code.
5. **Otherwise:** follow the `tdd` skill for each todo the task covers, one at a time.
6. **Check.** `npm run check` green. Update docs if behaviour, annotations or `src/types.ts`
   changed.
7. **Tick and commit.** Tick the task in `docs/backlog.md`; commit with `M<n>: <task>`.
8. **Milestone done?** If that was the last task of the milestone, run the `reviewer` agent on
   `git diff <milestone-start>..HEAD`, fix what it finds (test-first), and report the milestone
   as complete.
9. **Report** in two or three sentences: what changed, what the next task is, and anything
   that needs a human decision.

Stop and ask instead of guessing when:

- a task needs a product decision not covered by `docs/plan.md`, `docs/annotations.md` or an ADR;
- making a test pass would break a rule in CLAUDE.md;
- the MCP spec, SDK or CAP behaves differently from what the docs here say (update the docs in
  the same change once confirmed).
