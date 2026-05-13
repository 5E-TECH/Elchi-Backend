import {
  Max,
  MinLength,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCourierDto {
  @ApiProperty({
    description: 'Region ID',
    example: '1',
  })
  @IsNotEmpty()
  @IsString()
  region_id: string;

  @ApiProperty({ example: 'Akmal Abdullaev' })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({ example: '+998901234567' })
  @IsNotEmpty()
  @IsPhoneNumber('UZ')
  phone_number: string;

  @ApiProperty({ example: 'secret123' })
  @IsNotEmpty()
  @IsString()
  @MinLength(4)
  password: string;

  @ApiPropertyOptional({ example: 2000000, minimum: 0, description: 'Optional, default is 0' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  salary?: number;

  @ApiProperty({
    example: 10,
    minimum: 1,
    maximum: 30,
    required: false,
    description: 'Payment day of month',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(30)
  payment_day?: number;

  @ApiPropertyOptional({ example: 10000, minimum: 0, description: 'Optional, default is 0' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_home?: number;

  @ApiPropertyOptional({ example: 8000, minimum: 0, description: 'Optional, default is 0' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tariff_center?: number;

  @ApiPropertyOptional({
    example: '1',
    description:
      'Branch ID. When set, identity-service will assign the new courier to this branch as part of the create flow.',
  })
  @IsOptional()
  @IsString()
  branch_id?: string;
}
