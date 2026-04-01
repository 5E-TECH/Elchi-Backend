import { IsNumberString, IsOptional, IsString } from 'class-validator';

export class AssignBranchUserDto {
  @IsNumberString()
  branch_id!: string;

  @IsNumberString()
  user_id!: string;

  @IsOptional()
  @IsString()
  role?: string;
}

