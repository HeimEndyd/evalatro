import { createServer } from "node:http";
import assert from "node:assert/strict";
import { BalatroBotClient, BalatroBotTransportError, BalatroBotRpcError } from "./balatrobot.js";
import { runGame } from "../game/loop.js";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

let calls = 0;
let mode = "drop";
const ids: unknown[] = [];
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  ids.push(JSON.parse(raw).id);
  calls++;
  if (mode === "drop" || (mode === "read" && calls === 1)) { req.socket.destroy(); return; }
  res.setHeader("Content-Type", "application/json");
  if (mode === "slow-body") {
    res.write('{"result":');
    return;
  }
  res.end(JSON.stringify(mode === "rpc" ? {error:{message:"illegal",data:{name:"BAD_REQUEST"}}} : {result:{status:"ok"}}));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as {port:number}).port;
const client = new BalatroBotClient({port, retries:2, retryDelay:1, timeout:1000});
const events: Array<Record<string, unknown>> = [];
client.setEventSink(event => events.push(event));
try {
  await assert.rejects(client.pack({card:0}), BalatroBotTransportError);
  assert.equal(calls, 1, "ambiguous mutation must not be replayed");
  calls = 0; mode = "read";
  assert.equal((await client.health()).status, "ok");
  assert.equal(calls, 2, "read-only requests retain bounded recovery");
  calls = 0; mode = "rpc";
  await assert.rejects(client.pack({card:99}), BalatroBotRpcError);
  assert.equal(calls, 1, "game rejection must not be replayed");
  assert.equal(new Set(ids).size, ids.length, "each wire attempt has a distinct RPC id");
  calls = 0; mode = "slow-body";
  const timed = new BalatroBotClient({port, retries:0, timeout:30, mutationTimeout:1000});
  timed.setEventSink(event => events.push(event));
  await assert.rejects(timed.health(), /timeout after 30ms/);
  assert.equal(calls, 1, "read-only timeout remains separate even with retries disabled");
  const last = events.at(-1)!;
  assert.equal(last.type, "game_rpc_error");
  assert.equal(last.failureKind, "transport");
  assert.equal(last.timeoutMs, 30);
  assert.ok(Number(last.durationMs) >= 20);
  assert.equal(events[0].type, "game_rpc_start");
  console.log("PASS transport: mutation once, read recovery, typed game rejection");
} finally { server.closeAllConnections(); server.close(); }

let decisions = 0;
const fake = {
  gamestate: async () => ({state:"MENU"}),
  start: async () => ({state:"BLIND_SELECT",ante_num:1,round_num:0,money:4,deck:"RED",stake:"WHITE",seed:"TEST"}),
  select: async () => { throw new BalatroBotTransportError("game transport failed (select): ECONNREFUSED"); },
} as unknown as BalatroBotClient;
const rec = await runGame(async () => { decisions++; return {tool:"select_blind",args:{}}; }, {
  client:fake, model:"test", gameId:"transport-test", seed:"TEST",
});
assert.equal(rec.outcome, "error");
assert.equal(rec.illegalActions, 0);
assert.equal(decisions, 1, "do not keep querying model on dead game");
console.log("PASS game transport failure is unscored error, not illegal/stuck");

// Exercise the real matrix runner, with fail-fast explicitly off. A dead game
// must not receive menu/start from seed two, even if the RPC server stays alive.
const dir = mkdtempSync(resolve(process.env.TMPDIR || ".", "evalatro-transport-"));
const methods: string[] = [];
const matrixServer = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const rpc = JSON.parse(raw);
  methods.push(rpc.method);
  if (!["health", "gamestate", "start"].includes(rpc.method)) { req.socket.destroy(); return; }
  const result = rpc.method === "health" ? {status:"ok"}
    : rpc.method === "gamestate" ? {state:"MENU"}
    : {state:"BLIND_SELECT",ante_num:1,round_num:0,money:4,deck:"RED",stake:"WHITE",seed:"TEST1"};
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({jsonrpc:"2.0", id:rpc.id, result}));
});
await new Promise<void>(resolve => matrixServer.listen(0, "127.0.0.1", resolve));
try {
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({launchMode:"attach",basePort:(matrixServer.address() as {port:number}).port}));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../bench/run.js", import.meta.url)), "naive", "--no-submit"], {
    cwd:dir, env:{...process.env, BALATRO_CONFIG:config, SEEDS:"TEST1,TEST2", RUNS_PER_SEED:"1",
      EVALATRO_FAIL_FAST:"0", WATCH:"", LAUNCH_MODE:"attach", BENCH_DB:join(dir,"bench.db"),
      EVALATRO_RUNS_DIR:join(dir,"progress"), SUBMIT:"false", LIVE_INGEST_URL:""},
    stdio:["ignore","pipe","pipe"],
  });
  let output = "";
  child.stdout.on("data", data => output += data);
  child.stderr.on("data", data => output += data);
  const deadline = setTimeout(() => child.kill("SIGKILL"), 15000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(deadline);
  assert.equal(code, 1, output);
  assert.match(output, /Fatal:.*game transport failed/);
  assert.equal(methods.filter(method => method === "start").length, 1, output);
  assert.equal(methods.includes("menu"), false);
  const logs = readdirSync(join(dir,"progress"));
  assert.equal(logs.length, 1);
  const progress = readFileSync(join(dir,"progress",logs[0]),"utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(progress.some(event => event.type === "db_persisted"));
  assert.ok(progress.some(event => event.type === "game_rpc_error" && event.failureKind === "transport"));
  console.log("PASS matrix stops on game transport failure without fail-fast; evidence persisted, no next seed");
} finally {
  matrixServer.closeAllConnections(); matrixServer.close();
  rmSync(dir, {recursive:true,force:true});
}
