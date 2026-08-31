import { makeBenchRunIdentity, safePathSegment } from "./run-naming.js";

let failed = 0;
function check(name: string, condition: boolean): void {
  if (condition) console.log(`PASS ${name}`);
  else { console.error(`FAIL ${name}`); failed++; }
}

const label = "unsloth/Qwen3.8-27B-UD-Q6_K_M@kv=q8_0,out=16384,think=high";
const run = makeBenchRunIdentity(label, "BENCH01", 0, 1787446425433);

check("gameId follows central SQL convention", run.gameId === `${label}:BENCH01:r0:1787446425433`);
check(
  "log filename is portable and unique",
  run.logFileName ===
    "unsloth_Qwen3.8-27B-UD-Q6_K_M@kv=q8_0,out=16384,think=high-BENCH01-r0-1787446425433.jsonl",
);
check("forbidden characters are removed", !/[<>:"/\\|?*\u0000-\u001F]/.test(run.logFileName));
check("legacy backslashes are sanitized", safePathSegment("unsloth\\Qwen") === "unsloth_Qwen");
check("trailing Windows-hostile characters are replaced", safePathSegment("model. ") === "model_");
check("empty segment gets a stable fallback", safePathSegment("") === "unnamed");

if (failed) process.exit(1);
