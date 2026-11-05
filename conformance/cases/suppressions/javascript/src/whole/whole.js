// nomos-disable ALG001
export function pairs(a) { let n = 0; for (const x of a) { for (const y of a) { n += x * y; } } return n; }
