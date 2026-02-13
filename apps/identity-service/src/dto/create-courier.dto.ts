import {
  IsNotEmpty,
  IsNumber,
  IsPhoneNumber,
  IsString,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCourierDto {
  @ApiProperty({
    description: 'Region ID',
    example: 'f3b2c1d4-5678-90ab-cdef-1234567890ab',
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
  password: string;

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
