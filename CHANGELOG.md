# Changelog

## 1.0.0 (2026-06-03)


### Features

* add ensure-store-built script to build missing storeproject nodes ([255ec32](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/255ec32bf67701ec3b8e45ee4b266c14dcbaf035))
* **llm:** add tool call support and use framework llm use everywhere ([cc56701](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/cc56701dfcf7aa4c32988d6bf805a9e03892c573))
* phone-loneliness — passive-aggressive phone demo ([52ef4dc](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/52ef4dcbf8c5b6f665831eb465e0b99da36650e7))
* **phone-loneliness:** cache map visible in UI ([d9fcdf1](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/d9fcdf1dce9e4154fa43e17f8d09e0edcdaa516d))
* **phone-loneliness:** immediate first quip · 2% sensitivity · localized prompt · /no_think ([5128d0d](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/5128d0d9194d5acdc428ddb9e4099326db79d57c))
* **phone-loneliness:** live per-device motion status (moving / put down) + robust stillness ([#16](https://github.com/tibzejoker/brAIn-demo-loneliness/issues/16)) ([f4a25d8](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/f4a25d8458f4d8ca25f1ce9ff7284ca33f058171))
* **phone-loneliness:** no flicker · anti-repetition · flash dance while speaking ([22cd183](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/22cd183b792ee75afd24d2c8c5458d7a76502380))
* **phone-loneliness:** pickup line on still→active transition ([7f3290b](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/7f3290ba278343a9d574eb38ae8e96ad4913835e))
* **phone-loneliness:** pickup lines visible in UI + pickup cache in the map ([0a9b340](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/0a9b340feb245afae0d24143d194da7d810100c5))
* **phone-loneliness:** pre-warmed quip cache per language (tac-au-tac) ([c210018](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/c2100188150209ec6760e2a4c87d2fc28bb41c0a))
* **seeds:** ship loneliness template ([b191efb](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/b191efb7333a696cd297010126aa9d1cb55fe787))


### Bug Fixes

* migrate phone-loneliness UI to /node/:id/messages ([#12](https://github.com/tibzejoker/brAIn-demo-loneliness/issues/12)) ([da40126](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/da40126f4cdbf8b884e05dc2a7b0b28567c1ae75))
* **phone-loneliness:** bound the flash-dance so a stuck/orphaned strobe can't flood the bus ([#18](https://github.com/tibzejoker/brAIn-demo-loneliness/issues/18)) ([b63fe7d](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/b63fe7d6e81dd1f0fc4a4bbbd7980d59cd4f7237))
* **phone-loneliness:** center the prompt on abandonment, not silence ([513cc51](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/513cc5151a23e49832e7eb0c5883e19f45bc77d5))
* **phone-loneliness:** default model = ollama/gemma4:e4b (same as brain) ([29fc6a6](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/29fc6a632f565f186aa91d8e1bd12940bc1c5c45))
* **phone-loneliness:** heartbeat the cache snapshot so the dashboard always reflects state ([#14](https://github.com/tibzejoker/brAIn-demo-loneliness/issues/14)) ([ba66234](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/ba6623402deb161246cdd8ad3a13d42d0de2c9f2))
* **phone-loneliness:** pre-warm the cache at spawn, not after a phone connects ([#15](https://github.com/tibzejoker/brAIn-demo-loneliness/issues/15)) ([c459ff7](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/c459ff737e81c1cf80242a139a77059eb6d97457))
* **phone-loneliness:** reschedule in finally — empty LLM output no longer kills the loop ([f043b0e](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/f043b0e1ee5e90324909e3ddaa189d40414ab1b0))
* **phone-loneliness:** stop refillCache spin-loop on LLM failure ([b06dc79](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/b06dc79ff5eb72cf05105ab03d744263bfc727d6))
* **phone-loneliness:** subscribe to mobile.* (greedy) + announce on first sample ([d8b7ac0](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/d8b7ac0fca20f38debc513a8c400083ce53cf643))
* **phone-loneliness:** utterance_period_ms measures the gap AFTER speaking ([9b12d31](https://github.com/tibzejoker/brAIn-demo-loneliness/commit/9b12d31b8fb2180f7f13134f59d5a4dd870b1e9e))
