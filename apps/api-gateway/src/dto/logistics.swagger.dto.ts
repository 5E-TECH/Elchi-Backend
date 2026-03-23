import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumberString, IsOptional, IsString, Matches } from 'class-validator';

export class CreateDistrictRequestDto {
  @ApiProperty({ example: 'Yangi Namangan' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: '1' })
  @IsNotEmpty()
  @IsNumberString()
  region_id!: string;

  @ApiProperty({ example: '1712234', required: false })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  sato_code?: string;
}

export class UpdateDistrictRequestDto {
  @ApiProperty({ example: '1' })
  @IsNotEmpty()
  @IsNumberString()
  assigned_region!: string;
}

export class UpdateDistrictNameRequestDto {
  @ApiProperty({ example: 'Yangi Namangan' })
  @IsNotEmpty()
  @IsString()
  name!: string;
}

export class UpdateDistrictSatoCodeRequestDto {
  @ApiProperty({ example: '1712234' })
  @IsNotEmpty()
  @IsString()
  @Matches(/^\d+$/)
  sato_code!: string;
}

export class CreateRegionRequestDto {
  @ApiProperty({ example: 'Namangan' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: 'REG-05' })
  @IsNotEmpty()
  @IsString()
  sato_code!: string;
}

export class UpdateRegionRequestDto {
  @ApiProperty({ example: 'Namangan viloyati', required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ example: 'REG-05-NEW', required: false })
  @IsOptional()
  @IsString()
  sato_code?: string;
}

export class CreatePostRequestDto {
  @ApiProperty({ example: '1' })
  @IsNotEmpty()
  @IsNumberString()
  courier_id!: string;

  @ApiProperty({ example: 'QR123TOKEN456', required: false })
  @IsOptional()
  @IsString()
  qr_code_token?: string;

  @ApiProperty({ example: ['1', '2'], required: false, type: [String] })
  @IsOptional()
  @IsString({ each: true })
  orderIDs?: string[];
}

export class SendPostRequestDto {
  @ApiProperty({ type: [String], example: ['1', '2'] })
  @IsNotEmpty()
  @IsString({ each: true })
  orderIds!: string[];

  @ApiProperty({ example: '1' })
  @IsNotEmpty()
  @IsNumberString()
  courierId!: string;
}

export class ReceivePostRequestDto {
  @ApiProperty({ type: [String], example: ['1', '2'] })
  @IsNotEmpty()
  @IsString({ each: true })
  order_ids!: string[];
}

export class PostIdRequestDto {
  @ApiProperty({ example: '1' })
  @IsNotEmpty()
  @IsNumberString()
  postId!: string;
}
