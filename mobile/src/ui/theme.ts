import type { ColorSchemeName } from 'react-native';
import type { Appearance } from '../core/types';

export type Theme = typeof light;

const light = {
  background: '#F5F4EF', surface: '#FEFDFB', raised: '#F3F2EC', text: '#23221F', muted: '#64615A', faint: '#8C887F',
  line: '#DEDCD5', primary: '#4F59C8', primaryText: '#FFFFFF', green: '#1A7F37', amber: '#986500', red: '#BE2C34',
  blue: '#315E9B', chip: '#E9EAF8', overlay: 'rgba(26,25,22,0.38)', input: '#FFFFFF', terminal: '#1D1E20', terminalText: '#E9ECEC',
};

const dark: Theme = {
  background: '#262624', surface: '#302F2C', raised: '#3A3935', text: '#F1F0EA', muted: '#C1BDB3', faint: '#98948A',
  line: '#4A4842', primary: '#7480EA', primaryText: '#111326', green: '#53C676', amber: '#F0BF52', red: '#FF807A',
  blue: '#9BBEFF', chip: '#3B3D59', overlay: 'rgba(0,0,0,0.60)', input: '#34332F', terminal: '#171819', terminalText: '#EBEEEE',
};

export function resolveTheme(preference: Appearance, scheme: ColorSchemeName): Theme {
  return preference === 'dark' || (preference === 'system' && scheme === 'dark') ? dark : light;
}

export const space = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 40 } as const;
export const radius = { small: 10, medium: 14, large: 20, pill: 999 } as const;
