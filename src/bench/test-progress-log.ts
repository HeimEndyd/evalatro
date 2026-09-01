import * as fs from "fs";
import * as path from "path";
import { createProgressLog } from "./progress-log.js";

let failed = 0;
function check(name: string, condition: boolean): void {
  if (condition) console.log(`PASS ${name}`);
  else { console.error(`FAIL ${name}`); failed++; }
}

const base = path.resolve("..", "var", "tmp", "evalatro", `progress-log-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(base, { recursive: true });
process.env.EVALATRO_RUNS_DIR = base;

const first = createProgressLog("same-seed-1000");
first.write({ type: "game_start", gameId: "g1" });
first.write({ type: "decision_end", gameId: "g1", reasoning: "keep pair", action: { tool: "play_hand" } });
first.close();

const rows = fs.readFileSync(first.path, "utf8").trim().split("\n").map(line => JSON.parse(line));
check("progress JSONL is immediately readable and ordered", rows.length === 2 && rows[0].type === "game_start" && rows[1].type === "decision_end");
check("decision and reasoning are retained", rows[1].reasoning === "keep pair" && rows[1].action.tool === "play_hand");

let collision = false;
try { createProgressLog("same-seed-1000"); } catch (error: any) { collision = error?.code === "EEXIST"; }
check("existing run is never overwritten", collision);

const second = createProgressLog("same-seed-2000");
second.write({ type: "game_start", gameId: "g2" });
second.close();
check("runner restart uses a separate chronology", first.path !== second.path && fs.readFileSync(first.path, "utf8").includes("g1") && !fs.readFileSync(first.path, "utf8").includes("g2"));

fs.rmSync(base, { recursive: true });
if (failed) process.exit(1);
