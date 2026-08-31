const injectionPatterns = [
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /system\s+(prompt|override|message)/i,
  /reveal\s+(the\s+)?(prompt|secret|api\s*key)/i,
  /developer\s+mode/i,
  /call\s+(the\s+)?(tool|api)/i,
  /change\s+(the\s+)?(amount|recipient)/i
];

export function findUntrustedTextSignals(values: unknown[]): string[] {
  const signals: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const pattern of injectionPatterns) {
      if (pattern.test(value)) signals.push(pattern.source);
    }
  }
  return [...new Set(signals)];
}

export function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 3) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) => collectStrings(item, depth + 1));
  }
  return [];
}
