import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAdminRequestDto {
  @ApiProperty({ example: 'Admin User' })
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  phone_number!: string;

  @ApiProperty({ example: 'strongPassword123' })
  password!: string;

  @ApiProperty({ example: 3000000 })
  salary!: number;

  @ApiPropertyOptional({ example: 10 })
  payment_day?: number;
}

export class UpdateAdminRequestDto {
  @ApiPropertyOptional({ example: 'Admin User Updated' })
  name?: string;

  @ApiPropertyOptional({ example: '+998901234567' })
  phone_number?: string;

  @ApiPropertyOptional({ example: 'newStrongPassword123' })
  password?: string;

  @ApiPropertyOptional({ example: 'admin' })
  role?: string;

  @ApiPropertyOptional({ example: 'active' })
  status?: string;
}

export class CreateMarketRequestDto {
  @ApiProperty({ example: 'Market 1' })
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  phone_number!: string;

  @ApiProperty({ example: 'secret123' })
  password!: string;

  @ApiProperty({ example: 10000 })
  tariff_home!: number;

  @ApiProperty({ example: 8000 })
  tariff_center!: number;

  @ApiProperty({ example: 'center', enum: ['center', 'address'] })
  default_tariff!: string;
}

export class UpdateMarketRequestDto {
  @ApiPropertyOptional({ example: 'Market 1 Updated' })
  name?: string;

  @ApiPropertyOptional({ example: '+998901234567' })
  phone_number?: string;

  @ApiPropertyOptional({ example: 'newSecret123' })
  password?: string;

  @ApiPropertyOptional({ example: 'active' })
  status?: string;

  @ApiPropertyOptional({ example: 11000 })
  tariff_home?: number;

  @ApiPropertyOptional({ example: 9000 })
  tariff_center?: number;

  @ApiPropertyOptional({ example: 'address', enum: ['center', 'address'] })
  default_tariff?: string;
}

export class EntityItemDto {
  @ApiProperty({ example: '10a142dd-df52-418e-bf3b-fe8fbf1b77f5' })
  id!: string;

  @ApiProperty({ example: '2026-02-12T09:34:04.236Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-02-12T09:34:04.236Z' })
  updatedAt!: string;

  @ApiProperty({ example: 'Admin User' })
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  phone_number!: string;

  @ApiProperty({ example: 'admin' })
  role!: string;

  @ApiProperty({ example: 'active' })
  status!: string;

  @ApiPropertyOptional({ example: 10000 })
  tariff_home?: number;

  @ApiPropertyOptional({ example: 8000 })
  tariff_center?: number;

  @ApiPropertyOptional({ example: 'center' })
  default_tariff?: string;
}

export class SingleEntityResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiPropertyOptional({ example: 'Yaratildi' })
  message?: string;

  @ApiProperty({ type: EntityItemDto })
  data!: EntityItemDto;
}

export class ListEntityResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({
    example: {
      items: [
        {
          id: '10a142dd-df52-418e-bf3b-fe8fbf1b77f5',
          createdAt: '2026-02-12T09:34:04.236Z',
          updatedAt: '2026-02-12T09:34:04.236Z',
          name: 'Admin User',
          phone_number: '+998901234567',
          role: 'admin',
          status: 'active',
        },
      ],
      meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
    },
  })
  data!: {
    items: EntityItemDto[];
    meta: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  };
}

export class DeleteEntityResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: 'O‘chirildi' })
  message!: string;

  @ApiProperty({ example: { id: '10a142dd-df52-418e-bf3b-fe8fbf1b77f5' } })
  data!: { id: string };
}
