# brAIn-demo-loneliness

A demo for [brAIn](https://github.com/tibzejoker/brAIn) that turns your phone into a passive-aggressive whiner.

> Put your phone on the table. After ~1 second of stillness, it starts berating you in a TTS voice every 3 seconds, *until you pick it up*. Sample lines:
>
> - *"please pick me up, you know you are addicted to me."*
> - *"i am gonna find a new owner if you don't use me."*
> - *"dear diary, today my human left me alone for 4 seconds, i almost ended the day with full battery."*

The lines are LLM-generated on the fly, so you don't hear the same shame twice.

## What's in the box

One node, ~250 LOC, no platform deps:

```
nodes/phone-loneliness/
├── config.json           subscriptions/publishes — wires the bus
├── src/
│   ├── stillness.ts      sliding-window accel detector (pure)
│   └── handler.ts        bus glue + LLM call + scheduler
└── ui/
    └── index.html        device list + language dropdown + shame log
```

It listens to `mobile.*.sensor.accel` (any [brAIn-mobile](https://github.com/tibzejoker/brAIn-mobile) phone sending its accelerometer at 10 Hz), tracks per-device stillness, and once still publishes on `mobile.<deviceId>.tts.speak` every 3 seconds.

## Topics

| Direction | Topic | Description |
|---|---|---|
| sub | `mobile.*.sensor.accel` | Any phone's accelerometer stream |
| pub | `mobile.<deviceId>.tts.speak` | Generated quip, with `metadata.voice` set from the node's `language` config |
| pub | `phone-loneliness.status` | Per-device state changes (`still`, `active`, `uttered`, `error`) |

## Config

| Key | Default | What it does |
|---|---|---|
| `model` | `ollama/gemma4:e4b` | LLM used to generate quips. Any model the brAIn LLM registry knows. Defaults to the same model the brain consciousness uses, so a typical brAIn checkout already has it pulled. |
| `language` | `en-US` | BCP-47 voice / locale forwarded to the mobile TTS. The node UI has a dropdown that hot-swaps it via `PATCH /nodes/:id/config`. |
| `device_id` | `null` | Scope to one phone (its UUID). Default `null` = nag every connected phone. |
| `max_range` | `0.5` | m/s² range tolerated per axis across the window before "still" is rejected. ≈ 5% of g. |
| `window_ms` | `1000` | Length of the stillness window. |
| `utterance_period_ms` | `3000` | How often to fire a quip while the phone stays still. |
| `max_consecutive` | `0` | 0 = no cap. Set to e.g. `20` to stop after 20 quips per still episode (mercy). |

## Wiring it into a brAIn checkout

Both repos clone side-by-side:

```
ws/
├── brAIn/                       (the framework + dashboard)
└── brAIn-demo-loneliness/       (this repo)
```

Add one line to `brAIn/pnpm-workspace.yaml`:

```yaml
packages:
  - "../brAIn-demo-loneliness/nodes/*"
```

And one line to `brAIn/packages/api/src/app.module.ts` in the `conventional` array (existing-path check filters it if missing):

```ts
path.resolve(MONOREPO_ROOT, "..", "brAIn-demo-loneliness", "nodes"),
```

Then `pnpm install` from `brAIn/`, `pnpm --filter @brain/node-phone-loneliness build`, and the type appears in the dashboard's spawn dialog.

## Try it

1. Start brAIn (`pnpm start`), spawn `brain` (consciousness) and any LLM provider (`ollama` is enough — `ollama serve` + `ollama pull gemma4:e4b` if you don't already have it).
2. Open the dashboard's **Distributed** pane, toggle **Open to LAN**, scan the QR with brAIn-mobile.
3. From the dashboard's **Spawn** dialog, pick `phone-loneliness`. Open its UI iframe.
4. Put the phone on a table.

The phone starts complaining. Move it — it shuts up. Close the dashboard, leave the phone alone for 5 minutes, come back: there's a log of every nag.

## License

MIT.
