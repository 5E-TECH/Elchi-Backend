import { IsOptional, IsString, MinLength } from 'class-validator';

export class GenerateQrDto {
  @IsString()
  @MinLength(1)
  text!: string;

  @IsOptional()
  @IsString()
  file_name?: string;

  @IsOptional()
  @IsString()
  folder?: string;
}

