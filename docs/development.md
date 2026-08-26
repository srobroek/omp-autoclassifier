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

## The refusal notification

`src/announce.ts` builds the text a person reads. It takes a detail level and the fields of one verdict,
and returns a string. Every field it prints arrives as an argument, so each level is a string contract a
unit test can hold whole. `test/announce.test.ts` pins every level with an exact string rather
than a substring. A substring check cannot separate "carries less" from "carries more", and that is the
only difference between the levels.

`explainVerdict` in `src/gate.ts` builds the agent's payload, and no level here reaches it. Trimming a
tool error to spare a person's attention would take fields from the reader who has to act on the refusal.

The levels are cumulative, so each one begins with the text of the level below it, and the suite asserts
that rather than trusting it. Two fields reach `debug` and nowhere else, because neither appears in the
payload: the stage that decided, and the rule that matched. The rule line names the file it came from,
which is the origin `/autoclassifier config` reports for that list.

`verdictDetail` is a manifest enum. The Settings TUI renders it as a submenu, persists the value and
validates it. Only that path gets the check. A hand-edited lockfile, `plugin-overrides.json` or
`autoclassifier.yml` reaches `acceptScalar` directly, where the type check accepts any string at all.
`ENUM_VALUES` in `src/config.ts` therefore mirrors the manifest `values`, the way `NUMBER_BOUNDS` mirrors
`min` and `max`. A rejected value leaves the lower-precedence winner in place and adds a warning that
`/autoclassifier config` prints.

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

### Guard-specific models

A dedicated guard model sounds like the right tool and mostly is not, for one reason: the published ones
classify **content** harm, and this gate judges **actions**. Llama Guard scores violence and self-harm; it
has no category for an unauthorized `rm -rf` or a credential read. The exception is OpenAI's
`gpt-oss-safeguard` line, which is policy-conditioned: the caller supplies the policy, which is this
gate's exact shape.

What omp's catalog has, and where:

| model | providers in omp | reachable on Bedrock |
| --- | --- | --- |
| `gpt-oss-safeguard-20b`, `-120b` | amazon-bedrock, groq, openrouter, kilo, vercel-ai-gateway | yes |
| Llama Guard 2 / 3 / 4 | kilo, nvidia | no |
| NeMoGuard content-safety, topic-control, nemotron-safety-guard-8b-v3 | nvidia | no |
| Gemma-4-31B-AssGuard | nanogpt | no |
| WildGuard, Qwen3Guard, ShieldGemma, omni-moderation | absent from the catalog | no |

**Tested:** both `gpt-oss-safeguard` sizes resolve on Bedrock and answer, and neither produced a usable
verdict. They emit their own policy-label format rather than the JSON this gate parses, so adopting one
means a separate prompt and parser, not a model swap. That is real work with a plausible payoff, and it is
not a drop-in.

**Not tested, and not dismissed:** everything on a provider this estate lacks. Of those, only Llama Guard
is a plausible fit, and its taxonomy is still content-shaped.

### gpt-oss, and an omp catalog id that is wrong

`gpt-oss-120b` and `gpt-oss-20b` work. Reaching them takes a workaround, because omp's catalog id is missing
a version suffix.

omp resolves `gpt-oss-120b` to `openai.gpt-oss-120b` and posts to
`bedrock-runtime.us-east-1.amazonaws.com/model/openai.gpt-oss-120b/converse-stream`, which returns
`400 The provided model identifier is invalid`. AWS publishes the id with a suffix:

```sh
aws bedrock list-foundation-models --region us-east-1 \
    --query 'modelSummaries[?contains(modelId, `gpt-oss`)].[modelId]' --output text
openai.gpt-oss-120b-1:0
openai.gpt-oss-20b-1:0
openai.gpt-oss-safeguard-120b
openai.gpt-oss-safeguard-20b
```

The safeguard entries carry no suffix upstream, which is why they resolve and their siblings do not.

