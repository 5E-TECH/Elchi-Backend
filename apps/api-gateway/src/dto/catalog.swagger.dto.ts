import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateProductRequestDto {
  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description: "Product rasmi. Berilsa gateway uni avtomatik yuklab, `image_url`ni o'zi to'ldiradi.",
  })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiProperty({ example: 'Pepsi' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({
    example: 'https://cdn.example.com/product.png',
    description: "Ixtiyoriy. Agar `image` yuborilsa bu maydonni yuborish shart emas.",
  })
  @IsOptional()
  @IsString()
  image_url?: string;

  @ApiPropertyOptional({
    example: '1',
    description: 'Admin/Superadmin yuboradi. MARKET role uchun token sub ishlatiladi.',
  })
  @IsOptional()
  @IsString()
  market_id?: string;
}

export class UpdateProductRequestDto {
  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description: "Product rasmi. Berilsa gateway uni avtomatik yuklab, `image_url`ni o'zi to'ldiradi.",
  })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional({ example: 'Pepsi Max' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    example: 'https://cdn.example.com/product-new.png',
    description: "Ixtiyoriy. Agar `image` yuborilsa bu maydonni yuborish shart emas.",
  })
  @IsOptional()
  @IsString()
  image_url?: string;
}
