'use strict';
/**
 * Jest transformer: FAQAT-ESM node_modules paketlarini CommonJS'ga o'giradi.
 *
 * Servislar Node'da `require(esm)` orqali ESM paketlarni yuklaydi (Node
 * >= 20.19), lekin Jest'ning CJS modul tizimi buni qo'llamaydi: test
 * «Unexpected token 'export'» yoki Nest `loadPackage` orqali «package is
 * missing» bilan yiqiladi. Bu transformer o'sha paketlarni TypeScript'ning
 * `transpileModule` i bilan CJS'ga o'tkazadi (yangi bog'liqlik kerak emas).
 *
 * Yangi FAQAT-ESM paket qo'shilsa — uning nomini IKKI joyga yozing:
 * package.json `jest.transform` / `jest.transformIgnorePatterns` va
 * apps/api-gateway/test/jest-e2e.json dagi xuddi shu ikki kalit.
 * Hozirgi ro'yxat: @nestjs/jwt (>=12), promise-breaker (>=7,
 * amqp-connection-manager >=5.0.1 orqali).
 */
const crypto = require('crypto');
const ts = require('typescript');

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  allowJs: true,
  esModuleInterop: true,
  inlineSourceMap: true,
};

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(sourceText, {
      compilerOptions,
      fileName: sourcePath,
    });
    return { code: outputText };
  },

  getCacheKey(sourceText, sourcePath) {
    return crypto
      .createHash('sha1')
      .update(ts.version)
      .update('\0')
      .update(sourcePath)
      .update('\0')
      .update(sourceText)
      .digest('hex');
  },
};
