import { IsNumberString, IsObject, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateBranchConfigDto {
  @IsNumberString()
  branch_id!: string;

  @IsString()
  @MinLength(1)
  config_key!: string;

  @IsOptional()
  @IsObject()
  config_value?: Record<string, unknown> | null;
}

