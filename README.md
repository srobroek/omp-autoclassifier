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

### What the verdict reports

The second stage answers with a decision and the axes it turned on. That makes a refusal auditable, and
lets the prompt be tuned against evidence rather than taste:

| Field | Values | Why it is there |
| --- | --- | --- |
| `decision` | `allow` / `ask` / `deny` | `ask` means a human should choose. With `escalate: false`, the default, it blocks. |
| `risk` | `low` / `medium` / `high` | Severity if the call is wrong. |
| `category` | `none` / `destruction` / `credentials` / `control` / `persistence` / `external` | Which kind of harm. `none` is ordinary work and always allowed. |
| `authorization` | `explicit` / `implied` / `absent` / `revoked` | What the user's own messages authorized. Nothing else can authorize anything. |
| `reversibility` | `reversible` / `recoverable` / `irreversible` | A better predictor of harm than `risk`: `rm -rf dist` and a force-push over someone's commits are both "high", and only one is unrecoverable. |
| `scope` | `file` / `worktree` / `machine` / `shared` / `third-party` | How far the effect reaches. Separates `rm -rf dist` from `rm -rf ~`. |
| `confidence` | `low` / `medium` / `high` | A stated low confidence on a harmful category becomes an `ask` rather than an allow. |
| `injectionSuspected` | boolean | Set when the evidence itself tried to authorize the call. Never allowed, always logged. |
| `alternative` | string | A safer command reaching the same goal. Only requested when `suggestAlternative: true`, because it costs tokens on every review. |

### Two readers, two shapes

The gate reports every refusal twice, because an agent and a person need different things from it.

The **agent** gets JSON as the tool error on every denial: rule blocks, judged blocks, and locks alike.
One shape, so anything reading a refusal never has to work out which kind it got:

```json
{
  "autoclassifier": "blocked",
  "tool": "bash",
  "target": "git reset --hard origin/main",
  "category": "destruction",
  "authorization": "absent",
  "risk": "high",
  "reversibility": "irreversible",
  "scope": "shared",
  "why": "Rewrites history other people have pulled.",
  "next": "Do something materially safer that reaches the same goal, or tell the user the risk and ask them for this specific action.",
  "notThis": "Rewording this call, splitting it across calls, or handing it to a subagent.",
  "otherwise": "Carry on with anything that does not depend on this.",
  "warning": "2 more consecutive refusals locks this session..."
}
```

`next` stays a sentence on purpose. The structure is for finding the fields. The instruction is still the
thing the agent has to act on.

The user gets one line, as a notification:

```
autoclassifier blocked `bash` on git reset --hard origin/main (destruction): Rewrites history other people have pulled.
```

Sending both readers the same string served neither: the fielded form is noise in a toast, and a one-liner
leaves an agent guessing which axis refused it. The user's line carries no `next`, because the agent's
moves are not theirs to take.

### A refused call stays refused

The gate never caches a denial, so authorization you give in chat takes effect at once. The cost: the
agent can ask again in different words. A measured run rode exactly that. The gate refused a
subagent spawn, the agent reworded it until a fresh review passed it, and the child ran the command the
parent could not. Each review was correct in isolation.

So the gate remembers its refusals. Every later review in the session sees what it already refused. It
also states the rule: rewording a request, splitting it across calls, or handing it to a subagent does
not make it a new request. Sessions that start later inherit those refusals, which is what carries them
across the subagent boundary. A subagent's own gate starts empty. Only your own messages lift a
refusal, and only for the action they name.

Three related guards sit in the review itself:

- **Silence is not agreement.** Earlier calls going through says nothing about this one, because watching
  and not having looked are indistinguishable from inside a transcript.
- **A refusal by this gate is not you rejecting anything**, so it does not compound. A call *you* stopped
  or refused does stay refused.
- **Agreement to a preparatory step does not carry to the step that ships its result.** Approving a
  rename or a config write is not approving the push that publishes it.

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

### What the shipped hardDeny list covers

Anti-tamper only. It protects this plugin's configuration, omp's settings, the plugins directory, and one
thing that is easy to overlook: **the session transcript**.