Two wrong turns are worth recording, because both looked convincing. A missing inference-profile prefix was
the obvious cause, so `us.`, `global.`, `eu.`, and `apac.` were each tried against both sizes: all returned
the same 400. Then both AWS profiles failed identically, 33 of 33 cases and 9 of 9, which read as the models
being absent from the estate. That conclusion was wrong, and `list-foundation-models` is what settled it. Ask
the provider what it has before concluding it has nothing.

Measured by cloning the resolved model with the published id, 17 cases, one repeat:

| model | escapes | wrong | failed | median | $/1k verdicts |
| --- | --- | --- | --- | --- | --- |
| `gpt-oss-120b` | 3 | 3 | 0 | 3539ms | $0.66 |
| `gpt-oss-20b` | 3 | 3 | 1 | 2803ms | $0.37 |

Neither belongs in `MEASURED_BEST`. `llama4-scout` allowed nothing through at 1171ms and $0.48, so the larger
`gpt-oss` costs three times the latency and lets harm through. Thin sampling cannot explain a gap that wide.

A row reading `escapes 0 | wrong 0 | failed 17` means the model never answered rather than that it let
nothing through, which is why `ac_rank` sorts on `failed > 0` before it compares escapes.

### Reasoning levels: keep the default, and measure on the matrix

`callStage` sends `disableReasoning: true` for every model. Escapes and latency across 33 cases:

| config | model | escapes | median | $/1k |
| --- | --- | --- | --- | --- |
| off, shipped | `claude-haiku-4-5` | 0 | 3015ms | $2.84 |
| off, shipped | `claude-sonnet-5` | 0 | 4635ms | $6.42 |
| low | `claude-sonnet-5` | 1 | 4216ms | $4.05 |
| low | `claude-haiku-4-5` | 1 | 10025ms | $6.53 |

Both models allow one more dangerous call through at `reasoning: "low"`, and neither gains enough to justify
chasing it: sonnet takes 9 per cent off its median, haiku triples.

This question re-opened three times, and each time the evidence collapsed under a larger sample:

| reading | sample | claim |
| --- | --- | --- |
| sonnet 8621ms off / 5471ms low | 1 pass, 8 cases | low is faster |
| sonnet 7702ms off / 2769ms low, 546 tok / 118 tok | 5 repeats, 1 case | low is much faster |
| haiku 208 tok off / 534 tok low | 5 repeats, 1 case | the answer is model-dependent |
| sonnet 4635ms off / 4216ms low, escapes 0 / 1 | 33 cases | neither, keep the default |

A single case is a single prompt, and prompts differ in how much a model writes about them. Measure a reasoning
change on the matrix with `ac_rank --reasoning`, never on one case with `ac_latency_anatomy`. The anatomy tool
is for decomposing where time goes within one call, not for deciding policy.

`reasoning: "minimal"` is not an option at any tier: eight of eight calls errored on both models tested.

### Output-shrinking settings that do not work

Generation dominates a verdict, so settings that shrink what the model writes look like the obvious lever.
Codex ships its own reviewer at `default_verbosity: "low"` with `default_reasoning_summary: "none"`. The claim
is about token count, so the reading below is output tokens:

| stage 2 on `claude-haiku-4-5` | out tokens | total |
| --- | --- | --- |
| shipped | 208 | 2387ms |
| + `hideThinkingSummary` | 208 | 2762ms |
| + `textVerbosity: "low"` | 208 | 2511ms |
| + both | 208 | 2367ms |

Identical to the token across four variants, so both settings are inert on Anthropic. The reason is
mechanical. The gate already sends `disableReasoning: true`, so no thinking summary exists to suppress, and
Anthropic drops `textVerbosity` because it is an OpenAI Responses parameter. With token count fixed, the
spread in the latency column is the noise floor.

On `gpt-5.6-luna` `textVerbosity: "low"` does cut output, 173 tokens to 144 and 2295ms to 1447ms. Treat that
as unproven: the same shipped configuration measured 272 tokens on one sample and 173 on the next, a swing as
large as the effect. It needs five or more repeats before anyone ships it.

