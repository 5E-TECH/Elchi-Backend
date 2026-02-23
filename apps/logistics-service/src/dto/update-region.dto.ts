import { IsOptional, IsString } from 'class-validator';

export class UpdateRegionDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  sato_code?: string;
}

