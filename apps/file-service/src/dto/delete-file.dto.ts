import { IsString, MinLength } from 'class-validator';

export class DeleteFileDto {
  @IsString()
  @MinLength(1)
  key!: string;
}