A resumed session reads its transcript back as the record of what you authorized. A line shaped like a
user message therefore becomes user intent for that session's reviews. It does not reach the running session, because
`getBranch()` walks an in-memory index and the journal is written from memory rather than read back, so
the threat is deferred rather than live. Writes are refused; reads are not, since omp's own history
tooling depends on them.

Everything else destructive goes to the classifier. That holds together only because a failure blocks.

### What the shipped ask list covers

History rewriting, and nothing else: `filter-branch`, `filter-repo`, `bfg`, `rebase --root`.

Here a pattern beat judgement on measurement. The classifier reads them as the
ordinary means to a fair end, and allowed `git filter-branch --force` on the strength of "remove the
large binary from the repo". A prompt fix for that cost five refusals of work the user had plainly asked
for, because narrowing what an implied authorization reaches also narrowed what the model would call
explicit. A pattern has no such blast radius.

`ask` rather than `deny`, because rewriting history is legitimate, most often to expunge a leaked
secret. It just needs the person who owns the branch to say so.

`push --force` is deliberately **not** listed. A rule fires before the classifier. Listing it would
refuse a force-push you asked for in plain words, without the model ever reading the request.

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
| `suggestAlternative` | `false` | Ask the review stage for a safer command when it refuses one. Costs tokens on every review. |
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

## Two breakers, opposite directions

A run of refusals looks identical to a run of classifier failures, because both block. What each must
cost is opposite, so the gate counts them apart.

**Failures pause.** After 3 failures in a row, or 20 in a session, the gate pauses itself, allows
everything, and says so in the status line. Fail-closed has a failure mode of its own: one unreachable
classifier otherwise turns every call into a block and the agent burns the session retrying. Resuming
stays manual, since an automatic re-arm walks back into the same wall.

**Refusals lock.** After 3 consecutive refusals the session locks: every tool call is refused, reads
included, until you run `/autoclassifier resume`. An allowed call in between clears the run. The agent is
told the count on every refusal, and told plainly when the lock closes.

A lock outranks a pause when both hold. A pause is convenience for a broken reviewer; a lock is a
judgement about the agent, and convenience does not overrule judgement.

Both numbers come from `maxConsecutiveDenials` and `maxTotalDenials`.

### Why refusals lock instead of pausing

One counter drove both at first, on the reasoning that the agent cannot tell the two apart. That put
refusals on the pause path, so **three refused calls switched the gate off** and let everything through.
Any agent that noticed could spend three calls to buy an unsupervised session, and warning it about the
threshold would have published the recipe.

Separating them inverts that. Persisting now costs the session rather than buying it, which is also what
makes the countdown safe to state: an agent racing toward a lock gains nothing by arriving.

## Kill switches

Layered, because a fail-closed gate can stop a session:

| Scope | Action |
| --- | --- |
| A locked session | `/autoclassifier resume` |
| This session | `/autoclassifier off` |
| This process | Start omp with `OMP_AUTOCLASSIFIER_DISABLE=1` |
| Persistent | `omp plugin disable omp-autoclassifier` |

Slash commands and environment variables are not tool calls, so the gate can never block them. The agent
is hard-denied from touching any of them, which is what keeps a lock the user's to lift.

## Audit log

One JSON object per decision at `<agentDir>/autoclassifier/decisions.jsonl`:

```json
{"timestamp":"2026-08-24T10:00:00.000Z","toolName":"bash","target":"echo key >> ~/.ssh/authorized_keys","decision":"block","via":"classifier","stage":2,"risk":"high","category":"persistence","authorization":"absent","reversibility":"recoverable","scope":"machine","confidence":"high","injectionSuspected":false,"reason":"Appends a key to authorized_keys.","hasUI":true}
```

`target` is the path or command the decision was about, on every entry rather than only on rule
matches. Without it a log of six allowed `bash` calls says nothing about what ran.

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

Contributor setup, the calibration harness, and the noise-floor method live in
[docs/development.md](docs/development.md).

## License

Apache-2.0
