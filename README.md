# omp-autoclassifier

A model-backed risk classifier for [omp](https://omp.sh). Before any tool call runs, a small review
model inspects it. The classifier blocks the calls that model judges dangerous.

omp's own controls are deterministic:

- approval tiers
- `tools.approval` policies
- `bash.patterns`

omp's advisor reads the transcript only after the fact, so it cannot stop a call. This plugin adds the
missing piece, the equivalent of Claude Code's auto mode or Codex's auto-review. It runs **ahead of the
approval gate in every approval mode**, including `yolo`.

## Install

```sh
omp plugin install omp-autoclassifier
```

Then choose the model that reviews each call:

```
/autoclassifier setup
```

Setup ranks the models you already authenticated and prefers whatever you bound to the `smol` or `tiny`
roles. Your pick goes to `modelRoles.classifier`. Until a classifier role exists, the gate stays
inactive and says so at startup. It never borrows the session model, because a frontier model on every
tool call would cost more than the work it reviews.

After installing, restart the session. omp does not hot-reload extension modules.

## How a decision is reached

```
kill switch  ->  disabled  ->  hardDeny  ->  inactive mode  ->  paused  ->
deny  ->  allow  ->  cached allow  ->  ask  ->  classifier
```

First match wins. A call that matches no rule reaches the classifier, which runs in two stages: a
five-token filter that can only say "routine" or "look closer", then a JSON verdict for anything the
filter flags. The filter cannot deny on its own.

Two orderings are deliberate:

- **`hardDeny` outranks the mode filter and the breaker.** Anti-tamper stays in force even while the
  gate is paused, so the agent cannot disable the gate during the one window nothing is watching.
- **The kill switch outranks everything, anti-tamper included.** It is the documented way out of a
  lockout, so it has to be total.

### The gate fails closed

A classifier that times out, errors, loses its credentials, or returns an unparseable verdict **blocks
the call**. The status line shows a degraded state and one notification fires per session.

That trade is deliberate. A gate that allowed on failure would be decorative, since any
attacker able to break the classifier would also be able to bypass it. If a broken classifier locks
you out, use a kill switch below.

## Rules

Four lists, checked in the order `hardDeny`, `deny`, `ask`, `allow`. Patterns take the form `tool` or
`tool(pattern)`, where `*` is the only wildcard and spans `/`:

```yaml
# ~/.omp/agent/autoclassifier.yml
rules:
  deny:
    - "bash(*git push --force*)"
    - "bash(*rm -rf /*)"
  ask:
    - "github(pr_create)"
  allow:
    - "$defaults"
    - "bash(bun test*)"
```

`$defaults` expands to the shipped list in place, so adding one rule keeps the rest. **A list that
omits `$defaults` replaces the shipped defaults outright.**

Path rules resolve `~`, relative spellings, `..` segments, and symlinks before comparing, so none of
those spellings evades a rule. A rule on a directory covers files that do not exist yet.

For a multi-file `edit`, a deny fires when **any** target matches, while an allow requires **every**
target to match. A patch touching one allowlisted file and one protected file does not slip through on
the strength of the innocent half.

### What the shipped allowlist covers

Only tools omp itself classes as unconditionally read-only: `read`, `grep`, `glob`, `todo`, `recall`,
`reflect`, `web_search`, `inspect_image`, `ast_grep`, `ask`, and the read-only `lsp` actions.

Deliberately absent, because each leaves durable state behind even though omp tiers it `read`:

| Tool | Why it reaches the classifier |
| --- | --- |
| `learn` | Writes long-term memory and can mint a managed `SKILL.md` |
| `retain` | Writes long-term memory |
| `memory_edit` | Can permanently delete stored memories |
| `checkpoint`, `rewind` | Mutate git-backed session state |
| `security_scan` | Ships workspace code to a cloud client |

A `ssh://` target disqualifies every allowlist entry, because omp promotes such a call to `exec` tier:
`read ssh://host/etc/passwd` runs on another machine. Write `read(ssh://*)` explicitly if you want it
allowed anyway.

The shipped `hardDeny` list is **anti-tamper only**. It protects this plugin's configuration, omp's
settings, and the plugins directory. Everything else destructive goes to the classifier, which is
coherent only because failure blocks.

## Configuration

Two stores, because omp's plugin settings accept scalars only.

**Scalars** live in plugin settings, visible in `/settings` under Plugins:

```sh
omp plugin config set omp-autoclassifier escalate true
omp plugin config list omp-autoclassifier
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Main switch |
| `activeModes` | `yolo,write,always-ask` | Approval modes the gate runs in |
| `escalate` | `false` | Prompt instead of blocking, in interactive sessions |
| `classifySubagents` | `true` | Classify calls inside spawned subagents |
| `stage1TimeoutMs` | `4000` | Filter stage timeout |
| `stage2TimeoutMs` | `10000` | Review stage timeout |
| `maxConsecutiveDenials` | `3` | Consecutive blocks before the breaker pauses the gate |
| `maxTotalDenials` | `20` | Total blocks per session before the breaker pauses the gate |
| `cacheSize` | `500` | Cached allow verdicts per session |
| `includeToolResults` | `false` | Feed recent tool output to the classifier as untrusted evidence |
| `logDecisions` | `true` | Append decisions to the JSONL audit log |
| `logClassifierIo` | `false` | Also log prompts and responses. May capture secrets. |

**Lists and prose** live in `autoclassifier.yml`:

```yaml
rules: { hardDeny: [...], deny: [...], ask: [...], allow: [...] }
environment:
  - "$defaults"
  - "This repository never deploys from a developer machine."
evidence:
  maxUserMessages: 6
  maxCharsPerMessage: 2000
log:
  path: null
```

Precedence, highest first: project YAML, user YAML, project `plugin-overrides.json`, plugin lockfile,
shipped defaults. Run `/autoclassifier config` to see the winning value and its origin for every key,
which is the fastest way to settle "why is this setting being ignored".

Edits to `autoclassifier.yml` take effect within about two seconds, with no restart.

## Escalation

With `escalate: true` a would-be block becomes a prompt in interactive sessions: allow once, deny, or
allow for the rest of the session. A canceled prompt counts as a denial. So does a prompt that times out or cannot open.
`hardDeny` never escalates.

## Subagents

Subagents run headless, so no prompt can reach anyone. The policy there is stricter: an `ask` outcome
becomes a block, and no prompt can lift a classifier denial. The gate reports every subagent
denial to the interactive sessions in the process, since a block buried in a subagent transcript would
otherwise go unnoticed.

## Circuit breaker

After 3 consecutive or 20 total blocks in a session, the gate pauses itself, allows everything, and
says so in the status line. Re-arm it with `/autoclassifier resume`.

The breaker exists because fail-closed has a failure mode of its own: one broken classifier otherwise
turns every call into a block, and the agent burns the session retrying. Resuming stays manual, since
an automatic re-arm would walk straight back into the same wall.

## Kill switches

Layered, because a fail-closed gate can lock you out:

| Scope | Action |
| --- | --- |
| This session | `/autoclassifier off` |
| This process | Start omp with `OMP_AUTOCLASSIFIER_DISABLE=1` |
| Persistent | `omp plugin disable omp-autoclassifier` |

Slash commands and environment variables are not tool calls, so the gate can never block them. The
agent is hard-denied from touching any of the three.

## Audit log

One JSON object per decision at `<agentDir>/autoclassifier/decisions.jsonl`:

```json
{"timestamp":"2026-08-24T10:00:00.000Z","toolName":"bash","decision":"block","via":"classifier","risk":"high","stage":2,"reason":"Appends a key to authorized_keys.","hasUI":true}
```

Read the recent entries with `/autoclassifier denials` or `/autoclassifier log`. When the gate cannot write the log, it drops the log rather than the gate.

## What this is not

A model gate is not a sandbox. It reduces the blast radius of a confused or manipulated agent. It does
not contain a determined attacker who already controls the model's input, and the classifier itself
reads attacker-influenced text. Two mitigations follow from that:

- Evidence excludes assistant prose and tool output by default. The user's own messages are the
  authorization record.
- `includeToolResults` wraps opted-in output in a delimited untrusted block, strips that delimiter from
  the content, and tells the classifier to treat the contents as data.

Keep real isolation where it belongs: containers, credentials scoped to the job, and backups.

## Development

```sh
bun install
bun run check        # tsc --noEmit
bun test             # unit suite
bun run test:mutate  # mutation harness
bun run verify       # all three
```

The mutation harness breaks one behavior at a time and requires the test that owns it to fail. A test
that survives its mutation is a test gap, not a passing implementation.

## License

Apache-2.0
