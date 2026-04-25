import { IsEnum, IsNumberString, IsOptional } from 'class-validator';
import { BranchUserRole } from '@app/common';

export class AssignBranchUserDto {
  @IsNumberString()
  branch_id!: string;

  @IsNumberString()
  user_id!: string;

  @IsOptional()
  @IsEnum(BranchUserRole)
  role?: BranchUserRole;
}
