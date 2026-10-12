// Match Python's line-based SequenceMatcher, including its popular-line heuristic.
export function unifiedDiff(before: string, after: string, fromfile: string, tofile: string, markMissingNewline = true): string {
  const split = (s: string) => s.match(/[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]|$)/gu)?.filter(Boolean) ?? [];
  const a = split(before), b = split(after), index = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) { const positions = index.get(b[j]) ?? []; positions.push(j); index.set(b[j], positions); }
  if (b.length >= 200) for (const [line, positions] of index) if (positions.length > Math.floor(b.length / 100) + 1) index.delete(line);
  const queue: number[][] = [[0, a.length, 0, b.length]], blocks: number[][] = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    let besti = alo, bestj = blo, bestsize = 0, previous = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const current = new Map<number, number>();
      for (const j of index.get(a[i]) ?? []) {
        if (j < blo) continue; if (j >= bhi) break;
        const k = (previous.get(j - 1) ?? 0) + 1; current.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      previous = current;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; bestsize++; }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    if (bestsize) {
      blocks.push([besti, bestj, bestsize]);
      if (alo < besti && blo < bestj) queue.push([alo, besti, blo, bestj]);
      if (besti + bestsize < ahi && bestj + bestsize < bhi) queue.push([besti + bestsize, ahi, bestj + bestsize, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: number[][] = [];
  for (const block of blocks) { const last = merged.at(-1);
    if (last && last[0] + last[2] === block[0] && last[1] + last[2] === block[1]) last[2] += block[2]; else merged.push([...block]); }
  merged.push([a.length, b.length, 0]);
  type Code = [string, number, number, number, number];
  const codes: Code[] = []; let i = 0, j = 0;
  for (const [ai, bj, size] of merged) {
    if (i < ai || j < bj) codes.push([i < ai && j < bj ? 'replace' : i < ai ? 'delete' : 'insert', i, ai, j, bj]);
    if (size) codes.push(['equal', ai, ai + size, bj, bj + size]);
    i = ai + size; j = bj + size;
  }
  if (!codes.length || codes.every(c => c[0] === 'equal')) return '';
  const first = codes[0], last = codes.at(-1)!;
  if (first[0] === 'equal') { first[1] = Math.max(first[1], first[2] - 3); first[3] = Math.max(first[3], first[4] - 3); }
  if (last[0] === 'equal') { last[2] = Math.min(last[2], last[1] + 3); last[4] = Math.min(last[4], last[3] + 3); }
  const groups: Code[][] = []; let group: Code[] = [];
  for (const [tag, a1, a2, b1, b2] of codes) {
    if (tag === 'equal' && a2 - a1 > 6) { group.push([tag, a1, a1 + 3, b1, b1 + 3]); groups.push(group); group = []; group.push([tag, a2 - 3, a2, b2 - 3, b2]); }
    else group.push([tag, a1, a2, b1, b2]);
  }
  if (group.length && !(group.length === 1 && group[0][0] === 'equal')) groups.push(group);
  const range = (start: number, stop: number) => stop - start === 1 ? String(start + 1) : `${stop === start ? start : start + 1},${stop - start}`;
  const out = [`--- ${fromfile}\n`, `+++ ${tofile}\n`];
  const emit = (prefix: string, line: string) => out.push(prefix + line + (markMissingNewline && !line.endsWith('\n') ? '\n\\ No newline at end of file\n' : ''));
  for (const g of groups) {
    out.push(`@@ -${range(g[0][1], g.at(-1)![2])} +${range(g[0][3], g.at(-1)![4])} @@\n`);
    for (const [tag, a1, a2, b1, b2] of g) {
      if (tag === 'equal') for (const line of a.slice(a1, a2)) emit(' ', line);
      if (tag === 'delete' || tag === 'replace') for (const line of a.slice(a1, a2)) emit('-', line);
      if (tag === 'insert' || tag === 'replace') for (const line of b.slice(b1, b2)) emit('+', line);
    }
  }
  return out.join('');
}
