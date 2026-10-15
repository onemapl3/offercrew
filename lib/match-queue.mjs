// New work and old-policy/content reviews share a bounded batch. Alternate
// the queues, borrowing unused seats. The caller persists the next queue only
// when work is actually taken, so limit=1 and early budget stops stay fair.
export const MATCH_QUEUE = 'state/match-queue.json';
export const otherMatchQueue = queue => queue === 'review' ? 'fresh' : 'review';
export function matchQueueOrder({ fresh = 0, review = 0, limit = 0, next = 'fresh' } = {}) {
  const remaining = { fresh: Math.max(0, Math.floor(fresh)), review: Math.max(0, Math.floor(review)) };
  const order = [], size = Math.max(0, Math.floor(limit));
  let queue = next === 'review' ? 'review' : 'fresh';
  while (order.length < size && (remaining.fresh || remaining.review)) {
    if (!remaining[queue]) queue = otherMatchQueue(queue);
    order.push(queue); remaining[queue]--; queue = otherMatchQueue(queue);
  }
  return order;
}