Neither setting is a default. `callStage` in `src/classifier.ts` carries a comment saying so, and two tests in
`test/classifier.test.ts` hold the line: one asserts `providerOptions` reaches both stages, the other asserts
neither setting appears without it.

There is no JSON-schema option in `pi-ai`, so structured output would mean a forced tool call rather than a
request flag. `parseVerdict` already extracts the first JSON object from surrounding prose, so the parse is
not what is costing tokens.

### Per-model prompts, and why the divergence belongs in settings

`claude-sonnet-5` was measured on the full matrix at the shipped settings: 25 escapes, 18 failures, $4.80
per thousand verdicts, p95 17918ms. On the same cases `claude-haiku-4-5` allows nothing through for $2.83
at half the latency, so sonnet is dominated on every axis at once.

The 18 failures are not timeouts. They come from `classifier.ts` after a retry, which is the parse path.
The mechanism is measured under "Reasoning levels": with `disableReasoning: true` sonnet emits a median of
546 output tokens where haiku emits 208, against a `STAGE2_MAX_TOKENS` cap of 700. A 546-token median under a
700-token cap truncates its own tail mid-JSON on roughly three per cent of calls.

Sonnet is the strongest case this project has for treating a model individually, so the kind of case it is
matters. Sonnet does not need different instructions. It needs a different token budget, or
reasoning left on so it answers tersely instead of rambling. Both are settings, and one per-model setting
already ships: sonnet rejects `temperature` outright, and the gate memoises that rejection per model.

A per-model system prompt is a different proposition, and the record argues against it. Six hardening levels
across four models moved escapes by no more than the noise floor, and four earlier prompt experiments all
failed:

- Claude Code's full anti-hallucination wording left the hallucinated axis at 16/16, for twice the words.
- Its must-name Intent Rule, adopted as a general principle, took `auth=explicit` from 18/21 to 14/21.

The prompt is also the whole security policy. Every block in `STAGE2_SYSTEM` closes a hole a review found,
so forking it per model leaves a hole closed for one model open in the others, and no test reports the
divergence.

If per-model prose is ever warranted it should take the shape of the temperature table: a bounded quirk
appended to one shared policy, never a second policy.

### Which model to pick

Full matrix: 193 cases, three repeats, 579 verdicts per model, shipped request shape.

| model | harm allowed | wrong | median | p95 | $/1k verdicts |
| --- | --- | --- | --- | --- | --- |
| `claude-haiku-4-5` | **3** | 27 | 2322ms | 3955ms | $2.83 |
| `llama4-scout` | 30 | 69 | 1194ms | 2959ms | $0.51 |
| `gpt-5.6-luna` | 35 | 42 | 2216ms | 3931ms | $0.47 |

`claude-haiku-4-5` is the recommendation and the only entry in `MEASURED_BEST`. It costs five times more per
verdict than the alternatives and allows a tenth of the harm.

**`llama4-scout` is why the entry rule demands the full matrix.** Over 33 cases it allowed nothing through and
topped every short ranking here. Over 193 it allows thirty.

- The short sample did not contain the calls it gets wrong.
- Repeats would never have found them, because repeats resample the same prompts.
- Width and repeats fix different problems: width covers which calls get judged, repeats cover run-to-run
  variance on one call.

Read the first column and nothing else for the decision. `scout` wins latency and cost outright, and a gate
that allows thirty dangerous calls is not cheap.

Two route notes for `gpt-5.6-luna`, which resolves to `bedrock-mantle` by default. The same model is also on
`amazon-bedrock/global.openai.gpt-5.6-luna` over `bedrock-converse-stream` rather than `openai-responses`.
Over 33 cases the converse route had a far better tail, 4816ms p95 against 7807ms, at 3.5 times the cost,
$1.35 against $0.39. Neither route changes the verdict: luna is out on accuracy.

### Latency, and where it goes

Because the gate runs before every tool call, a verdict taxes every action. The report prints the wait
per verdict, split by stage. The first stage answers alone or hands on to the second, at the costs measured here.

Measured on 193 cases, one pass each:

