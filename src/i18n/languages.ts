/**
 * ThreadTerm supported language configuration.
 *
 * This file contains the languages exposed by the settings UI.
 * Each language includes:
 * - value: Language code (e.g., 'en', 'zh-CN')
 * - label: Display name in English
 * - nativeName: Native language name for display
 */

export interface LanguageOption {
  value: string;
  label: string;
  nativeName: string;
}

export const languages: LanguageOption[] = [
  {
    value: 'en',
    label: 'English',
    nativeName: 'English',
  },
  {
    value: 'ko',
    label: 'Korean',
    nativeName: '한국어',
  },
  {
    value: 'zh-CN',
    label: 'Simplified Chinese',
    nativeName: '简体中文',
  },
  {
    value: 'ja',
    label: 'Japanese',
    nativeName: '日本語',
  },
];

/**
 * Get language object by value
 * @param {string} value - Language code
 * @returns {Object|undefined} Language object or undefined if not found
 */
export const getLanguage = (value: string): LanguageOption | undefined => {
  return languages.find((lang) => lang.value === value);
};

/**
 * Get all language values
 * @returns {string[]} Array of language codes
 */
export const getLanguageValues = (): string[] => {
  return languages.map((lang) => lang.value);
};

/**
 * Check if a language is supported
 * @param {string} value - Language code to check
 * @returns {boolean} True if language is supported
 */
export const isLanguageSupported = (value: string): boolean => {
  return languages.some((lang) => lang.value === value);
};
