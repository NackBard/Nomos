export function reported(a) { let n = 0; for (const x of a) { for (const y of a) { n += x * y; } } return n; }

// nomos-disable-next-line ALG001
export function next(a) { let n = 0; for (const x of a) { for (const y of a) { n += x * y; } } return n; }

export function same(a) { let n = 0; for (const x of a) { for (const y of a) { n += x * y; } } return n; } // nomos-disable-line ALG001

// nomos-disable-next-line CC001
export function otherRule(a) { let n = 0; for (const x of a) { for (const y of a) { n += x * y; } } return n; }

export function reasoned(a) { let n = 0; for (const x of a) { for (const y of a) { n += x * y; } } return n; } // nomos-disable-line alg001, CC003 -- input is bounded
