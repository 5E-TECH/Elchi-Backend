import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateUserRequestDto {
  @ApiProperty({ example: 'ali123' })
  username!: string;

  @ApiProperty({ example: '123456' })
  password!: string;
}

export class UpdateUserRequestDto {
  @ApiPropertyOptional({ example: 'ali_new' })
  username?: string;

  @ApiPropertyOptional({ example: '654321' })
  password?: string;
}

export class UserItemDto {
  @ApiProperty({ example: '10a142dd-df52-418e-bf3b-fe8fbf1b77f5' })
  id!: string;

  @ApiProperty({ example: '2026-02-12T09:34:04.236Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-02-12T09:34:04.236Z' })
  updatedAt!: string;

  @ApiProperty({ example: 'ali123' })
  username!: string;
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

  @ApiProperty({ example: { id: '10a142dd-df52-418e-bf3b-fe8fbf1b77f5' } })
  data!: { id: string };
}

export class UserListResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({
    example: {
      items: [
        {
          id: '10a142dd-df52-418e-bf3b-fe8fbf1b77f5',
          createdAt: '2026-02-12T09:34:04.236Z',
          updatedAt: '2026-02-12T09:34:04.236Z',
          username: 'ali123',
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
