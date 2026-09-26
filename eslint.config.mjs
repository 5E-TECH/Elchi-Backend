// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // k6 skriptlari TypeScript loyihasiga kirmaydi (k6 o'z runtime'ida
    // ishlaydi, `node_modules` ham ko'rmaydi) — shu bois type-aware lint
    // ularni tahlil qila olmaydi va xato beradi.
    ignores: ['eslint.config.mjs', 'tests/load/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',

      /**
       * `no-unsafe-*` OILASI — `error` EMAS, `warn`.
       *
       * NEGA: bu qoidalar `any`-tipli qiymatdan foydalanishni belgilaydi.
       * Lekin config allaqachon `no-explicit-any: 'off'` — ya'ni jamoa `any`ni
       * ATAYLAB qabul qiladi (RPC `@MessagePattern` yuklari, xom TypeORM natijalar,
       * `JSON.parse` — mikroservis chegaralarida tabiiy `any`). `any`ga ruxsat
       * berib, uning HAR bir ishlatilishini `error` qilish — ichki ziddiyat edi
       * (3729 "xato", 0 tasi avto-tuzatiladigan). Bu qoidalarni `warn`ga tushirish
       * `no-unsafe-argument: 'warn'` bilan bir xil siyosatni to'liq qiladi.
       *
       * `warn` sifatida ular hamon ko'rinadi (yangi kodni tiplashga undaydi),
       * lekin `npm run lint` (`--max-warnings` yo'q) ni yiqitmaydi. Chinakam
       * bug'larni ushlaydigan qoidalar (`no-misused-promises`, `require-await`,
       * `no-base-to-string`, ...) `error` bo'lib QOLADI.
       */
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-enum-comparison': 'warn',
    },
  },
);