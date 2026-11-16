/**
 * TypeORM (postgres) `query()` UPDATE/DELETE uchun `[rows, rowCount]`
 * qaytaradi, SELECT/INSERT uchun esa `rows`. `UPDATE … RETURNING` natijasini
 * shu yordamchi orqali o'qing — aks holda `.length` doim 2 bo'ladi.
 */
export function returnedRows<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
}
