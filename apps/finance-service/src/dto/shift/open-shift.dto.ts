import { IsNumber, IsOptional, IsString, Matches } from 'class-validator';

export class OpenShiftDto {
  @IsString()
  @Matches(/^\d+$/)
  opened_by!: string;

  @IsOptional()
  @IsNumber()
  opening_balance_cash?: number;

  @IsOptional()
  @IsNumber()
  opening_balance_card?: number;

  @IsOptional()
  @IsString()
  comment?: string;

  /**
   * Smena qaysi kassa bo'yicha yopiladi (audit M7). Berilmasa markaziy MAIN
   * kassa olinadi. Filial smenasi uchun bu yerga filial ID'si beriladi.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  cashbox_user_id?: string;
}
