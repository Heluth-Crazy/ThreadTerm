const readonly = (names) => Object.fromEntries(names.split(' ').map((name) => [name, 'readonly']));
const rules = {
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
  'no-func-assign': 'error',
  'no-unexpected-multiline': 'error',
  'valid-typeof': 'error',
};

export default [
  { ignores: ['**/vendor/**', '**/preview/**'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: readonly('window document navigator location history localStorage console HTMLElement Element HTMLInputElement HTMLTextAreaElement HTMLSelectElement Node FormData URL Blob File FileReader TextEncoder setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame CSS performance matchMedia'),
    },
    rules,
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: readonly('process Buffer URL console setTimeout clearTimeout window document location history localStorage navigator HTMLElement FormData CompositionEvent DataTransfer DragEvent innerWidth innerHeight'),
    },
    rules,
  },
];
