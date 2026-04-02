import { IsOptional, IsString, MinLength } from 'class-validator';

export class UploadFileDto {
  @IsString()
  @MinLength(1)
  file_name!: string;

  @IsString()
  @MinLength(1)
  mime_type!: string;

  @IsString()
  @MinLength(1)
  file_base64!: string;

  @IsOptional()
  @IsString()
  folder?: string;
}

