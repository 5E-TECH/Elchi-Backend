import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class GetFileUrlQueryDto {
  @ApiPropertyOptional({ example: 3600, description: 'Signed URL expiration seconds (max 86400)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(86400)
  expires_in?: number;
}

export class GenerateQrRequestDto {
  @ApiProperty({ example: 'ORDER-12345' })
  @IsString()
  @MinLength(1)
  text!: string;

  @ApiPropertyOptional({ example: 'order-12345-qr.png' })
  @IsOptional()
  @IsString()
  file_name?: string;

  @ApiPropertyOptional({ example: 'qr' })
  @IsOptional()
  @IsString()
  folder?: string;
}

export class GeneratePdfRequestDto {
  @ApiPropertyOptional({ example: 'Invoice #12345' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ example: 'Customer: Ali Valiyev\nAmount: 120000\nStatus: paid' })
  @IsString()
  @MinLength(1)
  content!: string;

  @ApiPropertyOptional({ example: 'invoice-12345.pdf' })
  @IsOptional()
  @IsString()
  file_name?: string;

  @ApiPropertyOptional({ example: 'pdf' })
  @IsOptional()
  @IsString()
  folder?: string;
}

