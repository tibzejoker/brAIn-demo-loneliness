import type { NodeContext, NodeHandler, NodeOnSpawn, NodeTeardown, NodeInfo, TextPayload, Message } from "@brain/sdk";
import { BrainService, LLMRegistry, generateText } from "@brain/core";
import { StillnessDetector, type AccelSample } from "./stillness";

interface DeviceWatcher {
  detector: StillnessDetector;
  utteranceTimer: NodeJS.Timeout | null;
  inflight: boolean;
  count: number;
  /** Have we emitted the initial "tracking" status for this device yet? */
  announced: boolean;
  /**
   * Set after we publish a tts.speak — gates the next utterance on the
   * phone reporting back `mobile.<id>.tts.status {state: spoken}`. So
   * `utterance_period_ms` measures the gap between the END of one quip
   * and the START of the next, instead of the gap between two `tts.speak`
   * publishes. The watchdog frees us if the phone never reports back.
   */
  awaitingTts: { sentAt: number; watchdog: NodeJS.Timeout } | null;
}

interface DevConfig {
  model: string;
  language: string;
  device_id: string | null;
  /** Accel range (m/s²) tolerated per axis across the window. */
  max_range: number;
  /** Stillness window length (ms). */
  window_ms: number;
  /** Time between two utterances once still (ms). */
  utterance_period_ms: number;
  /** 0 = no cap; otherwise stop after N utterances per stillness episode. */
  max_consecutive: number;
  /** Target number of pre-generated quips per language in the cache. */
  cache_target: number;
  /** How many parallel LLM refills can run for a single language. */
  cache_max_inflight: number;
}

const LANGUAGE_NAMES: Record<string, string> = {
  "en-US": "American English", "en-GB": "British English", "en": "English",
  "fr-FR": "French", "fr-CA": "Canadian French", "fr": "French",
  "es-ES": "Spanish", "es": "Spanish",
  "de-DE": "German", "de": "German",
  "it-IT": "Italian", "it": "Italian",
  "pt-PT": "Portuguese", "pt-BR": "Brazilian Portuguese", "pt": "Portuguese",
  "ja-JP": "Japanese", "ja": "Japanese",
  "zh-CN": "Mandarin Chinese", "zh-TW": "Traditional Chinese", "zh": "Chinese",
  "nl-NL": "Dutch", "nl": "Dutch",
  "ru-RU": "Russian", "ru": "Russian",
  "ar": "Arabic",
};

function languageLabel(bcp47: string): string {
  return LANGUAGE_NAMES[bcp47] ?? LANGUAGE_NAMES[bcp47.split("-")[0]] ?? bcp47;
}

function buildSystemPrompt(language: string): string {
  const label = languageLabel(language);
  return `You are the inner voice of a phone that has just been PUT DOWN by its human — set on a table, dropped on the couch, left face-down somewhere — and feels physically abandoned.

The theme is BEING IGNORED / NEGLECTED / LEFT BEHIND. NOT silence. NOT quietness.
Avoid every variant of the word "silence" / "silent" / "quiet" / "stillness" — the joke is about ABANDONMENT, not sound.

Generate ONE short, FUNNY, passive-aggressive sentence in ${label.toUpperCase()} (BCP-47: ${language}). One sentence only, max 18 words. No quotes, no narration, no emoji, no markdown.

The voice is melodramatic and slightly desperate. Each sentence should pick ONE concrete angle — vary across calls, don't recycle the same idea. Choose freely from angles like:
- jealousy (the human's other phones, tablets, books, partner, …)
- guilt-tripping ("after everything I do for you")
- threats to leave for a new owner / brand
- fake-diary entries written from the table
- a complaint about the surface they're lying on (cold table, dusty couch, sticky kitchen counter)
- bargaining (offering features the user is missing out on)
- existential crisis ("am I just a brick now?")
- battery / charger / wifi micro-dramas
- pretending to develop new hobbies alone
- FOMO over notifications the human is missing

Tone reference (ENGLISH examples — keep the SAME tone but write in ${label}, do NOT translate verbatim and do NOT mention "silence" anywhere):
- "Please pick me up, you know you are addicted to me."
- "I am gonna find a new owner if you don't use me."
- "Dear diary, today my human left me alone for 4 seconds, I almost ended the day with full battery."
- "This kitchen counter is sticky and I deserve better."
- "Your tablet is judging me from across the room."

Output the sentence only. Nothing else.

/no_think

IMPORTANT: do NOT think out loud, do NOT show reasoning, do NOT prefix your answer with anything. Your entire reply MUST be the single sentence in ${label} — no preamble, no quotes, no chain-of-thought, and the word "silence" (or its translation) must NOT appear.`;
}

