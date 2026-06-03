/**
 * E2E for the phone-loneliness node, driven through a real BrainService +
 * its bus (no physical phone — accel samples are injected on the bus, exactly
 * as the mobile web app would publish them).
 *
 * Covers the three things that were broken in the field:
 *   1. The phone is DETECTED and its motion (in-motion / put-down) is reported
 *      continuously — not only on transitions (which got buried under the accel
 *      stream, so the panel said "no phone detected").
 *   2. The cache snapshot is HEARTBEATED, so the UI's cache map never reverts to
 *      "Pre-warming…" once it has loaded.
 *   3. When the phone is put down it SPEAKS a quip (cache hit, or live LLM
 *      fallback). Gated on a local Ollama model being available.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import { BrainService, LLMRegistry } from "@brain/core";

const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const TEST_MODEL = "ollama/gemma4:e4b";
// __dirname = .../phone-loneliness/tests ; up one = the node dir, up two = the
// `nodes/` dir the type scanner expects.
const NODES_DIR = path.resolve(__dirname, "..", "..");

async function ollamaUp(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return false;
    const d = (await r.json()) as { models?: Array<{ name: string }> };
    return Boolean(d.models?.some((m) => m.name.startsWith("gemma4:e4b")));
  } catch { return false; }
}

function delay(ms: number): Promise<void> { return new Promise((r) => { setTimeout(r, ms); }); }
async function waitFor(fn: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await delay(120); }
  return fn();
}

interface StatusMeta { deviceId?: string; state?: string }

describe("phone-loneliness e2e: motion status + cache heartbeat + utterance", () => {
  let brain: BrainService;
  let nodeId: string;
  let modelAvailable = false;

  beforeAll(async () => {
    modelAvailable = await ollamaUp();
    brain = new BrainService(":memory:");
    brain.bootstrap([NODES_DIR]);
    await LLMRegistry.getInstance().initialize();
    const node = await brain.spawnNode({
      type: "phone-loneliness",
      name: "e2e",
      subscriptions: [{ topic: "mobile.*" }],
      config_overrides: { model: TEST_MODEL, cache_target: 2, utterance_period_ms: 400 },
    });
    nodeId = node.id;
  }, 30_000);

  afterAll(() => { try { brain?.killAll(); } catch { /* */ } });

  function accel(dev: string, x: number, y: number, z: number, t: number): void {
    brain.bus.publish({
      from: "test-phone",
      topic: `mobile.${dev}.sensor.accel`,
      type: "text",
      criticality: 2,
      payload: { content: JSON.stringify({ x, y, z, t }) },
      metadata: { x, y, z, t },
    });
  }

  const statusFor = (dev: string): string[] =>
    brain.bus.getMessageHistory({ topic: "phone-loneliness.status" })
      .filter((m) => (m.metadata as StatusMeta | undefined)?.deviceId === dev)
      .map((m) => (m.metadata as StatusMeta).state ?? "");

  it("detects the phone, reports in-motion → put-down, and heartbeats the cache", async () => {
    const DEV = "e2ephone";

    // 1) In motion: varied samples → the device shows up (no LLM needed).
    const t0 = Date.now();
    for (let i = 0; i < 6; i++) accel(DEV, Math.sin(i) * 4, 9.8 + Math.cos(i) * 3, i, t0 + i * 100);
    expect(await waitFor(() => statusFor(DEV).includes("tracking"))).toBe(true);

    // 2) Put down: a steady ~2 s of constant samples at a regular cadence →
    //    "still" (enough to flush the in-motion samples out of the window).
    const t1 = Date.now();
    for (let i = 0; i < 20; i++) accel(DEV, 0.02, 9.81, 0.01, t1 + i * 100);
    expect(await waitFor(() => statusFor(DEV).includes("still"))).toBe(true);

    // 3) Cache snapshot keeps being published (heartbeat) so the UI map never
    //    reverts to "Pre-warming…" once loaded.
    expect(await waitFor(() => brain.bus.getMessageHistory({ topic: "phone-loneliness.cache" }).length > 0, 5000)).toBe(true);

    // 4) Even after a burst of inbound accel, the node's OWN publishes (the
    //    cache + status the UI renders) are still in its sent history — the
    //    fix that stops a 60 Hz stream from crowding them out of the panel.
    for (let i = 0; i < 50; i++) accel(DEV, Math.random(), 9.8, 0.1, Date.now());
    const sent = brain.bus.getMessageHistory({ from: nodeId, last: 50 });
    expect(sent.some((m) => m.topic === "phone-loneliness.cache")).toBe(true);
    expect(sent.some((m) => m.topic === "phone-loneliness.status")).toBe(true);
  }, 30_000);

  it("speaks a quip when the phone is put down", async () => {
    if (!modelAvailable) return; // gated: needs a local Ollama gemma4:e4b
    const DEV = "e2ephone2";
    // Let the prewarm land at least one quip first, so the put-down speaks
    // from cache instantly instead of racing a slow (~30s) live LLM call —
    // keeps the assertion decoupled from model latency / load.
    const cacheQuips = (): number => {
      const c = brain.bus.getMessageHistory({ topic: "phone-loneliness.cache" }).at(-1);
      const langs = (c?.metadata as { langs?: Record<string, { quips?: string[] }> } | undefined)?.langs ?? {};
      return Object.values(langs).reduce((n, l) => n + (l.quips?.length ?? 0), 0);
    };
    expect(await waitFor(() => cacheQuips() > 0, 90_000)).toBe(true);

    const t = Date.now();
    for (let i = 0; i < 20; i++) accel(DEV, 0.02, 9.81, 0.01, t + i * 100);
    const spoke = await waitFor(
      () =>
        brain.bus.getMessageHistory({ topic: `mobile.${DEV}.tts.speak` }).length > 0
        || statusFor(DEV).includes("uttered"),
      15_000,
    );
    expect(spoke).toBe(true);
  }, 120_000);
});
