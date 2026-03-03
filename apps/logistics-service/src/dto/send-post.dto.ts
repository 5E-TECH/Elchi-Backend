import { IsArray, IsNotEmpty, IsString } from 'class-validator';

export class SendPostDto {
  @IsNotEmpty()
  @IsArray()
  @IsString({ each: true })
  orderIds!: string[];

  @IsNotEmpty()
  @IsString()
  courierId!: string;
}
