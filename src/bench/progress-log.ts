import * as fs from "fs";
import * as path from "path";
import { SummarizedState } from "../state/summarizer.js";

export type ProgressEvent = Record<string, unknown> & { type: string };
export type ProgressSink = (event: ProgressEvent) => void;

function cards(items: SummarizedState["hand_cards"]): string[] {
  return items.map(card => card.hidden ? "?" : card.label || card.key);
}

/** Small, human-oriented state snapshot. Full replay state remains in raw JSONL. */
export function compactGameState(state: SummarizedState): Record<string, unknown> {
  return {
    phase: state.state,
    ante: state.ante,
    round: state.round,
    money: state.money,
    blind: state.blind ? {
      name: state.blind.name,
      type: state.blind.type,
      status: state.blind.status,
      target: state.blind.score,
      ...(state.blind.effect ? { effect: state.blind.effect } : {}),
    } : null,
    score: state.score,
    handsLeft: state.hands_left,
    discardsLeft: state.discards_left,
    hand: cards(state.hand_cards),
    jokers: cards(state.jokers),
    consumables: cards(state.consumables),
    ...(state.shop ? {
      shop: {
        cards: cards(state.shop.cards),
        vouchers: cards(state.shop.vouchers),
        packs: cards(state.shop.packs),
      },
    } : {}),
    ...(state.pack ? { pack: cards(state.pack.cards) } : {}),
  };
}

export interface ProgressLog {
  path: string;
  write: ProgressSink;
  close: () => void;
}

/** Collision-safe, synchronous JSONL: every event is readable immediately after write(). */
export function createProgressLog(fileStem: string): ProgressLog {
  const dir = path.resolve(process.env.EVALATRO_RUNS_DIR || path.join("..", "var", "runs", "evalatro"));
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${fileStem}.progress.jsonl`);
  const fd = fs.openSync(logPath, "wx", 0o640);
  let closed = false;
  return {
    path: logPath,
    write(event) {
      if (closed) throw new Error(`progress log is closed: ${logPath}`);
      fs.writeSync(fd, JSON.stringify({ ts: Date.now(), ...event }) + "\n");
      fs.fsyncSync(fd);
    },
    close() {
      if (closed) return;
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      closed = true;
    },
  };
}
