import { CreateAdminDto } from '../dto/create-admin.dto';
import { UpdateUserDto } from '../dto/update-user.dto';

export interface CreateUserPayload {
  dto: CreateAdminDto;
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

export interface FindUserByUsernamePayload {
  username: string;
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
