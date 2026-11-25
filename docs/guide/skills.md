# Skills

Your tools say what each one does. A skill says how to do a task with them: which tools, in
which order, what to read first, what to check before answering. Agents that support the
[Skills extension](https://skills.extensions.modelcontextprotocol.io/specification/beta/skills)
list your skills, and load one when a request matches its description. Agents without it see
the skill files as ordinary resources.

Skills are opt-in: nothing is served until you name a folder.

## Turn them on

Put one folder per skill in a folder of your app, and name that folder in the config:

```json
{ "cds": { "mcp": { "skills": "mcp-skills" } } }
```

```
mcp-skills/
  handle-return/
    SKILL.md
    references/
      checklist.md
```

Restart the app. The startup report lists what is served:

```
[mcp] - skills (cds.mcp.skills): 1 skill (skill://handle-return/SKILL.md)
```

The folder must be inside the app root, and not the app root itself. Skills are read once at
startup: after a change, restart. `cds build` copies the served skills to `gen/srv/<folder>`,
so the deployed app serves the same ones.

## Write a skill

A skill is a folder with a `SKILL.md`. The file starts with YAML frontmatter, then the
instructions in Markdown:

```markdown
---
name: handle-return
description: Handle a customer's request to return or cancel a bookshop order. Use when someone asks to send back, return or cancel an order, or asks whether a return is possible.
---

# Handle a return

1. Read `notes://bookshop/returns-policy.md` first: it says which orders can be returned and how.
2. Find the order with `OrdersService_Orders_query` (filter by `orderNo`), or read it with
   `OrdersService_Orders_get` when you have its ID. If the result says your authorization
   limits which orders you can see, say so rather than that the order does not exist.
3. Check whether a return was already logged with `OrdersService_Returns_query` (support and
   admin only).
4. An order that was not delivered yet is cancelled with `OrdersService_Orders_cancel`; the
   user is asked to confirm, so explain what will happen first.
5. Go through references/checklist.md before you answer.
```

This is the demo's skill (`demo/mcp-skills/handle-return/`); there, the last step links the
checklist with a relative Markdown link, which agents can follow.

### The frontmatter

| Field           | Rule                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------- |
| `name`          | Required. 1–64 lowercase letters, digits and single hyphens, and exactly the folder's name   |
| `description`   | Required. 1–1024 characters                                                                  |
| `compatibility` | Optional. At most 500 characters, e.g. which clients or app version the skill is written for |

Other fields are passed on to clients as they are. A skill that breaks a rule is not served;
the startup report says why (`INVALID_SKILL`, see [Troubleshooting](troubleshooting.md#a-skill-is-missing)).

### The description decides when it is used

Agents read the descriptions of all skills up front and load a skill's `SKILL.md` only when a
request matches. Write the description for that choice:

- Say what the skill does and when to use it, in the words a user would use ("return",
  "send back", "cancel"), not your entity names.
- Keep it to one or two sentences. Everything else goes in the body.
- Give each skill one task. Two tasks in one description make both harder to match.

### The body

- **Name the tools exactly**, as `tools/list` shows them (`OrdersService_Orders_query`). The
  agent calls what you name. Tool names are `<Service>_<Entity>_<mode>` and
  `<Service>_<operation>` ([tool names](troubleshooting.md#a-tool-is-missing)).
- **Name resources by URI**: `notes://…` documents your app registers through `mcp:resources`,
  or `cap://<Service>/<Entity>/<key>` records. Say when to read them.
- **Steps, in order.** Short numbered steps work better than prose. Say what to do when a step
  finds nothing.
- **Say what the tools cannot.** If a read can be filtered by authorization, say how to answer
  then (the plugin's filtered-read notice helps, see [production](production.md)). If a tool
  asks the user to confirm (`@mcp.elicit`), tell the agent to explain first.
- **Keep `SKILL.md` short.** Put long material (checklists, tables, examples) in other files of
  the skill and link them with relative links (`references/checklist.md`). Agents read those
  only when they need them.

### Files and limits

Every file in the skill folder is served, as `skill://<skill>/<path>`, and listed with a
digest in the skill's entry. Hosts check each file against its digest and tie a user's approval
of the skill to them.

- At most 512 files and 16 MiB per skill. A skill over either is not served.
- No symlinks: copy the file in. A skill with a symlink is not served.
- Files whose names start with `.` are ignored.
- A skill may contain another skill (a folder with its own `SKILL.md`); its files count towards
  the outer skill too.

## Who sees skills

Every caller the endpoint lets in sees the same skills, anonymous callers included where CAP
lets them in (in production CAP's own login applies first). There is no per-role visibility.

Skills are instructions, not authorization. A skill that mentions an admin-only tool does not
give anyone access to it: the tool is not in that caller's `tools/list`, and CAP checks every
call. Still, write nothing in a skill that a caller of `/mcp` may not read.

## Test a skill

1. Start the app (`npm run demo` for the demo) and check the startup report lists the skill.
2. In the [MCP Inspector](getting-started.md) or your client, list resources: each skill's
   `SKILL.md` is there. Clients with the Skills extension also show it in their skills list.
3. Ask the agent something the description should match, and watch which tools it calls.
4. If it picks the wrong skill or none, sharpen the description first, then the steps.
