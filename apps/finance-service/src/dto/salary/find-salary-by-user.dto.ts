import { IsString, Matches } from 'class-validator';

export class FindSalaryByUserDto {
  @IsString()
  @Matches(/^\d+$/)
  user_id!: string;
}
