import { CreateUserDto } from '../dto/create-user.dto';
import { UpdateUserDto } from '../dto/update-user.dto';

export interface CreateUserPayload {
  dto: CreateUserDto;
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
  page?: number;
  limit?: number;
}

export interface FindAllUsersPayload {
  query?: UserFilterQuery;
}
