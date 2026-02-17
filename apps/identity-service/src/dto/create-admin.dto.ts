import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAdminDto {
  @ApiProperty({ example: 'Admin User' })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({ example: '+998901234567' })
  @IsNotEmpty()
  @IsPhoneNumber('UZ')
  phone_number: string;

  @ApiPropertyOptional({ example: 'admin_01' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  username?: string;

  @ApiProperty({ example: 'strongPassword123' })
  @IsNotEmpty()
  @IsString()
  @MinLength(4)
  password: string;

  @ApiProperty({ example: 3000000, minimum: 0 })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  salary: number;

  @ApiPropertyOptional({
    example: 10,
    minimum: 1,
    maximum: 30,
    description: 'Payment day of month',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(30)
  payment_day: number;
}
