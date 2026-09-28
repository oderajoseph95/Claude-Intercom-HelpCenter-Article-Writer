// Example source file an article cites in its `sources:` frontmatter.
export const MAX_ROWS = 10000; // exports stop at 10,000 orders per file
export function exportOrders(orders, { from, to }) {
  return orders.filter((o) => o.createdAt >= from && o.createdAt <= to).slice(0, MAX_ROWS);
}
