import { decideWithRecovery, isRecoverableDecideError } from "./loop.js";
import { DecideFn } from "./decide.js";
import { SummarizedState } from "../state/summarizer.js";

let failed = 0;
function check(name: string, condition: boolean): void {
  if (condition) console.log(`PASS ${name}`);
  else { console.error(`FAIL ${name}`); failed++; }
}

const state = { state: "SELECTING_HAND" } as SummarizedState;
const ctx = { step: 7, legalActions: ["play_hand"] };

check("transport exhaustion is recoverable", isRecoverableDecideError(new Error("chat request failed: 503")));
check("game/parse failures are not recoverable", !isRecoverableDecideError(new Error("bad tool args")));

let calls = 0;
const sleeps: number[] = [];
const warnings: string[] = [];
const events: string[] = [];
const flaky: DecideFn = async (seenState, seenCtx) => {
  check("retry keeps the same state", seenState === state);
  check("retry keeps the same context", seenCtx === ctx);
  calls++;
  if (calls < 3) throw new Error("chat request failed: server restarting");
  return { tool: "play_hand", args: { cards: [0] } };
};

const recovered = await decideWithRecovery(flaky, state, ctx, {
  delayMs: 17,
  maxRetries: 5,
  sleep: async ms => { sleeps.push(ms); },
  warn: message => { warnings.push(message); },
  event: event => { events.push(event.type); },
});
check("recoverable request eventually returns decision", recovered.tool === "play_hand");
check("two failures cause two delayed retries", calls === 3 && sleeps.join(",") === "17,17");
check("recovery emits attempt and retry diagnostics", warnings.length === 4);
check("recovery emits structured chronology", events.join(",") === "request_start,request_failed,recovery_wait,recovery_retry,request_start,request_failed,recovery_wait,recovery_retry,request_start,request_end");

let terminalCalls = 0;
const terminal: DecideFn = async () => {
  terminalCalls++;
  throw new Error("chat request failed: still down");
};
try {
  await decideWithRecovery(terminal, state, ctx, {
    delayMs: 0,
    maxRetries: 2,
    sleep: async () => {},
    warn: () => {},
  });
  check("retry ceiling throws", false);
} catch (error) {
  check("retry ceiling throws original class", isRecoverableDecideError(error));
  check("maxRetries counts retries after the initial request", terminalCalls === 3);
}

let nonRecoverableCalls = 0;
const nonRecoverable: DecideFn = async () => {
  nonRecoverableCalls++;
  throw new Error("model output parse failed");
};
try {
  await decideWithRecovery(nonRecoverable, state, ctx, {
    delayMs: 0,
    maxRetries: 5,
    sleep: async () => {},
    warn: () => {},
  });
  check("non-recoverable error throws", false);
} catch {
  check("non-recoverable error is not retried", nonRecoverableCalls === 1);
}

if (failed) process.exit(1);
