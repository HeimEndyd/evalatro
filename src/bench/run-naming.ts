export interface BenchRunIdentity {
  gameId: string;
  logFileName: string;
  startedAt: number;
}

/** Keep the database label intact while making one portable path segment. */
export function safePathSegment(value: string): string {
  const safe = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "_");
  return safe || "unnamed";
}

/**
 * Database convention: <model-label>:<seed>:r<repeat>:<epoch-ms>.
 * The JSONL carries the same identity without path-hostile characters.
 */
export function makeBenchRunIdentity(
  label: string,
  seed: string,
  repeat: number,
  startedAt = Date.now(),
): BenchRunIdentity {
  const gameId = `${label}:${seed}:r${repeat}:${startedAt}`;
  const logFileName =
    `${safePathSegment(label)}-${safePathSegment(seed)}-r${repeat}-${startedAt}.jsonl`;
  return { gameId, logFileName, startedAt };
}
