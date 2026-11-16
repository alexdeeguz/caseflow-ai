import assert from 'node:assert/strict';
import { test } from 'node:test';
import { minimumSimilarity, parseHeadline, trimLeadingFragment } from '../src/database/search.js';

test('short queries need a stricter meaning-based floor than longer ones', () => {
  assert.equal(minimumSimilarity('car accident'), 0.36);
  assert.equal(minimumSimilarity('  lumbar   MRI report '), 0.36);
  assert.equal(minimumSimilarity('when did physical therapy start'), 0.3);
});

test('meaning-only snippets start at the first full sentence', () => {
  const snippet =
    'the display edge. The companion remained nearby and called an employee. Castillo reported pain in the left ankle.';

  assert.deepEqual(trimLeadingFragment({ snippet, highlights: [] }), {
    snippet:
      'The companion remained nearby and called an employee. Castillo reported pain in the left ankle.',
    highlights: [],
  });
});

test('trimming keeps highlights aligned and never drops a highlight', () => {
  const snippet =
    'of the visit. The patient reported neck pain after the collision and returned for therapy twice.';
  const cut = snippet.indexOf('The');
  const neck = snippet.indexOf('neck');

  assert.deepEqual(
    trimLeadingFragment({ snippet, highlights: [{ start: neck, end: neck + 4 }] }).highlights,
    [{ start: neck - cut, end: neck - cut + 4 }],
  );
  const leading = { snippet, highlights: [{ start: 0, end: 2 }] };
  assert.equal(trimLeadingFragment(leading), leading);
});

test('trimming leaves sentence starts, short remainders and unbroken text alone', () => {
  const capitalised = { snippet: 'Initial evaluation completed. Plan reviewed.', highlights: [] };
  assert.equal(trimLeadingFragment(capitalised), capitalised);

  const short = { snippet: 'the bumper. Both vehicles stopped.', highlights: [] };
  assert.equal(trimLeadingFragment(short), short);

  const unbroken = {
    snippet: 'and household tasks have resumed without restriction',
    highlights: [],
  };
  assert.equal(trimLeadingFragment(unbroken), unbroken);
});

test('headlines become plain text with ordered highlight ranges', () => {
  assert.deepEqual(parseHeadline('Lumbar \u0001MRI\u0002 ordered'), {
    snippet: 'Lumbar MRI ordered',
    highlights: [{ start: 7, end: 10 }],
  });
});
