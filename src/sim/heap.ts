/**
 * A binary min-heap: the simulation keeps events that are still on their way in one, ordered by when they
 * arrive, so that events sent in order come out in the order a lagging pipeline would deliver them.
 */
interface Heap<Item> {
  readonly push: (item: Item) => void;
  /** The least item, without taking it. */
  readonly peek: () => Item | undefined;
  readonly pop: () => Item | undefined;
  readonly size: () => number;
  readonly items: () => readonly Item[];
}

function createHeap<Item>(keyOf: (item: Item) => number): Heap<Item> {
  const items: Item[] = [],
    swap = (left: number, right: number): void => {
      const held = items[left];
      items[left] = items[right];
      items[right] = held;
    },
    before = (left: number, right: number): boolean => keyOf(items[left]) < keyOf(items[right]),
    rise = (start: number): void => {
      let at = start;
      while (at > 0 && before(at, Math.floor((at - 1) / 2))) {
        swap(at, Math.floor((at - 1) / 2));
        at = Math.floor((at - 1) / 2);
      }
    },
    least = (at: number): number => {
      const left = 2 * at + 1,
        right = left + 1,
        first = left < items.length && before(left, at) ? left : at;
      return right < items.length && before(right, first) ? right : first;
    },
    sink = (start: number): void => {
      let at = start,
        next = least(at);
      while (next !== at) {
        swap(at, next);
        at = next;
        next = least(at);
      }
    };
  return {
    items: () => items,
    peek: () => items.at(0),
    pop: () => {
      const top = items.at(0),
        last = items.pop();
      if (items.length > 0 && last !== undefined) {
        items[0] = last;
        sink(0);
      }
      return top;
    },
    push: (item) => {
      items.push(item);
      rise(items.length - 1);
    },
    size: () => items.length,
  };
}

export type { Heap };
export { createHeap };
