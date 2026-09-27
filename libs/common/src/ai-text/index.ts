/**
 * AI buyurtma uchun deterministik matn funksiyalari (LLM'siz, DB'siz,
 * tarmoqsiz): transliteratsiya, geografik normalizatsiya, viloyat SOATO
 * aliaslari, o'xshashlik, mahsulot nomi va telefon normalizatsiyasi.
 *
 * Tuman (logistics-service) va mahsulot (order-service) rezolverlari shu
 * yerdan `@app/common` orqali oladi — funksiyalar ikki nusxada yozilmasin.
 */
export * from './uz-translit';
export * from './geo-norm';
export * from './similarity';
export * from './product-norm';
export * from './phone';
