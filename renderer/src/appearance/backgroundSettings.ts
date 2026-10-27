import { customCopyName, customThemeFromResolved } from './backgrounds';
import { resolveTheme, themeBackgrounds, type ThemeBackgroundLayer, type ThemeBackgroundRegion, type ThemeBackgrounds, type ThemeTokens } from '../themes';

export function defaultBackgroundLayer(image: string): ThemeBackgroundLayer {
  return { image, opacity: 100, blur: 0, overlay: 0, fit: 'cover', focusX: 50, focusY: 50, scale: 100 };
}

/** Compose queued gestures by changed field, so a scale release cannot undo an earlier Fit or Focus click. */
export function applyBackgroundEdit(current: ThemeBackgrounds | undefined, region: ThemeBackgroundRegion, layer: ThemeBackgroundLayer | undefined, fields?: readonly (keyof ThemeBackgroundLayer)[]): ThemeBackgrounds {
  const merged = { ...current };
  if (!layer) delete merged[region];
  else if (!fields || !merged[region]) merged[region] = layer;
  else {
    if (merged[region]!.image !== layer.image) throw Error('Background picture changed');
    merged[region] = { ...merged[region]!, ...Object.fromEntries(fields.map(key => [key, layer[key]])) };
  }
  return merged;
}

/** Builds the one settings patch for a background edit. Presets become a named custom copy; custom themes keep their palette. */
export function backgroundSettingsPatch(
  selection: string,
  themes: Record<string, ThemeTokens>,
  systemDark: boolean,
  backgrounds: ThemeBackgrounds,
): { customThemes: Record<string, ThemeTokens>; themeSelection: string; createdName?: string } {
  const resolved = resolveTheme(selection, { systemDark, customThemes: themes });
  const kept = themeBackgrounds(backgrounds);
  if (resolved.custom) {
    const current = themes[resolved.name];
    if (current) {
      const next: ThemeTokens = { ...current };
      if (kept) next.backgrounds = kept;
      else delete next.backgrounds;
      return { customThemes: { ...themes, [resolved.name]: next }, themeSelection: `custom:${resolved.name}` };
    }
  }
  const createdName = customCopyName(resolved.name, Object.keys(themes));
  return {
    customThemes: { ...themes, [createdName]: customThemeFromResolved(resolved, kept) },
    themeSelection: `custom:${createdName}`,
    createdName,
  };
}

const errorMessages = {
  theme_pack_unreadable: ['Could not read this theme pack. Try another file.', '无法读取此主题包。请尝试其他文件。'],
  theme_pack_empty: ['This theme pack has no themes to import.', '此主题包没有可导入的主题。'],
  theme_pack_invalid_theme: ['This theme pack contains an invalid theme.', '此主题包包含无效主题。'],
  theme_pack_invalid_image: ['This theme pack contains an invalid background image.', '此主题包包含无效背景图片。'],
  theme_pack_too_large: ['This theme pack is too large to import.', '此主题包过大，无法导入。'],
  background_image_unsupported: ['That image format is not supported.', '不支持该图片格式。'],
  background_image_too_large: ['That image is too large to import.', '该图片过大，无法导入。'],
  background_image_limit: ['You have reached the background image limit.', '您已达到背景图片数量上限。'],
  background_image_unreadable: ['Could not read that background image.', '无法读取该背景图片。'],
} as const;

/** Converts local and IPC-flattened image/theme-pack failures into a safe, localized message. */
export function appearanceErrorMessage(error: unknown, zh: boolean): string {
  const direct = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
  const text = [direct, message, typeof error === 'string' ? error : undefined].filter((value): value is string => typeof value === 'string').join('\n');
  const code = Object.keys(errorMessages).find(candidate => text.includes(candidate)) as keyof typeof errorMessages | undefined;
  return code ? errorMessages[code][zh ? 1 : 0] : zh ? '操作未完成，请重试。' : 'Could not complete that action. Please try again.';
}
