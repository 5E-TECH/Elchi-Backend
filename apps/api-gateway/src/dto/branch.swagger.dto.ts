import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BranchType } from '@app/common';
import { IsEnum, IsNumberString, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { BranchUserRole } from '@app/common';

export class CreateBranchRequestDto {
  @ApiProperty({ example: 'Namangan filial' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiPropertyOptional({ example: "Namangan shahar, Bobur ko'chasi 12" })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: '+998901234567' })
  @IsOptional()
  @IsString()
  phone_number?: string;

  @ApiPropertyOptional({ example: '5', description: 'Region ID (bigint string)' })
  @IsOptional()
  @IsNumberString()
  region_id?: string;

  @ApiPropertyOptional({ example: '60', description: 'District ID (bigint string)' })
  @IsOptional()
  @IsNumberString()
  district_id?: string;

  @ApiPropertyOptional({ example: '1', description: 'Parent branch ID (bigint string)' })
  @IsOptional()
  @IsNumberString()
  parent_id?: string;

  @ApiProperty({ example: 'REGIONAL', enum: BranchType })
  @IsEnum(BranchType)
  type!: BranchType;

  @ApiProperty({ example: 'SAM' })
  @Matches(/^[A-Z0-9-]{2,32}$/)
  code!: string;
  @ApiPropertyOptional({ example: 'active', enum: ['active', 'inactive'] })
  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: string;

  @ApiPropertyOptional({ example: '12', description: 'Manager user ID (bigint string)' })
  @IsOptional()
  @IsNumberString()
  manager_id?: string;
}

export class UpdateBranchRequestDto {
  @ApiPropertyOptional({ example: 'Namangan filial 2' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ example: "Namangan shahar, Alisher Navoiy ko'chasi 20" })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: '+998901234568' })
  @IsOptional()
  @IsString()
  phone_number?: string;

  @ApiPropertyOptional({ example: '5', description: 'Region ID (bigint string)' })
  @IsOptional()
  @IsNumberString()
  region_id?: string;

  @ApiPropertyOptional({ example: '60', description: 'District ID (bigint string)' })
  @IsOptional()
  @IsNumberString()
  district_id?: string;

  @ApiPropertyOptional({ example: '1', description: 'Parent branch ID (bigint string)' })
  @IsOptional()
  @IsNumberString()
  parent_id?: string;

  @ApiPropertyOptional({ example: 'CITY', enum: BranchType })
  @IsOptional()
  @IsEnum(BranchType)
  type?: BranchType;

  @ApiPropertyOptional({ example: 'TSH-CHL' })
  @IsOptional()
  @Matches(/^[A-Z0-9-]{2,32}$/)
  code?: string;
  @ApiPropertyOptional({ example: 'active', enum: ['active', 'inactive'] })
  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: string;

  @ApiPropertyOptional({ example: '12', description: 'Manager user ID (bigint string)' })
  @IsOptional()
  @IsNumberString()
  manager_id?: string;
}

export class AssignBranchUserRequestDto {
  @ApiProperty({ example: '12', description: 'User ID (bigint string)' })
  @IsNumberString()
  user_id!: string;

  @ApiPropertyOptional({ enum: BranchUserRole, example: BranchUserRole.OPERATOR })
  @IsOptional()
  @IsEnum(BranchUserRole)
  role?: BranchUserRole;
}

export class SetBranchConfigRequestDto {
  @ApiProperty({ example: 'working_hours' })
  @IsString()
  @MinLength(1)
  config_key!: string;

  @ApiPropertyOptional({
    example: { start: '09:00', end: '18:00', timezone: 'Asia/Tashkent' },
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  config_value?: Record<string, unknown> | null;
}

export class UpdateBranchConfigRequestDto {
  @ApiPropertyOptional({
    example: { start: '10:00', end: '19:00', timezone: 'Asia/Tashkent' },
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  config_value?: Record<string, unknown> | null;
}
