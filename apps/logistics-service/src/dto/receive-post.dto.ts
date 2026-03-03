import { IsArray, IsNotEmpty, IsString } from 'class-validator';

export class ReceivePostDto {
  @IsNotEmpty()
  @IsArray()
  @IsString({ each: true })
  order_ids!: string[];
}
