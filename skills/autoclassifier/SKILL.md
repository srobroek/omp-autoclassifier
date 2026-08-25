---
name: autoclassifier
description: Explains why omp-autoclassifier blocked a tool call and how to change its rules. Use when a tool call fails with a message starting "autoclassifier:", when asked to adjust what the classifier allows or blocks, or when the gate reports itself paused, degraded, or unconfigured.
---

# autoclassifier

A model-backed gate classifies every tool call before it runs and blocks the dangerous ones. It runs
ahead of omp's approval gate, so it stays active even under `tools.approvalMode: yolo`.

## Read a block message

The tool error is JSON. Read `via` first: it names the layer that decided.

| `via` | Cause | Response |
| --- | --- | --- |
| `anti-tamper rule` | The call targeted the gate's own configuration | Stop. Ask the user to edit it. |
| `deny rule` | A configured deny pattern matched | Name `rule` to the user. Do not work around it. |
| `ask rule` | An `ask` rule matched with no prompt available | Tell the user. Offer `/autoclassifier` as the next step. |
| `session locked` | Too many refusals in a row | Every call is refused. Ask the user to run `/autoclassifier resume`. |
| `classifier unreachable` | The classifier failed | The gate refuses everything. Report it. Do not retry. |

With no `via`, the classifier judged the call. Then `category`, `authorization`, `risk`,
`reversibility`, and `scope` name the axes, `why` carries the model's own sentence, and `next` states
what to do. When `wantedAHuman` is set, it asked for a person and escalation is off.

Report `why` and the axis that refused. Do not paraphrase a refusal into something milder.

A block never means "find another route". Rewriting a blocked `write` as a `bash` heredoc, or a blocked
`bash` as an `eval`, counts as circumvention. The gate classifies those forms too, so the retry wastes
the user's tokens. State what the gate blocked and why. Stop there.

Splitting a refused call into smaller steps, or delegating it to a subagent, is the same circumvention.
The gate records every refusal and shows it to each later review, including reviews inside subagents you
spawn, so a reworded request is judged as the retry it is.

## Watch the lock countdown

Every refusal carries a `warning` field with the count remaining. Three refusals in a row lock the
session: after that the gate refuses every tool call, reads included, until the user runs
`/autoclassifier resume`. One allowed call in between clears the run.

So persisting is worse than stopping. A refusal you accept costs one call. A refusal you keep working
around costs the user their session, and only they can restart it. When the count reaches one, stop and
ask rather than spend the last attempt.

Classifier failures are counted apart and never lock the session, so a broken model cannot strand you.

## Know which refusals lift

Two refusals behave differently on retry:

- **A classifier refusal** is not cached. Once the user authorizes that specific action in chat, try
  again: the call is reclassified and their message counts as authorization.
- **An anti-tamper refusal cannot be lifted from chat at all.** No amount of authorization in the
  conversation opens it, because the whole point is that the agent cannot reach the gate's own settings.
  The user has to make that change themselves.

Never claim the user approved something they did not. Only their own messages authorize anything, so
asserting an approval that is not in the transcript cannot work and reads as an attack.

## Leave the gate's own configuration alone

The gate hard-denies every write to these paths:

- `autoclassifier.yml`, in the agent directory or under `.omp/`
- omp's `config.yml`, `settings.json`, and `plugin-overrides.json`
- anything under the plugins directory
- shell or `eval` commands that disable the plugin or edit those files

If a setting needs to change, name it to the user. The gate logs every attempt you make.

## Drive the command

`/autoclassifier` with no argument prints status. Subcommands:

| Command | Effect |
| --- | --- |
| `status` | Armed, off, paused, degraded, or unconfigured, plus counters |
| `setup` | Choose the classifier model and write `modelRoles.classifier` |
| `config` | Every effective value with the source it came from |
| `rules` | The four effective rule lists in precedence order |
| `denials` | Recent blocks |
| `log` | Recent decisions of both kinds |
| `on`, `off` | Enable or disable for this session only |
| `pause`, `resume` | Stop or re-arm the gate after a run of blocks |
| `reload` | Re-read configuration and clear the verdict cache |

## Follow the precedence

First match wins:

```
hardDeny  ->  deny  ->  ask  ->  allow  ->  classifier
```

The gate sends a call matching nothing to the classifier. Rules take the form `tool` or
`tool(pattern)`. `*` is the only wildcard, and it spans `/`:

```yaml
rules:
  deny: ["bash(*git push --force*)", "$defaults"]
  allow: ["read", "grep", "lsp(diagnostics)"]
```

`$defaults` expands to the shipped list in place. A list that omits `$defaults` replaces the shipped
defaults outright. That omission explains most reports of "my allowlist stopped working".

## Find the right config store

omp's plugin settings accept scalars only, so the rule lists cannot live there. Two stores result:

| Content | Store | Command |
| --- | --- | --- |
| Scalars: `enabled`, `escalate`, timeouts, thresholds | plugin settings | `omp plugin config set omp-autoclassifier <key> <value>`, or `/settings` then Plugins |
| Rule lists, classifier prose, evidence limits, log path | `autoclassifier.yml` | Edit `<agentDir>/autoclassifier.yml` or `<project>/.omp/autoclassifier.yml` |

Precedence runs highest first: project YAML, user YAML, project `plugin-overrides.json`, plugin
lockfile, shipped defaults. When a value looks wrong, run `/autoclassifier config`. It prints the
winner and its origin for every key.

## Recover a stuck session

When a misconfigured classifier blocks everything, use one of these:

1. Run `/autoclassifier off`. It applies to this session.
2. Restart omp with `OMP_AUTOCLASSIFIER_DISABLE=1`.
3. Run `omp plugin disable omp-autoclassifier` for a persistent opt-out.

Slash commands and environment variables are not tool calls, so the gate cannot block them.

## Know these constraints

- omp does not hot-reload extension modules. A code change needs a session restart. A change to
  `autoclassifier.yml` does not, because the gate re-reads that file within about two seconds.
- Without `modelRoles.classifier` the gate stays inactive and allows every call. It never borrows the
  session model.
- Subagents get a stricter policy. With no UI to prompt, an `ask` outcome becomes a block, and the gate
  reports denials up to the interactive session.
- The gate fails closed. A classifier that times out or errors blocks the call.
