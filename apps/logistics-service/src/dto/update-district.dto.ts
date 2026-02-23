import { IsNotEmpty, IsUUID } from 'class-validator';

export class UpdateDistrictDto {
  @IsNotEmpty()
  @IsUUID()
  assigned_region!: string;
}

