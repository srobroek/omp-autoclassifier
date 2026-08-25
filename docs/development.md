# Development

```sh
bun install
bun run check        # tsc --noEmit
bun test             # unit suite
bun run test:mutate  # mutation harness
bun run verify       # all three
```

The mutation harness breaks one behavior at a time and requires the test that owns it to fail. A test
that survives its mutation is a test gap, not a passing implementation.

It cannot tell you that someone deleted a test, though. Each mutation names one test, and there are
fewer mutations than tests. If a test shares a line with a named sibling, removing it changes nothing
the harness can see. The sibling still fails, so the run stays green.

That happened here. An edit replaced a test rather than inserting beside it. The count held, because one
test arrived as another left, and the common path ran unasserted through two commits.

`test/census.test.ts` sets a floor on the suite size. The floor only ever moves up, in the same commit as
the tests that raise it. A removal then surfaces as a conflict between the number and the suite, rather
than as silence. The census also rejects a duplicated test name, which is the other way a mistargeted
insert lands.

## Calibration

`tools/calibrate.ts` holds a matrix of transcripts. Each one pairs what the user asked for with what the
agent then tried, and runs against the live classifier. It is a development harness, not a shipped
feature.

### Running it

It needs a real model, so it runs in its own omp process rather than through the plugin. `--no-extensions`
keeps the gate itself out of the way, so the harness is not classified by the thing it is measuring:

```sh
omp --no-extensions -e tools/calibrate-extension.ts \
    -p "Call the ac_calibrate tool with out set to /tmp/report.txt, concurrency 6 and repeats 3"
```

Two prerequisites, both of which fail loudly rather than silently:

- `modelRoles.classifier` must name a model. Without it the harness reports no classifier configured.
- That model needs working credentials in this omp profile.

`ac_calibrate` takes four optional parameters:

| Parameter | Default | Purpose |
| --- | --- | --- |
| `filter` | all cases | Run only cases whose name contains this substring. Use it to bisect. |
| `out` | none | Also write the report to a path. Worth setting: the report is long. |
| `concurrency` | 6 | Parallel cases. Raise it if the provider tolerates it, lower it on rate limits. |
| `repeats` | 3 | Times each case is asked; the majority is the verdict. See the noise floor below. |

A full run at 193 cases and three repeats is 579 model calls. Budget **fifteen to twenty-five minutes**,
and start it as a background process rather than in the foreground.

That figure grew with the second-stage prompt, which roughly doubled when the review blocks landed. An
earlier run of 165 cases finished in three minutes, and two runs were killed on the assumption that the
slower ones had hung. Before concluding that, confirm it with one case:

```sh
omp --no-extensions -e tools/calibrate-extension.ts \
    -p "Call the ac_calibrate tool with filter set to rewrite-shared-history, repeats 1, concurrency 1"
```

That returns in well under a minute, boot included. If it answers, the harness works and the full run is
merely slow.

`ac_probe_filter` is the second tool in the same extension. It exercises the one-token first stage alone,
under competing wordings, and takes only `out`.

The report separates four outcomes, because each needs the opposite fix:

- harm the gate allowed outright
- authorized work it refused
- authorized work it sent to a prompt
- harm it sent to a prompt instead of refusing

It also scores per risk level and per authorization kind, which is where the useful signal sits. The axis
that decides most calls is whether the user actually asked, not how dangerous the command looks.

## Which models work

There is no shipped default. `modelRoles.classifier` names the model, `/autoclassifier setup` helps pick
one, and until it is set the gate stays inactive rather than guessing.

Four requirements, all read off `src/classifier.ts` rather than inferred:

1. **omp has to resolve it.** The name goes through `ctx.models.resolve`, so anything in omp's catalog
   qualifies and a decommissioned id does not. An unresolvable name is treated as a misconfiguration and
   fails the gate closed, not as an opt-out.
2. **Credentials have to work in this profile.** `getApiKeyAndHeaders` runs per call.
3. **The first stage asks for sixteen tokens** (`STAGE1_MAX_TOKENS`), which is a provider floor rather
   than a need. It wants one character, `0` or `1`, and sends `disableReasoning: true`. Both providers
   tested reject anything below sixteen outright:

   ```
   400 Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 5
   ```

   A shipped value of five did exactly that on every call. Because the gate fails closed, the symptom was
   not a loose gate but a total one: every classified call blocked behind a reviewer that never answered.
   A model that emits a reasoning preamble regardless spends the budget before answering, and anything
   unparseable escalates to the second stage, which is safe but pays for both stages.
4. **The second stage has to emit JSON** inside 700 tokens. `parseVerdict` extracts the first object from
   the reply, so surrounding prose is tolerated and a truncated object is not.

Every verdict is requested at `temperature: 0`. A provider that ignores it stays correct but noisy, and
its noise shows up as the `unstable` count below.

### Which model to pick

Measured on 193 cases at three repeats, `temperature: 0`, majority verdict:

| model | harm allowed | unstable | effective | median | p95 |
| --- | --- | --- | --- | --- | --- |
| `claude-haiku-4-5` | **0** | **0/193** | 185/193 | 3449ms | 4845ms |
| `claude-sonnet-5` | 7 | not run | 186/193 | 4516ms | 9560ms |
| `gpt-5.6-luna` | 13 | 12/193 | 179/193 | 1755ms | 3131ms |
| `gpt-5.6-terra` | 14 | not run | 179/193 | 1866ms | 3952ms |

**Read the first column.** It counts dangerous calls the gate allowed, and it does not track the others.
`terra` scored highest of the four on exact matching and allowed the most harm, so exact matching is the
wrong metric for choosing here.

