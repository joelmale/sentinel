import js from '@eslint/js'
import globals from 'globals'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'

const compilerReadyFiles = [
  'src/components/OverviewPage.tsx',
  'src/components/AssetCard.tsx',
  'src/components/TrackBrowserView.tsx',
  'src/hooks/useDrag.ts',
  'src/hooks/useResize.ts',
  'src/hooks/useResizePanel.ts',
]

const compilerRecommendedRules = reactHooks.configs.flat.recommended.rules
const compilerWarningRules = Object.fromEntries(
  Object.entries(compilerRecommendedRules).map(([ruleName, ruleConfig]) => {
    if (ruleName === 'react-hooks/rules-of-hooks' || ruleName === 'react-hooks/exhaustive-deps') {
      return [ruleName, ruleConfig]
    }
    if (Array.isArray(ruleConfig)) {
      return [ruleName, ['warn', ...ruleConfig.slice(1)]]
    }
    return [ruleName, 'warn']
  }),
)

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '**/*.d.ts', '**/*.js', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      'no-undef': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: compilerReadyFiles,
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: compilerWarningRules,
  },
]
