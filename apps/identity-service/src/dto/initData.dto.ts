import { IsNotEmpty, IsString } from 'class-validator';

export class TelegramInitData {
  @IsNotEmpty()
  @IsString()
  data: string;
}
