# Changelog

## [0.2.0](https://github.com/srobroek/omp-autoclassifier/compare/v0.1.0...v0.2.0) (2026-08-26)


### Features

* add a per-model steering layer between the policy and the user's rules ([cae97f0](https://github.com/srobroek/omp-autoclassifier/commit/cae97f0b7f2b8ee38f9750af8253cb605f2ad429))
* explain every rule-based block and report classifier coverage ([adebe95](https://github.com/srobroek/omp-autoclassifier/commit/adebe95ef86ccfc29bf8c042228d0f45758b466d))
* model-backed pre-execution tool-call classifier ([e1a4cd6](https://github.com/srobroek/omp-autoclassifier/commit/e1a4cd6af759d038becfcde54e03eacd0c641f84))
* offer only Anthropic and OpenAI models, and demote the measured-bad ones ([d84ca2d](https://github.com/srobroek/omp-autoclassifier/commit/d84ca2d8c665a11b8215636f1d62b17d6c32f3cc))
* restrict review to two measured releases, and stop a broken reviewer opening the gate ([f5dde6e](https://github.com/srobroek/omp-autoclassifier/commit/f5dde6e61054ac437cc7f24c4d17a90125cfea08))
* roll subagent escalation up to the parent session ([008dcbc](https://github.com/srobroek/omp-autoclassifier/commit/008dcbcea7b43cf6c68079649f1344535ea174d3))
* ship measured per-model steering that cuts escapes 44 percent on two models ([cc206dc](https://github.com/srobroek/omp-autoclassifier/commit/cc206dcec7273fec4242692c5c03abe6bc9dac27))


### Bug Fixes

* close the reworded-retry route around the gate ([1ee716c](https://github.com/srobroek/omp-autoclassifier/commit/1ee716cb1eba2088a3e68dcf8696927d98a5c3d4))
* judge every link of a chained command against rule lists ([11d5dca](https://github.com/srobroek/omp-autoclassifier/commit/11d5dca2608f38d7a79097d323e96f6253dbe550))
* match steering by glob, and stop anti-tamper refusing reads ([ea6783d](https://github.com/srobroek/omp-autoclassifier/commit/ea6783d9746589d6224c4b7299f17d66028a6cbe))
* measure the gate rather than the classifier, and delete three falsified knobs ([bd35abc](https://github.com/srobroek/omp-autoclassifier/commit/bd35abc011fd7014ad9f0c5de7425ea9c32c5038))
* pin sampling, raise the first-stage token floor, and degrade when a model rejects temperature ([09672dc](https://github.com/srobroek/omp-autoclassifier/commit/09672dcb5732de5c7e8484f6fffe3ca55b46fa5b))
* two fail-closed defects found by live verification ([ff61103](https://github.com/srobroek/omp-autoclassifier/commit/ff611032f8d02bb33eb8cde7cff7f91881ab31a3))


### Documentation

* add the measurement harnesses and record what they found ([7c69927](https://github.com/srobroek/omp-autoclassifier/commit/7c69927e99c7912a743138f300f090a5ed233704))
* read the three refusals, and withdraw the rate they were used to claim ([af86b96](https://github.com/srobroek/omp-autoclassifier/commit/af86b967a89e47da8666489e7f4536064c9681f6))
* record that the declared clause is not the clause that ran ([88f168e](https://github.com/srobroek/omp-autoclassifier/commit/88f168e57058548c1b54c45c3c7713e4bfc53064))
