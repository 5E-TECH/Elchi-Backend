import { Group_type } from '@app/common';
import { IsBoolean, IsEnum, IsOptional, IsString, Matches } from 'class-validator';

export class CreateNotificationDto {
  @IsString()
  @Matches(/^\d+$/)
  market_id!: string;

  @IsString()
  group_id!: string;

  @IsEnum(Group_type)
  group_type!: Group_type;

  @IsOptional()
  @IsString()
  token?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
