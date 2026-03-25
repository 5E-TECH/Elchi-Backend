import { Group_type } from '@app/common';
import { IsBoolean, IsEnum, IsOptional, IsString, Matches } from 'class-validator';

export class UpdateNotificationDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  id?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  market_id?: string;

  @IsOptional()
  @IsString()
  group_id?: string;

  @IsOptional()
  @IsEnum(Group_type)
  group_type?: Group_type;

  @IsOptional()
  @IsString()
  token?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
