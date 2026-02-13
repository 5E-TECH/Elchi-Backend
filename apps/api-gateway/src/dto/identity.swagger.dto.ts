import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class CreateAdminRequestDto {
  @ApiProperty({ example: 'Admin User' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiProperty({ example: 'strongPassword123' })
  @IsString()
  @MinLength(6)
  password!: string;

  @ApiProperty({ example: 3000000 })
  @IsNumber()
  @Min(0)
  salary!: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(30)
  payment_day?: number;
}

export class UpdateAdminRequestDto {
  @ApiPropertyOptional({ example: 'Admin User Updated' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ example: '+998901234567' })
  @IsOptional()
  @IsPhoneNumber('UZ')
  phone_number?: string;

  @ApiPropertyOptional({ example: 'newStrongPassword123' })
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @ApiPropertyOptional({ example: 'admin' })
  @IsOptional()
  @IsEnum(['superadmin', 'admin'])
  role?: string;

  @ApiPropertyOptional({ example: 'active' })
  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: string;
}

export class CreateMarketRequestDto {
  @ApiProperty({ example: 'Market 1' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsPhoneNumber('UZ')
  phone_number!: string;

  @ApiProperty({ example: 'secret123' })
  @IsString()
  @MinLength(6)
  password!: string;

  @ApiProperty({ example: 10000 })
  @IsNumber()
  @Min(0)
  tariff_home!: number;

  @ApiProperty({ example: 8000 })
  @IsNumber()
  @Min(0)
  tariff_center!: number;

  @ApiProperty({ example: 'center', enum: ['center', 'address'] })
  @IsEnum(['center', 'address'])
  default_tariff!: string;

  // Compatibility aliases (ignored in business logic, mapped in gateway)
  @ApiPropertyOptional({ example: 10000, description: 'Alias for tariff_home' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariffHome?: number;

  @ApiPropertyOptional({ example: 8000, description: 'Alias for tariff_center' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariffCenter?: number;

  @ApiPropertyOptional({ example: 'center', enum: ['center', 'address'], description: 'Alias for default_tariff' })
  @IsOptional()
  @IsEnum(['center', 'address'])
  defaultTariff?: string;

  @ApiPropertyOptional({ example: 0, description: 'Ignored for market create' })
  @IsOptional()
  @IsNumber()
  salary?: number;

  @ApiPropertyOptional({ example: 10, description: 'Ignored for market create' })
  @IsOptional()
  @IsNumber()
  payment_day?: number;

  @ApiPropertyOptional({ example: 'market', description: 'Ignored for market create' })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({ example: 'active', description: 'Ignored for market create' })
  @IsOptional()
  @IsString()
  status?: string;
}

export class UpdateMarketRequestDto {
  @ApiPropertyOptional({ example: 'Market 1 Updated' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ example: '+998901234567' })
  @IsOptional()
  @IsPhoneNumber('UZ')
  phone_number?: string;

  @ApiPropertyOptional({ example: 'newSecret123' })
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @ApiPropertyOptional({ example: 'active' })
  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: string;

  @ApiPropertyOptional({ example: 11000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_home?: number;

  @ApiPropertyOptional({ example: 9000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_center?: number;

  @ApiPropertyOptional({ example: 'address', enum: ['center', 'address'] })
  @IsOptional()
  @IsEnum(['center', 'address'])
  default_tariff?: string;

  @ApiPropertyOptional({ example: 11000, description: 'Alias for tariff_home' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariffHome?: number;

  @ApiPropertyOptional({ example: 9000, description: 'Alias for tariff_center' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariffCenter?: number;

  @ApiPropertyOptional({ example: 'address', enum: ['center', 'address'], description: 'Alias for default_tariff' })
  @IsOptional()
  @IsEnum(['center', 'address'])
  defaultTariff?: string;
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
