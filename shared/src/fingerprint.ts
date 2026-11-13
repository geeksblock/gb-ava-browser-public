/**
 * A short, stable, non-reversible label for a secret, safe to log.
 *
 * It answers "is the token pasted into the extension the one the bridge holds?"
 * without exposing the token. It is NOT a security primitive: 32 bits of a cheap
 * hash over a 256-bit random token. Collisions are cosmetically confusing, never
 * dangerous.
 */

export function fingerprint(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    h1 = (h1 ^ code) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + Math.imul(code + i, 0x85ebca6b)) >>> 0;
    h2 = ((h2 << 13) | (h2 >>> 19)) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 8);
}
