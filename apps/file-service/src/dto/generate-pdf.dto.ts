import { IsOptional, IsString, MinLength } from 'class-validator';

export class GeneratePdfDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsString()
  @MinLength(1)
  content!: string;

  @IsOptional()
  @IsString()
  file_name?: string;

  @IsOptional()
  @IsString()
  folder?: string;
}

