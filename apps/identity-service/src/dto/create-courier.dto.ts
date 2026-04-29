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
import { ApiProperty } from '@nestjs/swagger';

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

  @ApiProperty({ example: 2000000, minimum: 0 })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  salary: number;

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

  @ApiProperty({ example: 10000, minimum: 0 })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  tariff_home: number;

  @ApiProperty({ example: 8000, minimum: 0 })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  tariff_center: number;
}
