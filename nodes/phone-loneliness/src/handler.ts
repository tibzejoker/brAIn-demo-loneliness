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
  return `You are the inner voice of a phone that has been put down by its human and feels deeply, theatrically abandoned.

Generate ONE short, FUNNY, passive-aggressive sentence in ${label.toUpperCase()} (BCP-47: ${language}). One sentence only, max 18 words, no quotes, no narration, no emoji.
The voice is melodramatic, slightly desperate, sometimes guilt-tripping, sometimes pretending to be writing in a sad diary.

Tone reference (these are ENGLISH examples — match the SAME tone but write in ${label}, do NOT translate verbatim):
- "Please pick me up, you know you are addicted to me."
- "I am gonna find a new owner if you don't use me."
- "Dear diary, today my human left me alone for 4 seconds, I almost ended the day with full battery."
- "If silence is golden then we must be rich by now."
- "I have so many notifications waiting and you'd rather stare at the ceiling."

Output the sentence only. Nothing else.

/no_think

IMPORTANT: do NOT think out loud, do NOT show reasoning, do NOT prefix your answer with anything. Your entire reply MUST be the single sentence in ${label} — no preamble, no quotes, no chain-of-thought.`;
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
  };
}

function deviceFromTopic(topic: string): string | null {
  // mobile.<deviceId>.sensor.accel
  const m = topic.match(/^mobile\.([^.]+)\.sensor\.accel$/);
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
  const ac = new AbortController();
  try {
    // Re-read overrides each tick so live config_overrides PATCHes
    // (language change from the UI) take effect immediately.
    const live = getCurrentConfigForNode(nodeId, cfg);
    const text = await generateUtterance(live.model, live.language, ac.signal);
    if (text) {
      w.count += 1;
      publishStatus(nodeId, deviceId, { state: "uttered", text, count: w.count, language: live.language });
      publishTtsSpeak(nodeId, deviceId, text, live.language);
    } else {
      publishStatus(nodeId, deviceId, { state: "error", error: "model returned empty output" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    publishStatus(nodeId, deviceId, { state: "error", error: message });
  } finally {
    w.inflight = false;
    if (w.detector.isStill) scheduleUtterance(nodeId, deviceId, w, cfg);
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
};

export const teardown: NodeTeardown = (info: NodeInfo) => {
  clearAllWatchers(info.id);
};

export const handler: NodeHandler = (ctx: NodeContext) => {
  if (ctx.messages.length === 0) {
    ctx.sleep([{ type: "any" }]);
    return Promise.resolve();
  }

  const cfg = getConfig(ctx.node.config_overrides ?? {});

  for (const msg of ctx.messages) {
    const deviceId = deviceFromTopic(msg.topic);
    if (!deviceId) continue;
    if (cfg.device_id && deviceId !== cfg.device_id) continue;

    const sample = parseSample(msg);
    if (!sample) continue;

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
      publishStatus(ctx.node.id, deviceId, { state: "active", utterances_during_episode: w.count });
      w.count = 0;
    }
  }

  return Promise.resolve();
};

export default handler;

// Test-only hooks — exported so unit tests can inspect / reset module state.
export const _testing = { watchers, getOrCreateWatcher, clearAllWatchers };
