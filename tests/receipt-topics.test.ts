import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReceiptLogsBloom } from '../src/receipt-bloom.ts';

const emitter = '0x' + 'ab'.repeat(20);
const topics = Array.from({ length: 6 }, (_, index) => '0x' + (index + 1).toString(16).padStart(64, '0'));

test('five valid-width topics cannot form an EVM receipt log', () => {
  assert.equal(computeReceiptLogsBloom([{ address: emitter, topics: topics.slice(0, 5) }]), undefined);
});

for (let count = 0; count <= 4; count++) {
  test(count === 4 ? 'an anonymous log can retain all four indexed topics' : `LOG${count} remains a valid receipt log`, () => {
    const indexed = topics.slice(0, count);
    const actual = computeReceiptLogsBloom([{ address: emitter, topics: indexed }]);
    assert.equal(typeof actual, 'string');
    assert.match(actual!, /^0x[0-9a-f]{512}$/);
    assert.notEqual(actual, '0x' + '00'.repeat(256), 'A LOG0 entry still includes its emitter');
    // Splitting indexed values into LOG1 entries preserves their bloom union.
    // This is a shape-regression control, not an independent bloom oracle.
    const split = count === 0 ? [{ address: emitter, topics: [] }] :
      indexed.map(topic => ({ address: emitter, topics: [topic] }));
    assert.equal(actual, computeReceiptLogsBloom(split));
  });
}

test('four repeated topics remain valid because bloom membership is idempotent', () => {
  const actual = computeReceiptLogsBloom([{ address: emitter, topics: Array(4).fill(topics[0]) }]);
  assert.equal(typeof actual, 'string');
  assert.equal(actual, computeReceiptLogsBloom([{ address: emitter, topics: [topics[0]] }]));
});

test('an over-limit foreign log invalidates the whole bloom before, between or after valid entries', () => {
  const valid = [{ address: emitter, topics: [] }, { address: emitter, topics: [topics[0]] }];
  assert.equal(typeof computeReceiptLogsBloom(valid), 'string');
  for (const count of [5, 6]) for (let position = 0; position <= valid.length; position++) {
    const logs = [...valid];
    logs.splice(position, 0, { address: '0x' + 'cd'.repeat(20), topics: topics.slice(0, count) });
    assert.equal(computeReceiptLogsBloom(logs), undefined, `${count} topics at receipt position ${position}`);
  }
});

test('an empty receipt retains its zero bloom', () => {
  assert.equal(computeReceiptLogsBloom([]), '0x' + '00'.repeat(256));
});
