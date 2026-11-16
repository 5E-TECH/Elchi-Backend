import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/**
 * 2026-11-16 — `PUT /orders/:id/operator`: operatori yo'q buyurtmaga keyin
 * operator biriktirish. Tanlov ro'yxati — `GET /market-operators/selectable`
 * (yaratish formasidagi «Operator» bilan AYNI).
 */
export class AssignOrderOperatorRequestDto {
  @ApiProperty({
    example: '412',
    description:
      'Buyurtma marketining FAOL operatori (`GET /market-operators/selectable?market_id=<buyurtma marketi>` ' +
      "ro'yxatidan). Boshqa market operatori, o'chirilgan yoki bloklangan — 400 «Tanlangan operator bu marketga " +
      'tegishli emas yoki faol emas». Buyurtmaga `operator_id` va `operator` = operator ismi yoziladi.',
  })
  @IsString({ message: 'operator_id majburiy' })
  @Matches(/^\d{1,19}$/, {
    message: "operator_id operator ID si (raqam) bo'lishi kerak",
  })
  operator_id!: string;
}
