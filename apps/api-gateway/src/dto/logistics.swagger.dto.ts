import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateDistrictRequestDto {
  @ApiProperty({ example: 'Yangi Namangan' })
  @IsNotEmpty()
  @IsString()
  name!: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsNotEmpty()
  @IsUUID()
  region_id!: string;
}

export class UpdateDistrictRequestDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsNotEmpty()
  @IsUUID()
  assigned_region!: string;
}

export class UpdateDistrictNameRequestDto {
  @ApiProperty({ example: 'Yangi Namangan' })
  @IsNotEmpty()
  @IsString()
  name!: string;
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
