import { IsNotEmpty, IsString } from 'class-validator';

export class PostIdDto {
  @IsNotEmpty()
  @IsString()
  postId!: string;
}
