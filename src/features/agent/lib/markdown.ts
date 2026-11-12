/** Only explicit web and email destinations are navigable in generated messages. */
function containsUnsafeUrlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function markdownUrl(value: string): string | undefined {
  const candidate = value.trim();
  if (containsUnsafeUrlCharacter(candidate)) return undefined;
  try {
    const url = new URL(candidate);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