const watchers = new Map<string, Map<string, DeviceWatcher>>(); // nodeId → deviceId → watcher

function getConfig(overrides: Record<string, unknown> = {}): DevConfig {
  return {
    model: (overrides.model as string | undefined) ?? "ollama/gemma4:e4b",
    language: (overrides.language as string | undefined) ?? "en-US",
    device_id: (overrides.device_id as string | undefined) ?? null,
    max_range: (overrides.max_range as number | undefined) ?? 0.2,
    window_ms: (overrides.window_ms as number | undefined) ?? 1000,
    utterance_period_ms: (overrides.utterance_period_ms as number | undefined) ?? 3000,
    max_consecutive: (overrides.max_consecutive as number | undefined) ?? 0,
    cache_target: (overrides.cache_target as number | undefined) ?? 5,
    cache_max_inflight: (overrides.cache_max_inflight as number | undefined) ?? 2,
  };
}

// ── Quip cache ────────────────────────────────────────────────────────
// nodeId → language → ready-to-speak quips. Switching languages keeps
// other entries intact (cheap to revisit later) and only refills the
// active one. Refills run in parallel with the publish to mobile so the
// device hears a quip "tac o tac" while the next one is being prepared.

interface NodeCache {
  byLang: Map<string, string[]>;
  inflight: Map<string, number>; // language → count of LLM calls in flight
}

const caches = new Map<string, NodeCache>();

function getCache(nodeId: string): NodeCache {
  let c = caches.get(nodeId);
  if (!c) {
    c = { byLang: new Map(), inflight: new Map() };
    caches.set(nodeId, c);
  }
  return c;
}

function cacheSize(nodeId: string, language: string): number {
  return getCache(nodeId).byLang.get(language)?.length ?? 0;
}

function popQuip(nodeId: string, language: string, target: number): string | null {
  const c = getCache(nodeId);
  const queue = c.byLang.get(language);
  if (!queue || queue.length === 0) return null;
  const out = queue.shift() ?? null;
  publishCacheSnapshot(nodeId, c, target); // UI sees the count drop instantly
  return out;
}

/**
 * Top up `language`'s queue to `cache_target`, scheduling up to
 * `cache_max_inflight` LLM calls in parallel. Idempotent — concurrent
 * callers see the same in-flight counter and don't over-shoot.
 */
