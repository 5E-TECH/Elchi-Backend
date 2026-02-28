import { CreateAdminDto } from '../dto/create-admin.dto';
import { CreateCourierDto } from '../dto/create-courier.dto';
import { CreateCustomerDto } from '../dto/create-customer.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { Status } from '@app/common';

export interface RequesterContext {
  id: string;
  roles: string[];
}

export interface CreateUserPayload {
  dto: CreateAdminDto;
  requester?: RequesterContext;
}

export interface CreateCourierPayload {
  dto: CreateCourierDto;
}

export interface CreateCustomerPayload {
  dto: CreateCustomerDto;
}

export interface UpdateUserPayload {
  id: string;
  dto: UpdateUserDto;
  requester?: RequesterContext;
}

export interface DeleteUserPayload {
  id: string;
  requester?: RequesterContext;
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
  requester?: RequesterContext;
}
