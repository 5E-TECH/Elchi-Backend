import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsPhoneNumber,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateUserRequestDto {
  @ApiPropertyOptional({ example: 'Ali Valiyev' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ example: 'ali123' })
  @IsString()
  @MinLength(3)
  username!: string;

  @ApiPropertyOptional({ example: '+998901234567' })
  @IsOptional()
  @IsPhoneNumber('UZ')
  phone_number?: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @MinLength(4)
  password!: string;

  @ApiPropertyOptional({ example: 'customer' })
  @IsOptional()
  @IsEnum(['superadmin', 'admin', 'market', 'customer'])
  role?: string;

  @ApiPropertyOptional({ example: 'active' })
  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: string;
}

export class UpdateUserRequestDto {
  @ApiPropertyOptional({ example: 'Ali Valiyev' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'ali_new' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  username?: string;

  @ApiPropertyOptional({ example: '+998901234567' })
  @IsOptional()
  @IsPhoneNumber('UZ')
  phone_number?: string;

  @ApiPropertyOptional({ example: '654321' })
  @IsOptional()
  @IsString()
  @MinLength(4)
  password?: string;

  @ApiPropertyOptional({ example: 'admin' })
  @IsOptional()
  @IsEnum(['superadmin', 'admin', 'market', 'customer'])
  role?: string;

  @ApiPropertyOptional({ example: 'inactive' })
  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: string;
}

export class UserItemDto {
  @ApiProperty({ example: '1' })
  id!: string;

  @ApiProperty({ example: '2026-02-12T09:34:04.236Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-02-12T09:34:04.236Z' })
  updatedAt!: string;

  @ApiProperty({ example: 'ali123' })
  username!: string;

  @ApiPropertyOptional({ example: 'Ali Valiyev' })
  name?: string;

  @ApiPropertyOptional({ example: '+998901234567' })
  phone_number?: string;

  @ApiProperty({ example: 'customer' })
  role!: string;

  @ApiProperty({ example: 'active' })
  status!: string;
}

export class SingleUserResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiPropertyOptional({ example: 'User yaratildi' })
  message?: string;

  @ApiProperty({ type: UserItemDto })
  data!: UserItemDto;
}

export class DeleteUserResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: 'User o‘chirildi' })
  message!: string;

  @ApiProperty({ example: { id: '1' } })
  data!: { id: string };
}

export class UserListResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({
    example: {
      items: [
        {
          id: '1',
          createdAt: '2026-02-12T09:34:04.236Z',
          updatedAt: '2026-02-12T09:34:04.236Z',
          username: 'ali123',
          name: 'Ali Valiyev',
          phone_number: '+998901234567',
          role: 'customer',
          status: 'active',
        },
      ],
      meta: { page: 1, limit: 10, total: 1, totalPages: 1 },
    },
  })
  data!: {
    items: UserItemDto[];
    meta: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  };
}

export class ErrorResponseDto {
  @ApiProperty({ example: 404 })
  statusCode!: number;

  @ApiProperty({ example: 'User topilmadi' })
  message!: string;
}
