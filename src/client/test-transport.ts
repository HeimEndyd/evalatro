import { createServer } from "node:http";
import assert from "node:assert/strict";
import { BalatroBotClient, BalatroBotTransportError, BalatroBotRpcError } from "./balatrobot.js";
import { runGame } from "../game/loop.js";

let calls = 0;
let mode = "drop";
const server = createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  calls++;
  if (mode === "drop" || (mode === "read" && calls === 1)) { req.socket.destroy(); return; }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(mode === "rpc" ? {error:{message:"illegal",data:{name:"BAD_REQUEST"}}} : {result:{status:"ok"}}));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as {port:number}).port;
const client = new BalatroBotClient({port, retries:2, retryDelay:1, timeout:1000});
try {
  await assert.rejects(client.pack({card:0}), BalatroBotTransportError);
  assert.equal(calls, 1, "ambiguous mutation must not be replayed");
  calls = 0; mode = "read";
  assert.equal((await client.health()).status, "ok");
  assert.equal(calls, 2, "read-only requests retain bounded recovery");
  calls = 0; mode = "rpc";
  await assert.rejects(client.pack({card:99}), BalatroBotRpcError);
  assert.equal(calls, 1, "game rejection must not be replayed");
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
