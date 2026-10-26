import { IsNumber, IsOptional, IsString, Matches } from 'class-validator';

export class CloseShiftDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  shift_id?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  opened_by?: string;

  @IsString()
  @Matches(/^\d+$/)
  closed_by!: string;

  @IsOptional()
  @IsNumber()
  closing_balance_cash?: number;

  @IsOptional()
  @IsNumber()
  closing_balance_card?: number;

  @IsOptional()
  @IsString()
  comment?: string;

  /**
   * (kiZgTybn) Har karta / hisob qoldig'ini tasdiqlash. Validatsiya
   * `ShiftAccountCheckService.confirmAtClose` da (RMQ payload ishonchsiz).
   */
  @IsOptional()
  accounts?: Array<{
    card_id: string;
    entered_balance: number;
    photo_file_key?: string;
    comment?: string;
  }>;

  /**
   * R6 — kassa doirasi (filial ID). Gateway faqat menejer uchun qo'yadi:
   * smena shu kassaniki bo'lishi shart, aks holda 404. Berilmasa — avvalgidek.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  cashbox_user_id?: string;
}
