export type KeyDictionary = Record<string, string[]>; // 표준 키 -> 가능한 원본 키 후보들

export function pruneJsonData<T extends object>(
  raw: Record<string, unknown>,
  allowedKeys: (keyof T)[],
  keyDictionary: KeyDictionary = {}
): Partial<T> {
  const result: Partial<T> = {};

  for (const key of allowedKeys) {
    const candidates = [key as string, ...(keyDictionary[key as string] ?? [])];
    const matchedKey = candidates.find((c) => c in raw);
    if (matchedKey !== undefined) {
      (result as Record<string, unknown>)[key as string] = raw[matchedKey];
    }
  }

  return result;
}
