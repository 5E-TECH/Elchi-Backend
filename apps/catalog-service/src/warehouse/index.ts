import { Warehouse } from './entities/warehouse.entity';
import { WarehouseStock } from './entities/warehouse-stock.entity';
import { StockMovement } from './entities/stock-movement.entity';
import { StockReservation } from './entities/stock-reservation.entity';
import { WarehouseController } from './warehouse.controller';
import { WarehouseDirectoryService } from './warehouse-directory.service';
import { WarehouseService } from './warehouse.service';
import { WarehouseStockService } from './warehouse-stock.service';

/**
 * hY7uacJu: ombor moduli `CatalogServiceModule` ichida ro'yxatdan o'tadi
 * (alohida Nest moduli emas): `ActivityLogModule.forService` ikkinchi marta
 * import qilinsa retention cron'i ikki marta yurardi.
 */
export const WAREHOUSE_ENTITIES = [
  Warehouse,
  WarehouseStock,
  StockMovement,
  StockReservation,
];
export const WAREHOUSE_CONTROLLERS = [WarehouseController];
export const WAREHOUSE_PROVIDERS = [
  WarehouseDirectoryService,
  WarehouseService,
  WarehouseStockService,
];

export {
  Warehouse,
  WarehouseStock,
  StockMovement,
  StockReservation,
  WarehouseController,
  WarehouseDirectoryService,
  WarehouseService,
  WarehouseStockService,
};
