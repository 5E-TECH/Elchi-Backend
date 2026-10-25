import {
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';
import { ShiftStatus } from '../../entities/shift.entity';

/** (8OYPuz7J) Smena ro'yxati saralash maydoni (oq ro'yxat). */
export const SHIFT_SORT_FIELDS = ['opened_at', 'closed_at'] as const;
export type ShiftSortField = (typeof SHIFT_SORT_FIELDS)[number];
export const SHIFT_SORT_DIRS = ['asc', 'desc'] as const;
export type ShiftSortDir = (typeof SHIFT_SORT_DIRS)[number];

export class FindShiftsDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  opened_by?: string;

  @IsOptional()
  @IsEnum(ShiftStatus)
  status?: ShiftStatus;

  @IsOptional()
  @IsString()
  from_date?: string;

  @IsOptional()
  @IsString()
  to_date?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  limit?: number;

  /**
   * (8OYPuz7J) Kassa bo'yicha: '0' — markaziy MAIN, aks holda filial ID si.
   * Menejer uchun gateway o'z filialini majburlaydi.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  cashbox_user_id?: string;

  /** (8OYPuz7J) Saralash: `opened_at` (sukut) yoki `closed_at`. */
  @IsOptional()
  @IsIn(SHIFT_SORT_FIELDS)
  sort_by?: ShiftSortField;

  /** (8OYPuz7J) Yo'nalish: `desc` (sukut) yoki `asc`. */
  @IsOptional()
  @IsIn(SHIFT_SORT_DIRS)
  sort_dir?: ShiftSortDir;
}
