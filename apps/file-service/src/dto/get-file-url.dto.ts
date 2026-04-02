import { IsOptional, IsString, MinLength } from 'class-validator';

export class GetFileUrlDto {
  @IsString()
  @MinLength(1)
  key!: string;

  @IsOptional()
  expires_in?: number;
}