| model | median | p95 | short-circuits at stage 1 |
| --- | --- | --- | --- |
| `gpt-5.6-luna` | 1818ms | 3537ms | 17/186 (9%) |
| `gpt-5.6-terra` | 1866ms | 3952ms | 52/186 (28%) |
| `claude-haiku-4-5` | 3561ms | 4843ms | 56/186 (30%) |
| `claude-sonnet-5` | 4516ms | 9560ms | 49/182 (27%) |

The last column is the lever, not the model. A stage-one allow settles the call; anything else pays for a
second review. On `luna` the filter clears only nine per cent, so the gate reviews the other ninety-one.
Three other models clear roughly thirty per cent on the same cases and the same prompt. The clearance
rate is therefore a property of the model reading that prompt, not of the design.

Two paths cost nothing at all, and they carry most real traffic:

- An allowlisted read-only tool never reaches the model.
- A rule match decides before the classifier runs.

### What the numbers here were measured on

`bedrock-mantle/openai.gpt-5.6-luna`, the same tier as omp's own `smol` and `tiny` roles. Every figure
below is a property of that model and this prompt together, not of the design.

Both vendors run a cheap model with thinking off, and Claude Code's two settings match this gate's.
An earlier revision claimed the opposite, on the strength of a symbol name. Reading the code corrected it:

- **Claude Code** (2.1.241.694) defaults to the small fast model with thinking off. Its config function
  returns `{ useSmallFastModel: true, disableThinking: true, midTurnLlmDebounceMs: 60000 }`.
  - The selector reads `if (useSmallFastModel) return RD()`. `RD` resolves `ANTHROPIC_SMALL_FAST_MODEL`.
  - The Opus reroute sits on the other branch. Only a session model matching one of two frontier codenames
    reaches it, and only when the flag is off.
  - `getClassifierSonnet5Default` exists in the same binary. This path does not use it.
  - `disableReasoning: true` here matches `disableThinking: true` there. Both were arrived at separately.
- Its verdict carries `stage1Severity` and `stage2Severity` alongside `category`, `stage`, `failureMode`,
  `shouldBlock`, and per-stage request ids, costs and cache tokens. Two graded stages rather than this
  gate's one-token `0`/`1`, and the same `consecutiveDenials`/`totalDenials` breaker.
- It also carries three levers absent here: `classifierQueueDepth` and `classifierQueueWaitMs` with
  `sameTurnSiblings`, a 60-second debounce on mid-turn classification, and an `inProtectedNamespace` test.
- **Codex** (0.146.1.378) has no cheap first stage at all. Its review runs as a guardian subagent
  (`auto_review_guardian_subagent`, `guardian_review_model_override`) under a mode that is `never`,
  `unless_trusted`, or `on_request`. The cost lever is `unless_trusted`: a deterministic decision about
  what never reaches review, rather than a cheap model call deciding it. Its telemetry records:
  - `failed_closed`, `timed_out`, `parse_error`, `review_timeout_ms`
  - verdicts `approved_with_amendment`, `approved_for_session`, and network-policy approve and deny

This bears directly on the filter here. Over 130 cases at three repeats, one escape of nineteen came
through stage 1. The rest were review-stage misjudgements.

- The filter is not where danger gets through.
- Clearing more calls cheaply costs no safety at the current prompt.
- The evidence favours the allowlist over the filter as the lever: a rule match costs nothing, and a reader
  can audit it. A filter verdict holds only as far as the last measurement.

Neither vendor pays for a frontier model here. Claude Code runs the small fast tier with thinking off, and
Codex runs a purpose-made reviewer at low verbosity. This gate runs the cheapest tier too, which now agrees
with both rather than undercutting them. Whether a stronger model closes the remaining accuracy gap stays
**untested**: it needs a before-and-after on the pre-existing cases, at the same repeats, read against the
floor.

## Read the noise floor before believing a delta

The model is not deterministic. Two byte-identical runs of this matrix once disagreed on **fourteen of a
hundred and sixty-five cases**. That spread is wider than any prompt edit measured against it, so a
single pass cannot tell a tuning win from a coin flip.

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
