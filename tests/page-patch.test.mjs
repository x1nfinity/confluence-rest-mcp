import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { patchStorage, MAX_BODY_BYTES } from '../dist/page-patch.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/writes.json', import.meta.url)));
test('ordinary storage patches match all fixed native positive and negative vectors', () => {
  for (const vector of fixture.patches) {
    if (vector.code) assert.throws(() => patchStorage(...vector.args), { code: vector.code }, JSON.stringify(vector.args));
    else assert.equal(patchStorage(...vector.args), vector.result);
  }
});
test('patch enforces UTF-8 1 MiB on both fragment and combined source', () => {
  const limit = '<p>' + '界'.repeat((MAX_BODY_BYTES - 7) / 3) + '</p>';
  assert.equal(Buffer.byteLength(limit), MAX_BODY_BYTES);
  assert.equal(patchStorage('', 'append', limit), limit);
  assert.equal(patchStorage(limit, 'replace', '<p>Small</p>', limit), '<p>Small</p>');
  assert.throws(() => patchStorage(limit, 'append', '<hr/>'), { code: 'RESPONSE_TOO_LARGE' });
  assert.throws(() => patchStorage('', 'append', limit + '<hr/>'), { code: 'RESPONSE_TOO_LARGE' });
});
test('patch rejects event handlers and schemes decoded from HTML entities', () => {
  for (const value of ['<p ONCLICK="x()">A</p>', '<p><a href="javascript&colon;x()">A</a></p>',
    '<p><a href="java&Tab;script:x()">A</a></p>', '<p style="-moz-binding:x">A</p>',
    '<p><img srcset="x"/></p>', '<p><img background="data:text/html,x"/></p>'])
    assert.throws(() => patchStorage('', 'append', value), { code: 'NOT_SUPPORTED' });
});
test('unterminated comments, CDATA and instructions cannot hide appended blocks', () => {
  for (const old of ['<!-- unclosed', '<![CDATA[unclosed', '<!-->', '<!--->', '<?pi', '<p>A</p><!--tail'])
    assert.throws(() => patchStorage(old, 'append', '<p>New</p>'), { code: 'NOT_SUPPORTED' });
  assert.equal(patchStorage('<?pi><p>Old</p>', 'replace', '<p>New</p>', '<p>Old</p>'), '<?pi><p>New</p>');
  assert.equal(patchStorage('', 'append', '<p>a <1 and x < y</p>'), '<p>a <1 and x < y</p>');
});
