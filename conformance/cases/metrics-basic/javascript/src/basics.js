export function straight(a) {
  return a + 1;
}

// A comment line: it counts toward the lines of the file but not toward loc.
export function branches(a, b) {
  if (a > 0 && b > 0) {
    return 1;
  } else if (a < 0 || b < 0) {
    return -1;
  }

  return 0;
}

export function loops(items, limit) {
  let total = 0;
  for (const item of items) {
    for (let i = 0; i < limit; i++) {
      if (item > i) {
        total += item;
      }
    }
  }

  return total;
}

export function switches(kind, text) {
  switch (kind) {
    case 1:
      return "one";
    case 2:
      return "two";
    default:
      return text;
  }
}