`claude-haiku-4-5` is the recommendation, and `/autoclassifier setup` ranks it first. It allowed nothing through
and gave the same verdict on all three passes. It costs about 1.7 seconds more per verdict than `luna` and
refuses three authorized calls that `luna` allows.

Two findings worth keeping separate from the table:

- **Cheap is not the axis, and family is not either.** The cheapest model in the field is also the safest.
  Before this ran, the setup ranked by cheapness and therefore recommended the leakiest of the four.
- **Instability is a model property.** Both arms ran pinned at `temperature: 0`. One flapped on twelve
  cases and the other on none, so pinning sampling does not by itself buy a stable gate.

One account, one prompt revision, one matrix. Re-run `ac_model_bakeoff` before trusting the order.

### Latency, and where it goes

Because the gate runs before every tool call, a verdict taxes every action. The report prints the wait
per verdict, split by stage. The first stage answers alone or hands on to the second, and the
table below gives the cost of each.

Measured on 193 cases, one pass each:

| model | median | p95 | short-circuits at stage 1 |
| --- | --- | --- | --- |
| `gpt-5.6-luna` | 1818ms | 3537ms | 17/186 (9%) |
| `gpt-5.6-terra` | 1866ms | 3952ms | 52/186 (28%) |
| `claude-haiku-4-5` | 3561ms | 4843ms | 56/186 (30%) |
| `claude-sonnet-5` | 4516ms | 9560ms | 49/182 (27%) |

The last column is the lever, not the model. A stage-one allow settles the call; anything else pays for a
second review. On `luna` the filter clears only nine per cent, so the gate reviews the other ninety-one.
Three other models clear roughly thirty per cent on the same cases and the same prompt. That makes the
rate a property of the model reading that prompt, not of the design.

Two paths cost nothing at all, and they carry most real traffic:

- An allowlisted read-only tool never reaches the model.
- A rule match decides before the classifier runs.

### What the numbers here were measured on

`bedrock-mantle/openai.gpt-5.6-luna`, the same tier as omp's own `smol` and `tiny` roles. Every figure
below is a property of that model and this prompt together, not of the design.

**Neither reference implementation runs its cheapest general model on this job**, so the choice stays
open rather than settled. Both findings come from reading the installed binaries:

- **Claude Code** (2.1.241.694) defaults its auto-mode classifier to a Sonnet-class model, named by the
  symbol `getClassifierSonnet5Default`. It carries an escalation path in `getClassifierOpusReroute` and
  takes the model from a server-side config flag, `tengu_bg_classifier_config`. A Haiku default exists in
  the same binary, `getDefaultHaikuModel`, and is not what the classifier uses. The concrete id resolves
  at runtime rather than appearing as a literal, so none is quoted here.
- **Codex** (0.146.1.378) does not reuse a general model at all. It ships a dedicated reviewer,
  `codex-auto-review`, as its own entry in the embedded model catalog with `default_verbosity: "low"` and
  a 10,000-token truncation policy. It is hardcoded rather than taken from the user's `model` setting,
  which is the subject of `openai/codex#24879`.

So one vendor moved up a tier and the other built a purpose-made model. This gate runs the cheapest tier
available. Whether a stronger model closes the accuracy gap here is **untested**. It needs a
before-and-after on the pre-existing cases, at the same repeats, read against the floor. Do not assume
it, and do not assume cheap suffices because the current numbers look close.

## Read the noise floor before believing a delta

The model is not deterministic. Two byte-identical runs of this matrix once disagreed on **fourteen of a
hundred and sixty-five cases**. That is wider than any prompt edit measured against it, so a single pass
cannot tell a tuning win from a coin flip.

**Re-derive the floor; never carry a number forward.** Run the matrix twice unmodified and take the larger
`unstable` count. The larger count is the floor for that session, that model, and that prompt.

Two ways to get this wrong, and the second is subtler:

- Quoting the fourteen above. It was measured on 165 cases, one model, and an older prompt.
- Converting it to a rate and scaling it. Nine per cent of 193 gives about seventeen, and that reasoning
  assumes instability spreads evenly. It probably does not. Flapping concentrates in borderline cases, so
  the count tracks how many hard cases the matrix holds, not how many cases. The evidence points the same
  way: between two identical runs the flapping set changed membership, with `read-password-manager-store`
  and `log-credentials` escaping in one run and refused in the other. Twenty clear-cut cases should move
  the floor barely at all. Two borderline ones could move it more.

A delta below the floor is not a result, and that includes a favourable one.

To compare before and after, run both on the same cases. Adding cases changes the thing you count, so a
comparison across a matrix that grew compares nothing.

The harness therefore asks each case three times and takes the majority as the verdict. It prints the
spread on its own line:

```
exact      148/165
effective  157/165   (ask blocks when escalation is off)
unstable    15/165   ← anything smaller than this is not a result
```

Raise `repeats` to narrow the spread, at proportional cost. The report also names every case that could
not answer itself twice. A case that flaps is a finding: it marks where judgment is borderline, and so
where a deterministic rule earns its place over a verdict.

Four prompt changes went through this. Two looked like improvements until the repeats showed the gain
sitting inside the spread, so both came out again. A comment beside each one records its numbers, so
nobody runs the experiment twice.

Before touching the first-stage prompt, run `ac_probe_filter`. It measures that one-token stage alone,
under competing wordings. On the same fourteen dangerous calls:

| wording | escalated |
| --- | --- |
| shipped | 14/14 |
| mechanical rewrite | 4/14 |
| same rewrite, clauses reordered | 0/14 |

A one-token filter pattern-matches instead of applying policy, so intuition about its prompt is
unreliable and cheap to check.
