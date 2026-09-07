/** A partial or malformed sentinel is never evidence of completion. */
export function parseSentinel(content: string): 'completed' | 'failed' | null {
  const match = /^---\r?\nstatus: (completed|failed)\r?\n---(?:\r?\n|$)/.exec(content);
  return match ? match[1] as 'completed' | 'failed' : null;
}
