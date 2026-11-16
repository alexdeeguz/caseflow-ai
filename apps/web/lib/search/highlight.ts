export interface HighlightSegment {
  text: string;
  highlighted: boolean;
}

/**
 * Splits a snippet into plain and highlighted segments from server ranges. Ranges outside the
 * snippet, empty, or overlapping earlier ranges are ignored, so rendering can never fail.
 */
export function highlightSegments(
  snippet: string,
  highlights: readonly { start: number; end: number }[],
): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let cursor = 0;

  for (const { start, end } of [...highlights].sort((a, b) => a.start - b.start)) {
    const from = Math.max(start, cursor);
    const to = Math.min(end, snippet.length);
    if (from >= to) {
      continue;
    }
    if (from > cursor) {
      segments.push({ text: snippet.slice(cursor, from), highlighted: false });
    }
    segments.push({ text: snippet.slice(from, to), highlighted: true });
    cursor = to;
  }
  if (cursor < snippet.length) {
    segments.push({ text: snippet.slice(cursor), highlighted: false });
  }
  return segments;
}
