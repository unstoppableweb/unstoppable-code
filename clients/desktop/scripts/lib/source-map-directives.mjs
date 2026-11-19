/**
 * Blanks `//# sourceMappingURL=` directive comments in shipped JavaScript.
 * The Linux package policy refuses source-map comments outside the app ASAR's
 * dependencies, so loose Linux payloads (the daemon's node-pty, CAN-4966)
 * ship without them. Comments become spaces of the same length, so line and
 * column positions stay stable.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** `source` with every source-map directive comment replaced by spaces. */
export function blankSourceMapDirectives(source, fileName = 'file.js') {
  // Loaded on use: most importers of the node-pty staging never strip.
  const ts = require('typescript');
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const directives = new Map();
  const collect = (ranges) => {
    for (const range of ranges ?? []) {
      const comment = source.slice(range.pos, range.end);
      const contents = comment.startsWith('//')
        ? comment.slice(2)
        : comment.slice(2, -2);
      if (/^\s*[#@]\s*sourceMappingURL\s*=/.test(contents))
        directives.set(range.pos, range.end);
    }
  };
  // Token boundaries keep strings, regular expressions and template text out
  // of trivia scanning; getChildren includes punctuation and EOF.
  const nodes = [parsed];
  while (nodes.length > 0) {
    const node = nodes.pop();
    collect(ts.getLeadingCommentRanges(source, node.pos));
    collect(ts.getTrailingCommentRanges(source, node.end));
    for (const child of node.getChildren(parsed)) nodes.push(child);
  }
  if (directives.size === 0) return source;
  const pieces = [];
  let cursor = 0;
  for (const [start, end] of [...directives].sort(([a], [b]) => a - b)) {
    pieces.push(
      source.slice(cursor, start),
      source.slice(start, end).replace(/[^\r\n\u2028\u2029]/g, ' '),
    );
    cursor = end;
  }
  pieces.push(source.slice(cursor));
  return pieces.join('');
}
