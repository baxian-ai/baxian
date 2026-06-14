const PLURAL_SINGULAR: Record<string, string> = {
  projects: 'project',
  agents: 'agent',
  labels: 'label',
  hosts: 'host',
};

export function normalizeConfig(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }

  const obj = raw as Record<string, unknown>;
  const result = normalizeKeys(obj);

  if (Array.isArray(result.project)) {
    result.project = result.project.map((item: unknown) => {
      if (typeof item === 'object' && item !== null) {
        return normalizeKeys(item as Record<string, unknown>);
      }
      return item;
    });
  }

  return result;
}

function normalizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const fromExplicitSingular: Record<string, boolean> = {};

  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    const singular = PLURAL_SINGULAR[lower] ?? lower;
    const isExplicitSingular = lower === singular;

    if (!(singular in result)) {
      result[singular] = value;
      fromExplicitSingular[singular] = isExplicitSingular;
      continue;
    }

    // Explicit singular wins over a previously-mapped plural, regardless of order.
    if (isExplicitSingular && !fromExplicitSingular[singular]) {
      result[singular] = value;
      fromExplicitSingular[singular] = true;
    }
  }

  return result;
}
