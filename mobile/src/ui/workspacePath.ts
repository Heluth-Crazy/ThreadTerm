/**
 * Compare absolute workspace paths without changing the operational path sent
 * to the host. POSIX stays case-sensitive; Windows normalizes display forms.
 */
export function sameWorkspacePath(left: string | undefined, right: string | undefined) {
  if (!left || !right) return false;
  const asSlashes = (value: string) => value.replace(/\\/g, "/");
  const leftSlashes = asSlashes(left), rightSlashes = asSlashes(right);
  const windows =
    /^(?:\/\/\?\/)?[A-Za-z]:\//.test(leftSlashes) ||
    /^(?:\/\/\?\/)?[A-Za-z]:\//.test(rightSlashes) ||
    /^\/\/\?\/UNC\//i.test(leftSlashes) ||
    /^\/\/\?\/UNC\//i.test(rightSlashes) ||
    /^\/\/[^/]+\/[^/]+/.test(leftSlashes) ||
    /^\/\/[^/]+\/[^/]+/.test(rightSlashes);
  const normalize = (value: string) => {
    let comparable = asSlashes(value);
    if (/^\/\/\?\/UNC\//i.test(comparable)) comparable = `//${comparable.slice(8)}`;
    else if (/^\/\/\?\//.test(comparable)) comparable = comparable.slice(4);
    comparable = comparable.startsWith("//")
      ? `//${comparable.slice(2).replace(/\/{2,}/g, "/")}`
      : comparable.replace(/\/{2,}/g, "/");
    const minimumLength = windows && /^[A-Za-z]:\/$/.test(comparable) ? 3 : 1;
    return comparable.length > minimumLength
      ? comparable.replace(/\/+$/, "")
      : comparable;
  };
  const a = normalize(left), b = normalize(right);
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}
