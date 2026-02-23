import { CreateAdminDto } from '../dto/create-admin.dto';
import { CreateCourierDto } from '../dto/create-courier.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { Status } from '@app/common';

export interface CreateUserPayload {
  dto: CreateAdminDto;
}

export interface CreateCourierPayload {
  dto: CreateCourierDto;
}

export interface UpdateUserPayload {
  id: string;
  dto: UpdateUserDto;
}

export interface DeleteUserPayload {
  id: string;
}

export interface FindUserByIdPayload {
  id: string;
}

export interface UserFilterQuery {
  search?: string;
  role?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export interface FindAllUsersPayload {
  query?: UserFilterQuery;
}

export interface UpdateUserStatusPayload {
  id: string;
  status: Status;
}
