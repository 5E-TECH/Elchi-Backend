import {
  IsNotEmpty,
  IsOptional,
  IsPhoneNumber,
  IsString,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCustomerDto {
  @ApiPropertyOptional({
    format: 'uuid',
    example: '8b2c1a8e-3b6f-4a6e-9a2f-71d8a5c9d123',
  })
  @IsOptional()
  @IsUUID(4, { message: "Market ID noto'g'ri formatda" })
  market_id?: string;

  @ApiProperty({ example: 'John Doe' })
  @IsNotEmpty({ message: 'Ism kiritilishi shart' })
  @IsString({ message: "Ism matn formatida bo'lishi kerak" })
  name: string;

  @ApiProperty({ example: '+998901112233' })
  @IsNotEmpty({ message: 'Telefon raqam kiritilishi shart' })
  @IsPhoneNumber('UZ', {
    message: "Telefon raqam noto'g'ri formatda (+998XXXXXXXXX)",
  })
  phone_number: string;

  @ApiProperty({
    format: 'uuid',
    example: '2c3f5b7a-1d9e-44f7-8a1b-0a1d2b3c4d5e',
  })
  @IsNotEmpty({ message: 'Tuman ID kiritilishi shart' })
  @IsUUID(4, { message: "Tuman ID noto'g'ri formatda" })
  district_id: string;

  @ApiPropertyOptional({ example: '99-111-22-33' })
  @IsOptional()
  @IsString({ message: "Qo'shimcha raqam matn formatida bo'lishi kerak" })
  extra_number?: string;

  @ApiPropertyOptional({ example: '27, Elm street, Apt 4' })
  @IsOptional()
  @IsString({ message: "Manzil matn formatida bo'lishi kerak" })
  address?: string;
}
