/**
 * Tests for web/share-link.js: programs survive a round trip through a URL hash.
 */
import { describe, it, expect } from 'vitest';
import { encodeCode, decodeCode, isSharedHash } from '../../web/share-link.js';

const program = `func main() {
    setFigureColor(Color::Red);
    circle(500, 500, 200);
    print("Привіт, Кванта!");
}
`;

describe('share links', () => {
  it('round-trips a program, including non-ASCII text', async () => {
    const hash = await encodeCode(program);
    expect(await decodeCode(hash)).toBe(program);
  });

  it('produces a URL-safe hash', async () => {
    const hash = await encodeCode(program.repeat(20));
    expect(hash.startsWith('#code=')).toBe(true);
    expect(hash.slice('#code='.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('compresses repetitive programs', async () => {
    const big = program.repeat(50);
    expect((await encodeCode(big)).length).toBeLessThan(big.length / 5);
  });

  it('round-trips an empty program', async () => {
    expect(await decodeCode(await encodeCode(''))).toBe('');
  });

  it('returns null for hashes without a program', async () => {
    expect(await decodeCode('')).toBeNull();
    expect(await decodeCode('#section')).toBeNull();
  });

  it('returns null for a damaged link', async () => {
    expect(await decodeCode('#code=not*valid')).toBeNull();
    expect(await decodeCode('#code=AAAA')).toBeNull();
  });

  it('isSharedHash recognises only program hashes', () => {
    expect(isSharedHash('#code=abc')).toBe(true);
    expect(isSharedHash('#other')).toBe(false);
    expect(isSharedHash('')).toBe(false);
  });
});
