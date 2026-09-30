import * as fs from "fs";
import * as os from "os";
import { request } from "undici";
import Database from "better-sqlite3";
import { RunRecord } from "./game/loop.js";
import { ModelConfig, BenchConfig } from "./config.js";
import { computeCodeHash, EVAL_VERSION } from "./scoring/codehash.js";
import { gameMoves } from "./bench/db.js";

const RUNNER_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync("package.json", "utf8")).version || "0.0.0"; } catch { return "0.0.0"; }
})();

/** Fail closed, including historical runs misclassified as gameplay stuck. */
export function publicationRejection(rec: RunRecord, moves: Array<{ illegal?: string | null; state?: any }>): string | null {
  if (!["won", "lost", "stuck"].includes(rec.outcome)) return `outcome=${rec.outcome}`;
  if (!rec.finalState || rec.actions <= 0 || moves.length !== rec.actions) return "incomplete game evidence";
  const gameRejection = (s: string) => /^(UNKNOWN_TOOL - |BAD_ARGS - |balatrobot error: (BAD_REQUEST|INVALID_STATE|NOT_ALLOWED) - )/.test(s);
  if (moves.some(m => m.illegal && !gameRejection(m.illegal))) return "non-game failure in transcript";
  if (rec.outcome === "won") return !rec.error && rec.won && rec.finalState.ante > rec.targetAnte ? null : "unconfirmed win";
  if (rec.outcome === "lost") return !rec.error && !rec.won && rec.finalState.state === "GAME_OVER" ? null : "unconfirmed loss";
  if (rec.won || ["GAME_OVER", "MENU"].includes(rec.finalState.state)) return "inconsistent stuck state";
  const illegal = /^stuck: (\d+) consecutive illegal moves \(last: (.*)\)$/.exec(rec.error ?? "");
  if (illegal) {
    const count = Number(illegal[1]);
    return count > 0 && count <= moves.length && gameRejection(illegal[2]) &&
      moves.slice(-count).every(m => !!m.illegal && gameRejection(m.illegal)) &&
      moves.at(-1)?.illegal === illegal[2] ? null : "unconfirmed illegal-move loop";
  }
  const stalled = /^stuck: no state change for (\d+) moves$/.exec(rec.error ?? "");
  if (!stalled || Number(stalled[1]) < 15 || moves.length < Number(stalled[1])) return "unrecognized stuck reason";
  // Same observable fields as the game loop's no-progress guard; all must exist.
  const signature = (s: any) => {
    if (!s || !Array.isArray(s.hand_cards) || !Array.isArray(s.jokers) || !Array.isArray(s.consumables)) return null;
    const cards = (a: any[]) => a.map(c => `${c.key}${c.enhancement ?? ""}${c.edition ?? ""}${c.seal ?? ""}`).join(",");
    return [s.state,s.ante,s.round,s.score?.chips,s.hands_left,s.discards_left,s.money,
      cards(s.hand_cards),s.jokers.map((j: any) => j.key).join(","),cards(s.consumables)].join("|");
  };
  const final = signature(rec.finalState);
  return final !== null && moves.slice(-Number(stalled[1])).every(m => signature(m.state) === final)
    ? null : "no-progress claim does not match transcript";
}

/** Assemble the submission payload from a finished run + its persisted moves.
 *  Sends the model's HOST only — never the full baseURL or the API key. */
export function buildSubmission(
  rec: RunRecord,
  moves: any[],
  model: ModelConfig,
  opts: { submitter?: string; startedAt?: number; endedAt?: number } = {},
) {
  const rejected = publicationRejection(rec, moves);
  if (rejected) throw new Error(`Publication rejected: ${rejected}`);
  let host = "local";
  try { host = new URL(model.baseURL).host; } catch { /* keep local */ }
  return {
    schemaVersion: 1,
    evalVersion: EVAL_VERSION,
    codeHash: computeCodeHash(),
    submittedAt: Date.now(),
    ...(opts.submitter ? { submitter: opts.submitter } : {}),
    model: { name: model.name, baseURLHost: host, modelId: model.model, mode: model.mode },
    config: { deck: rec.deck, stake: rec.stake, seed: rec.seed, targetAnte: rec.targetAnte },
    runRecord: rec,
    finalState: rec.finalState,
    moves: moves.map(m => ({
      step: m.step, ts: m.ts, state: m.state, tool: m.tool, args: m.args ?? {},
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      ...(m.notesSource === "explicit" && m.notes != null ? { notes: m.notes } : {}),
      ...(m.notesSource != null ? { notesSource: m.notesSource } : {}),
      illegal: m.illegal ?? null,
      ...(m.finishReason ? { finishReason: m.finishReason } : {}),
      ...((m.diagnostic || m.notes != null || m.notesSource != null) ? {
        diagnostic: {
          ...(m.diagnostic ?? {}),
          ...(m.notesSource === "explicit" && m.notes != null ? { notes: m.notes } : {}),
          ...(m.notesSource != null ? { notesSource: m.notesSource } : {}),
        },
      } : {}),
      tokensIn: m.tokensIn ?? 0, tokensOut: m.tokensOut ?? 0, costUsd: m.costUsd ?? 0,
    })),
    clientMeta: {
      os: `${process.platform} ${os.release()}`.trim(),
      runnerVersion: RUNNER_VERSION,
      nodeVersion: process.version,
      startedAt: opts.startedAt,
      endedAt: opts.endedAt ?? Date.now(),
    },
  };
}

export async function submitRun(baseUrl: string, submission: unknown): Promise<{ ok: boolean; status: number; body: any }> {
  const payload = submission as { runRecord?: RunRecord; moves?: Array<{ illegal?: string | null }> } | null;
  if (!payload?.runRecord || !Array.isArray(payload.moves)) throw new Error("Publication rejected: missing game evidence");
  const rejected = publicationRejection(payload.runRecord, payload.moves);
  if (rejected) throw new Error(`Publication rejected: ${rejected}`);
  const normalized = baseUrl.replace(/\/+$/, "");
  const url = normalized.endsWith("/api/runs") ? normalized : normalized + "/api/runs";
  const res = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(submission),
  });
  const body = await res.body.json().catch(() => ({}));
  return { ok: res.statusCode < 400, status: res.statusCode, body };
}

/** Submit a finished run to the configured backend, if enabled. Best-effort —
 *  a submission failure never breaks the run. Naive/baseline runs aren't sent. */
export async function maybeSubmit(db: Database.Database, rec: RunRecord, model: ModelConfig | null, cfg: BenchConfig): Promise<void> {
  if (!cfg.submit || !cfg.submitUrl || !model) return; // silently no-op when not configured
  try {
    const { moves } = gameMoves(db, rec.gameId);
    const rejected = publicationRejection(rec, moves);
    if (rejected) { console.error(`  submit skipped: ${rejected}`); return; }
    const submission = buildSubmission(rec, moves, model, { submitter: cfg.submitterHandle || undefined, startedAt: rec.ts });
    const r = await submitRun(cfg.submitUrl, submission);
    if (r.ok) console.error(`  submitted → score ${r.body.score ?? "?"}${r.body.official ? " (official)" : ""}${r.body.deduped ? " (dup)" : ""}`);
    else console.error(`  submit failed (${r.status}): ${JSON.stringify(r.body)}`);
  } catch (e: any) {
    console.error(`  submit error: ${e.message}`);
  }
}
