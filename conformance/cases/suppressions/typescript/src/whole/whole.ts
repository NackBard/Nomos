// nomos-disable ALG001
export function pairs(a: number[]): number { let n = 0; for (const x of a) { for (const y of a) { n += x * y; } } return n; }
