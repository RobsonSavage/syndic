import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSentinel } from '../dist/sentinel.js';

test('only the single frontmatter status controls completion', () => {
  assert.equal(parseSentinel('---\nstatus: completed\n---\nreview status: failed'), 'completed');
  assert.equal(parseSentinel('---\r\nstatus: failed\r\n---\r\nSummary'), 'failed');
  for (const text of ['', 'status: completed', '---\nstatus: completed',
    '---\nstatus: completed\nstatus: failed\n---', '---\nstatus: unknown\n---',
    '---\nother: completed\n---', 'prose\n---\nstatus: completed\n---']) {
    assert.equal(parseSentinel(text), null, text);
  }
});
