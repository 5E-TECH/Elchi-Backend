import {
  IsBoolean,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
} from 'class-validator';

export class UpdateDistrictDto {
  @IsNotEmpty()
  @IsNumberString()
  assigned_region!: string;

  /**
   * Ixtiyoriy: `true` — tuman saqlangach HQ NEW pochtalaridagi shu tuman
   * ochiq buyurtmalari yangi xizmat viloyati pochtasiga ko'chiriladi
   * (`rehomeOpenDistrictOrders`); buyurtma viloyati o'zgarmaydi.
   */
  @IsOptional()
  @IsBoolean()
  rehome_open_orders?: boolean;
}
