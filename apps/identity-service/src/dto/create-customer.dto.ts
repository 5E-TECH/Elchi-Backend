import {
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsPhoneNumber,
  IsString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCustomerDto {
  @ApiPropertyOptional({
    example: '1',
  })
  @IsOptional()
  @IsNumberString({}, { message: "Market ID noto'g'ri formatda" })
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
    example: '1',
  })
  @IsNotEmpty({ message: 'Tuman ID kiritilishi shart' })
  @IsNumberString({}, { message: "Tuman ID noto'g'ri formatda" })
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
