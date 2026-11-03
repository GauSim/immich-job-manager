import type { Scorer } from './score.js';

export interface FilenameScorerOptions {
  /** Added when any pattern matches. */
  score: number;
  reason?: string;
}

/** NFC, lower case, typographic apostrophes → `'`. */
export function normalizeName(s: string): string {
  return s.normalize('NFC').toLocaleLowerCase('en').replace(/[‘’ʼ]/g, "'");
}

/**
 * Matches `originalFileName` against patterns: case-insensitive substrings
 * (`Screenshot`, `Capture d’écran`), or regular expressions written as `/…/flags`.
 */
export function filenameScorer(
  patterns: string[],
  options: FilenameScorerOptions,
): Scorer {
  const matchers = patterns.map(toMatcher);
  const reason = options.reason ?? 'filename';
  return (asset) => {
    const name = asset.originalFileName ?? '';
    return matchers.some((m) => m(name))
      ? { score: options.score, reason }
      : null;
  };
}

function toMatcher(pattern: string): (name: string) => boolean {
  const regex = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (regex) {
    const re = new RegExp(regex[1], regex[2]);
    return (name) => re.test(name);
  }
  const needle = normalizeName(pattern);
  return (name) => needle !== '' && normalizeName(name).includes(needle);
}
