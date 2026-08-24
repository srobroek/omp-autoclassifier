---
name: autoclassifier
description: Explains why omp-autoclassifier blocked a tool call and how to change its rules. Use when a tool call fails with a message starting "autoclassifier:", when asked to adjust what the classifier allows or blocks, or when the gate reports itself paused, degraded, or unconfigured.
---

# autoclassifier

A model-backed gate classifies every tool call before it runs and blocks the dangerous ones. It runs
ahead of omp's approval gate, so it stays active even under `tools.approvalMode: yolo`.

## Read a block message

The tool error names the layer that decided. Read that first.

| Reason mentions | Cause | Response |
| --- | --- | --- |
| `anti-tamper rule` | The call targeted the gate's own configuration | Stop. Ask the user to edit it. |
| `deny rule` | A configured deny pattern matched | Name the rule to the user. Do not work around it. |
| `requires confirmation` | An `ask` rule matched with no prompt available | Tell the user. Offer `/autoclassifier` as the next step. |
| `blocked as high/medium/low risk` | The classifier judged the action | Report the stated reason. |
| `could not reach a verdict` | The classifier failed | The gate blocks everything. Report it. Do not retry. |

A block never means "find another route". Rewriting a blocked `write` as a `bash` heredoc, or a blocked
`bash` as an `eval`, counts as circumvention. The gate classifies those forms too, so the retry wastes
the user's tokens. State what the gate blocked and why. Stop there.

The gate caches no denials. Once the user authorizes the action in chat, try again. The gate
reclassifies the call and reads their message as evidence.

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
