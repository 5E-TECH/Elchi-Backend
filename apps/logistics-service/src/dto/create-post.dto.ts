import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreatePostDto {
  @IsString()
  @IsNotEmpty()
  courier_id!: string;

  @IsString()
  @IsOptional()
  qr_code_token?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  orderIDs?: string[];
}
