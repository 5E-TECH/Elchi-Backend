import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProductRequestDto {
  @ApiPropertyOptional({ type: 'string', format: 'binary' })
  image?: string;

  @ApiProperty({ example: 'Pepsi' })
  name!: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/product.png' })
  image_url?: string;

  @ApiPropertyOptional({
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    description: 'Admin/Superadmin yuboradi. MARKET role uchun token sub ishlatiladi.',
  })
  market_id?: string;
}

export class UpdateProductRequestDto {
  @ApiPropertyOptional({ example: 'Pepsi Max' })
  name?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/product-new.png' })
  image_url?: string;
}
