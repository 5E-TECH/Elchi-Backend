import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsPhoneNumber, IsString, MinLength } from 'class-validator';

export class CreateManagerDto {
  @ApiProperty({ example: 'Branch manager' })
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

  @ApiProperty({ example: '1', description: 'Branch ID (gateway assignment uchun)' })
  @IsNotEmpty()
  @IsString()
  branch_id: string;
}
