export type UiText = string | number;
export type UiComponent =
  | { type: 'card'; title?: string; children?: UiComponent[] }
  | { type: 'stat'; label: string; value: UiText }
  | { type: 'table'; columns: string[]; rows: UiText[][] }
  | { type: 'list'; items: string[] }
  | { type: 'badge'; text: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }
  | { type: 'progress'; label?: string; value: number; max?: number }
  | { type: 'chart'; kind: 'bar' | 'line' | 'pie'; title?: string; data: { label: string; value: number }[] };
export type GeneratedUiSpec = { version: 1; components: UiComponent[]; buttons?: { label: string; text: string }[] };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, limit = 2000): value is string => typeof value === 'string' && value.length <= limit;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12;
const text = (value: unknown) => string(value) || number(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
/** Bounded strict whitelist: unknown keys, recursive bombs and nonfinite numbers fail closed. */
export function parseGeneratedUi(source: string): { spec?: GeneratedUiSpec; error?: string } {
  try {
    if (new TextEncoder().encode(source).length > 64 * 1024) throw new Error('Invalid spec: maximum size is 64 KiB');
    const value: unknown = JSON.parse(source);
    let count = 0;
    const component = (item: unknown, depth: number): boolean => {
      if (!object(item) || depth > 6 || ++count > 256) return false;
      switch (item.type) {
        case 'card': return keys(item, ['type', 'title', 'children']) && (item.title === undefined || string(item.title)) && (item.children === undefined || Array.isArray(item.children) && item.children.length <= 100 && item.children.every(child => component(child, depth + 1)));
        case 'stat': return keys(item, ['type', 'label', 'value']) && string(item.label) && text(item.value);
        case 'table': return keys(item, ['type', 'columns', 'rows']) && Array.isArray(item.columns) && item.columns.length > 0 && item.columns.length <= 20 && item.columns.every(value => string(value)) && Array.isArray(item.rows) && item.rows.length <= 100 && item.rows.every(row => Array.isArray(row) && row.length === (item.columns as unknown[]).length && row.every(text));
        case 'list': return keys(item, ['type', 'items']) && Array.isArray(item.items) && item.items.length <= 100 && item.items.every(value => string(value));
        case 'badge': return keys(item, ['type', 'text', 'tone']) && string(item.text) && (item.tone === undefined || ['neutral', 'success', 'warning', 'danger'].includes(String(item.tone)));
        case 'progress': return keys(item, ['type', 'label', 'value', 'max']) && (item.label === undefined || string(item.label)) && number(item.value) && item.value >= 0 && (item.max === undefined || number(item.max) && item.max > 0) && item.value <= (item.max as number ?? 100);
        case 'chart': return keys(item, ['type', 'kind', 'title', 'data']) && ['bar', 'line', 'pie'].includes(String(item.kind)) && (item.title === undefined || string(item.title)) && Array.isArray(item.data) && item.data.length <= 200 && item.data.every(point => object(point) && keys(point, ['label', 'value']) && string(point.label) && number(point.value) && point.value >= 0);
        default: return false;
      }
    };
    if (!object(value) || !keys(value, ['version', 'components', 'buttons']) || value.version !== 1 || !Array.isArray(value.components) || value.components.length > 100 || !value.components.every(item => component(item, 0)) || (value.buttons !== undefined && (!Array.isArray(value.buttons) || value.buttons.length > 12 || !value.buttons.every(button => object(button) && keys(button, ['label', 'text']) && string(button.label, 100) && !!button.label.trim() && string(button.text, 4000) && !!button.text.trim())))) throw new Error('Invalid spec: unsupported component, property or value');
    return { spec: value as GeneratedUiSpec };
  } catch (error) { return { error: error instanceof Error ? error.message : 'Invalid spec' }; }
}
