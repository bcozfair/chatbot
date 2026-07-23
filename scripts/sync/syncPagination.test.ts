// รัน: npx tsx --test scripts/sync/syncPagination.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePageTransition, MAX_STALL_RETRIES } from './syncPagination.js';

const base = { maxStallRetries: MAX_STALL_RETRIES, stallRetries: 0, previousCursor: 'A' as string | null };

test('has_more=false → complete (ให้ flip incremental ได้)', () => {
  assert.deepEqual(
    decidePageTransition({ ...base, hasMore: false, nextCursor: 'B' }),
    { action: 'complete' }
  );
});

test('has_more=true + cursor ขยับปกติ → advance', () => {
  assert.deepEqual(
    decidePageTransition({ ...base, hasMore: true, nextCursor: 'B', previousCursor: 'A' }),
    { action: 'advance' }
  );
});

test('หน้าแรก (previousCursor=null) + มี next_cursor → advance', () => {
  assert.deepEqual(
    decidePageTransition({ ...base, hasMore: true, nextCursor: 'B', previousCursor: null }),
    { action: 'advance' }
  );
});

test('has_more=true แต่ next_cursor หาย → error (ไม่จบแบบเงียบ)', () => {
  assert.equal(decidePageTransition({ ...base, hasMore: true, nextCursor: null }).action, 'error');
  assert.equal(decidePageTransition({ ...base, hasMore: true, nextCursor: undefined }).action, 'error');
  assert.equal(decidePageTransition({ ...base, hasMore: true, nextCursor: '' }).action, 'error');
});

test('cursor ไม่ขยับ + ยัง retry ได้ → retry-stall', () => {
  assert.deepEqual(
    decidePageTransition({ ...base, hasMore: true, nextCursor: 'A', previousCursor: 'A', stallRetries: 0 }),
    { action: 'retry-stall' }
  );
  assert.deepEqual(
    decidePageTransition({ ...base, hasMore: true, nextCursor: 'A', previousCursor: 'A', stallRetries: 1 }),
    { action: 'retry-stall' }
  );
});

test('cursor ไม่ขยับ + retry ครบเพดาน → error (silent truncation ต้องกลายเป็น failed)', () => {
  const r = decidePageTransition({ ...base, hasMore: true, nextCursor: 'A', previousCursor: 'A', stallRetries: MAX_STALL_RETRIES });
  assert.equal(r.action, 'error');
  assert.match((r as any).reason, /stalled/);
});
