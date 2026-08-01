export function normalizeProjectOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const candidate of value) {
    if (
      typeof candidate !== 'string' ||
      candidate.trim().length === 0 ||
      seen.has(candidate)
    ) {
      continue;
    }
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
}

export function orderProjectItems<T>(
  items: readonly T[],
  projectOrder: readonly string[],
  getPath: (item: T) => string,
  getName: (item: T) => string,
): T[] {
  const orderIndex = new Map(
    normalizeProjectOrder(projectOrder).map((projectPath, index) => [
      projectPath,
      index,
    ]),
  );

  return items
    .map((item, inputIndex) => ({ item, inputIndex }))
    .sort((left, right) => {
      const leftPath = getPath(left.item);
      const rightPath = getPath(right.item);
      const leftOrder = orderIndex.get(leftPath);
      const rightOrder = orderIndex.get(rightPath);

      if (leftOrder !== undefined || rightOrder !== undefined) {
        if (leftOrder === undefined) return 1;
        if (rightOrder === undefined) return -1;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      }

      return (
        compareCaseInsensitive(getName(left.item), getName(right.item)) ||
        compareCaseInsensitive(leftPath, rightPath) ||
        left.inputIndex - right.inputIndex
      );
    })
    .map(({ item }) => item);
}

export function reconcileProjectPathOrder(
  currentOrder: readonly string[],
  validProjectPaths: readonly string[],
): string[] {
  const validPaths = normalizeProjectOrder(validProjectPaths);
  const validSet = new Set(validPaths);
  const nextOrder = normalizeProjectOrder(currentOrder).filter((projectPath) =>
    validSet.has(projectPath),
  );
  const retained = new Set(nextOrder);

  for (const projectPath of validPaths) {
    if (retained.has(projectPath)) continue;
    retained.add(projectPath);
    nextOrder.push(projectPath);
  }
  return nextOrder;
}

export function moveProjectPath(
  currentOrder: readonly string[],
  activeProjectPath: string,
  overProjectPath: string,
  visibleProjectPaths: readonly string[],
): string[] {
  const fullOrder = normalizeProjectOrder([
    ...currentOrder,
    ...visibleProjectPaths,
  ]);
  const visibleSet = new Set(normalizeProjectOrder(visibleProjectPaths));
  const visibleOrder = fullOrder.filter((projectPath) =>
    visibleSet.has(projectPath),
  );
  const activeIndex = visibleOrder.indexOf(activeProjectPath);
  const overIndex = visibleOrder.indexOf(overProjectPath);

  if (
    activeProjectPath === overProjectPath ||
    activeIndex < 0 ||
    overIndex < 0
  ) {
    return fullOrder;
  }

  const reorderedVisible = [...visibleOrder];
  const [movedPath] = reorderedVisible.splice(activeIndex, 1);
  reorderedVisible.splice(overIndex, 0, movedPath);

  let visibleIndex = 0;
  return fullOrder.map((projectPath) =>
    visibleSet.has(projectPath)
      ? reorderedVisible[visibleIndex++]
      : projectPath,
  );
}

export function projectOrdersEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((projectPath, index) => projectPath === right[index])
  );
}

function compareCaseInsensitive(left: string, right: string): number {
  const normalizedLeft = left.toLocaleLowerCase();
  const normalizedRight = right.toLocaleLowerCase();
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
