import { IsNumberString } from 'class-validator';

export class RemoveBranchUserDto {
  @IsNumberString()
  branch_id!: string;

  @IsNumberString()
  user_id!: string;
}

