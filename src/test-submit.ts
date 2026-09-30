import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildSubmission, publicationRejection, submitRun } from "./submit.js";
import { SubmissionSchema } from "./server/schema.js";
import { RunRecord } from "./game/loop.js";

const state = {state:"SHOP",ante:2,round:3,score:{chips:0,target:300},hands_left:4,discards_left:4,money:8,hand_cards:[],jokers:[],consumables:[],deck:"RED",stake:"WHITE",seed:"TEST",won:false,blind:null,reroll_cost:5,used_vouchers:[],poker_hands:[],legal_actions:[]};
const base: RunRecord = {gameId:"test",model:"test",seed:"TEST",deck:"RED",stake:"WHITE",maxAnte:1,finalRound:3,finalMoney:8,score:1,illegalActions:0,durationMs:1,tokensIn:1,tokensOut:1,costUsd:0,ts:1,outcome:"lost",error:null,won:false,actions:1,targetAnte:12,finalState:{...state,state:"GAME_OVER"}};
const move = {illegal:null,state};
assert.equal(publicationRejection(base,[move]),null);
assert.equal(publicationRejection({...base,outcome:"won",won:true,finalState:{...base.finalState!,ante:13}},[move]),null);
for (const outcome of ["error","cap","unknown"])
  assert.ok(publicationRejection({...base,outcome:outcome as any},[move]));
assert.ok(publicationRejection({...base,finalState:{...base.finalState!,state:"MENU"}},[move]));
assert.ok(publicationRejection({...base,error:"transport failed"},[move]));
assert.ok(publicationRejection({...base,actions:2},[move]));
const rejection = "balatrobot error: BAD_REQUEST - Card index out of range";
const stuck = {...base,outcome:"stuck",actions:10,finalState:state,error:`stuck: 10 consecutive illegal moves (last: ${rejection})`} as RunRecord;
assert.equal(publicationRejection(stuck,Array(10).fill({...move,illegal:rejection})),null);
const broken = {...stuck,error:"stuck: 10 consecutive illegal moves (last: connect ECONNREFUSED 127.0.0.1:12347)"};
assert.ok(publicationRejection(broken,Array(10).fill({...move,illegal:"connect ECONNREFUSED 127.0.0.1:12347"})));
assert.ok(publicationRejection(stuck,[{...move,illegal:"This operation was aborted"},...Array(9).fill({...move,illegal:rejection})]));
const noProgress = {...stuck,actions:15,error:"stuck: no state change for 15 moves"};
assert.equal(publicationRejection(noProgress,Array(15).fill(move)),null);
assert.ok(publicationRejection(noProgress,[{...move,state:{...state,money:9}},...Array(14).fill(move)]));
assert.ok(publicationRejection(noProgress,Array(15).fill({illegal:null})));
const withNotes = buildSubmission(base,[{...move,step:0,tool:"next_round",args:{},notes:"Buy a joker",notesSource:"explicit",diagnostic:{finishReason:"tool_calls"}}],
  {name:"test",model:"test",baseURL:"http://127.0.0.1",mode:"tools"} as any);
assert.equal((withNotes.moves[0].diagnostic as any).notes,"Buy a joker");
assert.equal((withNotes.moves[0].diagnostic as any).notesSource,"explicit");
assert.equal((withNotes.moves[0].diagnostic as any).finishReason,"tool_calls");
assert.ok(SubmissionSchema.safeParse(withNotes).success,"notes payload remains compatible with submission schema");
const fallbackNotes = buildSubmission(base,[{...move,step:0,tool:"next_round",args:{},reasoning:"long reasoning",notes:"long reasoning",notesSource:"reasoning"}],
  {name:"test",model:"test",baseURL:"http://127.0.0.1",mode:"tools"} as any);
assert.equal((fallbackNotes.moves[0].diagnostic as any).notesSource,"reasoning");
assert.equal((fallbackNotes.moves[0].diagnostic as any).notes,undefined,"fallback text stays in reasoning only");

let posts = 0;
const server=createServer(async(req,res)=>{for await(const _ of req){} posts++;res.setHeader("Content-Type","application/json");res.end('{}');});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
try {
  await assert.rejects(submitRun(url,{runRecord:{...base,outcome:"error"},moves:[move]}),/Publication rejected/);
  await assert.rejects(submitRun(url,{runRecord:broken,moves:Array(10).fill(move)}),/Publication rejected/);
  await assert.rejects(submitRun(url,{}),/Publication rejected/);
  assert.equal(posts,0,"rejected runs must never reach HTTP");
  assert.equal((await submitRun(url,{runRecord:base,moves:[move]})).ok,true);
  assert.equal(posts,1);
} finally { server.closeAllConnections();server.close(); }
console.log("PASS publication: wins/losses/real stuck allowed; infra/errors/incomplete blocked before HTTP");
