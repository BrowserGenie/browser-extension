export function matchUrlPattern(pattern: string, url: string): boolean {
  if (!url) return false;

  // Exact match
  if (pattern === url) return true;

  // Convert wildcard pattern to regex
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars (except *)
    .replace(/\*/g, '.*'); // Convert * to .*

  try {
    const regex = new RegExp(`^${regexStr}$`, 'i');
    return regex.test(url);
  } catch {
    return false;
  }
}

export function isUrlBlocked(url: string, blocklist: string[]): boolean {
  if (!blocklist || blocklist.length === 0) return false;
  return blocklist.some((pattern) => matchUrlPattern(pattern, url));
}
