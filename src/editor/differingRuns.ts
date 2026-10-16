// The runs in which two lists differ, found with Myers' diff ("An O(ND)
// Difference Algorithm and Its Variations", 1986). The split's mirror sync
// uses it to change only the lines or blocks an edit in the other pane
// changed (§6.1). Text between two changed places then keeps its positions,
// and with them the caret, the selection and the place of a dropped file
// that is still being read.

/** A run of items that differ: items `fromA` up to `toA` of the first list
 *  became items `fromB` up to `toB` of the second. */
export interface Run {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/**
 * The runs in which a list of `lengthA` items differs from one of `lengthB`
 * items, in order and as few as Myers' diff finds. `same(a, b)` tells whether
 * item `a` of the first list equals item `b` of the second. A diff that would
 * take more than about `budget` comparisons returns one run from the first
 * difference to the last instead, so a rewrite of a long list stays fast.
 */
export function differingRuns(
  lengthA: number,
  lengthB: number,
  same: (a: number, b: number) => boolean,
  budget = 1_000_000,
): Run[] {
  let start = 0;
  while (start < lengthA && start < lengthB && same(start, start)) start += 1;
  let endA = lengthA;
  let endB = lengthB;
  while (endA > start && endB > start && same(endA - 1, endB - 1)) {
    endA -= 1;
    endB -= 1;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 && m === 0) return [];
  const whole = [{ fromA: start, toA: endA, fromB: start, toB: endB }];
  if (n === 0 || m === 0) return whole;

  // Each round costs up to n + m comparisons, and the rounds kept for the way
  // back hold up to (rounds + 1)² numbers, which the budget also bounds.
  const rounds = Math.min(n + m, Math.floor(budget / (n + m)));
  const offset = rounds + 1;
  // The furthest point reached on each diagonal k = x - y, at index offset + k.
  const furthest = new Int32Array(2 * rounds + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= rounds; d += 1) {
    trace.push(furthest.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && furthest[offset + k - 1] < furthest[offset + k + 1]);
      let x = down ? furthest[offset + k + 1] : furthest[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && same(start + x, start + y)) {
        x += 1;
        y += 1;
      }
      furthest[offset + k] = x;
      if (x >= n && y >= m) return runsFromTrace(trace, n, m, start);
    }
  }
  return whole;
}

/** Walk back from the end through the rounds of the diff and join the
 *  insertions and deletions that touch into runs. */
function runsFromTrace(trace: Int32Array[], n: number, m: number, start: number): Run[] {
  const runs: Run[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    // The furthest points after round d - 1, for diagonals -d to d.
    const before = trace[d];
    const at = (k: number): number => before[k + d];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    // One insertion or deletion leads from (prevX, prevY) to (stepX, stepY),
    // and equal items lead on to (x, y).
    const stepX = down ? prevX : prevX + 1;
    const stepY = stepX - k;
    const last = runs[runs.length - 1];
    if (last && last.fromA === start + stepX && last.fromB === start + stepY) {
      last.fromA = start + prevX;
      last.fromB = start + prevY;
    } else {
      runs.push({ fromA: start + prevX, toA: start + stepX, fromB: start + prevY, toB: start + stepY });
    }
    x = prevX;
    y = prevY;
  }
  return runs.reverse();
}
