import { IsString, MinLength } from 'class-validator';

export class ReadFileDto {
  @IsString()
  @MinLength(1)
  key!: string;
}
