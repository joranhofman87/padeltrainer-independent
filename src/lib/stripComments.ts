/**
 * Remove comments from TypeScript or SQL, so a guard can be pointed at what the code DOES.
 *
 * This exists because of a real failure: the U2 inventory guard asserted that each identity site
 * "carries the distinction in writing", and several of its other assertions matched happily on
 * prose. A file could therefore describe the rule perfectly while breaking it one line below, and
 * a comment mentioning `.eq('email'` could make a detector fire on a file that does nothing of the
 * kind. Explaining yourself and behaving correctly are different claims and need different checks.
 *
 * String literals are preserved: a `--` inside a SQL string, or `//` inside a TS one, is data.
 * Dollar-quoted SQL bodies are preserved whole, which matters because every function in this repo
 * lives inside one.
 */
export type CommentLang = 'ts' | 'sql';

export function stripComments(source: string, lang: CommentLang): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // ── quoted regions are copied verbatim ──
    if (ch === "'" || ch === '"' || (lang === 'ts' && ch === '`')) {
      const quote = ch;
      out.push(ch);
      i++;
      while (i < n) {
        if (source[i] === '\\' && lang === 'ts') {
          out.push(source[i], source[i + 1] ?? '');
          i += 2;
          continue;
        }
        // SQL escapes a quote by doubling it
        if (lang === 'sql' && source[i] === quote && source[i + 1] === quote) {
          out.push(quote, quote);
          i += 2;
          continue;
        }
        out.push(source[i]);
        if (source[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }

    // ── dollar-quoted SQL bodies ($$ ... $$ / $tag$ ... $tag$) ──
    if (lang === 'sql' && ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(source.slice(i));
      if (tag) {
        const close = source.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? n : close + tag[0].length;
        // recurse: the BODY is SQL too, and its `--` comments must go
        out.push(tag[0], stripComments(source.slice(i + tag[0].length, close === -1 ? n : close), 'sql'), tag[0]);
        i = end;
        continue;
      }
    }

    // ── comments ──
    if (lang === 'sql' && ch === '-' && next === '-') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (lang === 'ts' && ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join('');
}