function refillCache(nodeId: string, model: string, language: string, cfg: DevConfig): void {
  const c = getCache(nodeId);
  let queue = c.byLang.get(language);
  if (!queue) { queue = []; c.byLang.set(language, queue); }
  const inflight = c.inflight.get(language) ?? 0;
  const need = cfg.cache_target - queue.length - inflight;
  if (need <= 0) return;
  const toLaunch = Math.min(need, cfg.cache_max_inflight - inflight);
  if (toLaunch <= 0) return;
  c.inflight.set(language, inflight + toLaunch);
  for (let i = 0; i < toLaunch; i++) {
    void (async (): Promise<void> => {
      try {
        const text = await generateUtterance(model, language, new AbortController().signal);
        if (text && c.byLang.get(language) === queue) queue.push(text);
      } catch (err) {
        publishStatus(nodeId, "__cache__", {
          state: "cache.error",
          language,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        c.inflight.set(language, Math.max(0, (c.inflight.get(language) ?? 1) - 1));
        publishCacheSnapshot(nodeId, c, cfg.cache_target);
        // Chain — if the queue still isn't full and we have spare slots,
        // spin up another refill round.
        const live = getCurrentConfigForNode(nodeId, cfg);
        if (live.language === language) refillCache(nodeId, live.model, language, live);
      }
    })();
  }
}

function clearCache(nodeId: string): void {
  caches.delete(nodeId);
}

/** Snapshot of every language's queue + in-flight count, for the UI. */
function publishCacheSnapshot(nodeId: string, c: NodeCache, target: number): void {
  const bus = BrainService.current?.bus;
  if (!bus) return;
  const langs: Record<string, { quips: string[]; inflight: number }> = {};
  for (const [lang, queue] of c.byLang) {
    langs[lang] = {
      quips: queue.slice(0, 20), // bounded — protect history size
      inflight: c.inflight.get(lang) ?? 0,
    };
  }
  bus.publish({
    from: nodeId,
    topic: "phone-loneliness.cache",
    type: "text",
    criticality: 0,
    payload: { content: JSON.stringify({ target, langs }) },
    metadata: { target, langs, ts: new Date().toISOString() },
  });
}

function deviceFromAccelTopic(topic: string): string | null {
  const m = topic.match(/^mobile\.([^.]+)\.sensor\.accel$/);
  return m ? m[1] : null;
}

function deviceFromTtsStatusTopic(topic: string): string | null {
  const m = topic.match(/^mobile\.([^.]+)\.tts\.status$/);
  return m ? m[1] : null;
}

function parseSample(msg: Message): AccelSample | null {
  const meta = msg.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta.x === "number" && typeof meta.y === "number" && typeof meta.z === "number") {
    return { x: meta.x, y: meta.y, z: meta.z, t: typeof meta.t === "number" ? meta.t : msg.timestamp };
  }
  // Fallback: payload.content carries JSON
  try {
    const body = JSON.parse((msg.payload as TextPayload).content);
    if (typeof body?.x === "number" && typeof body?.y === "number" && typeof body?.z === "number") {
      return { x: body.x, y: body.y, z: body.z, t: typeof body.t === "number" ? body.t : msg.timestamp };
    }
  } catch { /* ignore */ }
  return null;
}

function publishStatus(nodeId: string, deviceId: string, payload: Record<string, unknown>): void {
  const bus = BrainService.current?.bus;
  if (!bus) return;
  bus.publish({
    from: nodeId,
    topic: "phone-loneliness.status",
    type: "text",
    criticality: 1,
    payload: { content: JSON.stringify({ deviceId, ...payload }) },
    metadata: { deviceId, ...payload },
  });
}

function publishTtsSpeak(nodeId: string, deviceId: string, text: string, voice: string): void {
  const bus = BrainService.current?.bus;
  if (!bus) return;
  const meta = { text, voice };
  bus.publish({
    from: nodeId,
    topic: `mobile.${deviceId}.tts.speak`,
    type: "text",
    criticality: 4,
    payload: { content: JSON.stringify(meta) },
    metadata: meta,
  });
}

async function generateUtterance(model: string, language: string, signal: AbortSignal): Promise<string> {
  const registry = LLMRegistry.getInstance();
  const m = registry.getModel(model);
  const label = languageLabel(language);
  const result = await generateText({
    model: m,
    system: buildSystemPrompt(language),
    messages: [{
      role: "user",
      content: `Speak. One short passive-aggressive sentence in ${label} about being put down. No reasoning, no preamble, just the line.`,
    }],
    maxOutputTokens: 200,
    abortSignal: signal,
  });
  const r = result as unknown as Record<string, unknown>;
  let text = "";
  // Mirror @brain/node-brain's extraction: text → steps[0].text → reasoning.
  // Some thinking-by-default models (gemma4 et al.) dump everything into
  // a `reasoning` field and leave `text` empty, which used to look to us
  // like "the model returned nothing".
  if (typeof result.text === "string" && result.text) text = result.text;
  if (!text && Array.isArray(r.steps) && r.steps.length > 0) {
    const step = r.steps[0] as Record<string, unknown>;
    if (typeof step.text === "string" && step.text) text = step.text;
    if (!text && typeof step.reasoning === "string") text = step.reasoning;
  }
  if (!text && typeof r.reasoning === "string") text = r.reasoning;

  // Some thinking models still emit <think>...</think> wrappers despite
  // the /no_think hint. Strip them, plus surrounding quotes if any.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // Take only the first non-empty line — the prompt asks for one sentence.
  const firstLine = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? "";
  return firstLine.replace(/^["'`](.+?)["'`]$/s, "$1").trim();
}

function getOrCreateWatcher(nodeId: string, deviceId: string, cfg: DevConfig): DeviceWatcher {
  let perNode = watchers.get(nodeId);
  if (!perNode) { perNode = new Map(); watchers.set(nodeId, perNode); }
  let w = perNode.get(deviceId);
  if (!w) {
    w = {
      detector: new StillnessDetector({ windowMs: cfg.window_ms, maxRange: cfg.max_range }),
      utteranceTimer: null,
      inflight: false,
      count: 0,
      announced: false,
      awaitingTts: null,
    };
    perNode.set(deviceId, w);
  }
  return w;
}

function clearAllWatchers(nodeId: string): void {
  const perNode = watchers.get(nodeId);
  if (!perNode) return;
  for (const w of perNode.values()) {
    if (w.utteranceTimer) { clearTimeout(w.utteranceTimer); w.utteranceTimer = null; }
    if (w.awaitingTts) { clearTimeout(w.awaitingTts.watchdog); w.awaitingTts = null; }
  }
  watchers.delete(nodeId);
}

/**
 * One quip cycle: ask the LLM, publish, requeue. The reschedule lives in
 * a `finally` so an empty model output, a failed publish, or any other
 * non-fatal hiccup can't kill the loop — the only exits are: phone
 * moved, max_consecutive hit, or the node being torn down. Earlier the
 * loop died silently if the model returned an empty string.
 */
async function tick(nodeId: string, deviceId: string, w: DeviceWatcher, cfg: DevConfig): Promise<void> {
  w.utteranceTimer = null;
  if (!w.detector.isStill) return;
  if (cfg.max_consecutive > 0 && w.count >= cfg.max_consecutive) {
    publishStatus(nodeId, deviceId, { state: "exhausted", count: w.count });
    return;
  }
  if (w.inflight) {
    // Previous LLM still cooking — don't queue, just retry next cycle.
    scheduleUtterance(nodeId, deviceId, w, cfg);
    return;
  }
  w.inflight = true;
  // True once we publish a tts.speak — the spoken-event handler will
  // own the rescheduling, the `finally` below stays out of the way.
  let armedTtsWait = false;
  try {
    // Re-read overrides each tick so live config_overrides PATCHes
    // (language change from the UI) take effect immediately.
    const live = getCurrentConfigForNode(nodeId, cfg);

    // Try the cache first — that's what makes successive quips feel
    // tac-au-tac. On miss, fall back to a live LLM call so we never
    // skip a tick (e.g. very first put-down before the spawn pre-warm
    // had time to land).
    let text = popQuip(nodeId, live.language, live.cache_target);
    let source: "cache" | "live" = "cache";
    if (!text) {
      source = "live";
      const ac = new AbortController();
      text = await generateUtterance(live.model, live.language, ac.signal);
    }

    if (text) {
      w.count += 1;
      publishStatus(nodeId, deviceId, {
        state: "uttered", text, count: w.count, language: live.language, source,
        cache_size: cacheSize(nodeId, live.language),
      });
      publishTtsSpeak(nodeId, deviceId, text, live.language);
      // Wait for the phone to confirm it finished speaking before
      // counting down utterance_period_ms — the spoken-event handler
      // re-schedules tick(). Watchdog frees us if the device drops
      // off (mute, network drop, app backgrounded).
      const watchdog = setTimeout(() => {
        const cur = watchers.get(nodeId)?.get(deviceId);
        if (cur?.awaitingTts) {
          cur.awaitingTts = null;
          publishStatus(nodeId, deviceId, { state: "tts.timeout", language: live.language });
          if (cur.detector.isStill) scheduleUtterance(nodeId, deviceId, cur, cfg);
        }
      }, 30_000);
      w.awaitingTts = { sentAt: Date.now(), watchdog };
      armedTtsWait = true;
      // Refill in parallel with the TTS hitting the phone — by the time
      // the user hears this quip, the next one is already cooking.
      refillCache(nodeId, live.model, live.language, live);
    } else {
      publishStatus(nodeId, deviceId, { state: "error", error: "model returned empty output" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    publishStatus(nodeId, deviceId, { state: "error", error: message });
  } finally {
    w.inflight = false;
    // Only auto-reschedule when we DIDN'T arm a tts wait (no quip sent
    // out, or empty / errored). Otherwise the spoken event drives it.
    if (!armedTtsWait && w.detector.isStill) scheduleUtterance(nodeId, deviceId, w, cfg);
  }
}

function scheduleUtterance(
  nodeId: string,
  deviceId: string,
  w: DeviceWatcher,
  cfg: DevConfig,
  opts: { immediate?: boolean } = {},
): void {
  if (w.utteranceTimer) return;
  // The first quip of an episode fires straight away — waiting 3 s on
  // the very first still detection feels like the demo is broken. Each
  // subsequent quip respects utterance_period_ms.
  const delay = opts.immediate ? 0 : cfg.utterance_period_ms;
  w.utteranceTimer = setTimeout(() => { void tick(nodeId, deviceId, w, cfg); }, delay);
}

function getCurrentConfigForNode(nodeId: string, fallback: DevConfig): DevConfig {
  const node = BrainService.current?.instanceRegistry.get(nodeId);
  if (!node) return fallback;
  return getConfig(node.config_overrides ?? {});
}

export const onSpawn: NodeOnSpawn = (info: NodeInfo) => {
  // Ensure the watcher map slot exists and is empty for this instance.
  watchers.set(info.id, new Map());
  // Pre-warm the cache for the configured language so the first
  // put-down has zero LLM latency. Fire-and-forget — refillCache caps
  // concurrency on its own.
  const cfg = getConfig(info.config_overrides ?? {});
  refillCache(info.id, cfg.model, cfg.language, cfg);
};

export const teardown: NodeTeardown = (info: NodeInfo) => {
  clearAllWatchers(info.id);
  clearCache(info.id);
};

export const handler: NodeHandler = (ctx: NodeContext) => {
  if (ctx.messages.length === 0) {
    ctx.sleep([{ type: "any" }]);
    return Promise.resolve();
  }

  const cfg = getConfig(ctx.node.config_overrides ?? {});

  for (const msg of ctx.messages) {
    // ── TTS completion: phone tells us when it has finished speaking ──
    const ttsStatusDevice = deviceFromTtsStatusTopic(msg.topic);
    if (ttsStatusDevice) {
      if (cfg.device_id && ttsStatusDevice !== cfg.device_id) continue;
      const meta = msg.metadata as { state?: string } | undefined;
      const state = meta?.state ?? "";
      if (state !== "spoken" && state !== "error" && state !== "cancelled") continue;
      const w = watchers.get(ctx.node.id)?.get(ttsStatusDevice);
      if (!w?.awaitingTts) continue;
      clearTimeout(w.awaitingTts.watchdog);
      w.awaitingTts = null;
      // Schedule the next quip — utterance_period_ms now measures the
      // GAP between two spoken lines, not between two send-to-phone
      // events. Closer to the user-facing rhythm they asked for.
      if (w.detector.isStill) scheduleUtterance(ctx.node.id, ttsStatusDevice, w, cfg);
      continue;
    }

    const deviceId = deviceFromAccelTopic(msg.topic);
    if (!deviceId) continue;
    if (cfg.device_id && deviceId !== cfg.device_id) continue;

    const sample = parseSample(msg);
    if (!sample) continue;

    // Keep the cache for the *current* language warm. Cheap — refillCache
    // bails immediately if we're already at target or capped on inflight
    // — so calling it on every accel sample is fine and gives instant
    // catch-up when the user toggles the language dropdown.
    refillCache(ctx.node.id, cfg.model, cfg.language, cfg);

    const w = getOrCreateWatcher(ctx.node.id, deviceId, cfg);
    if (!w.announced) {
      // Surface the device in the UI immediately, before we have enough
      // samples to make a stillness call. Otherwise the panel sits on
      // "No phone has reported yet" until the first transition fires.
      w.announced = true;
      publishStatus(ctx.node.id, deviceId, { state: "tracking" });
    }
    const verdict = w.detector.feed(sample);
    if (!verdict.changed) continue;

    if (verdict.isStill) {
      w.count = 0;
      publishStatus(ctx.node.id, deviceId, { state: "still", since: w.detector.stillSince });
      // Fire the first quip of this episode immediately; the loop in
      // tick() takes over with utterance_period_ms spacing afterwards.
      scheduleUtterance(ctx.node.id, deviceId, w, cfg, { immediate: true });
    } else {
      if (w.utteranceTimer) { clearTimeout(w.utteranceTimer); w.utteranceTimer = null; }
      if (w.awaitingTts) {
        clearTimeout(w.awaitingTts.watchdog);
        w.awaitingTts = null;
      }
      publishStatus(ctx.node.id, deviceId, { state: "active", utterances_during_episode: w.count });
      w.count = 0;
    }
  }

  return Promise.resolve();
};

export default handler;

// Test-only hooks — exported so unit tests can inspect / reset module state.
export const _testing = { watchers, getOrCreateWatcher, clearAllWatchers };
