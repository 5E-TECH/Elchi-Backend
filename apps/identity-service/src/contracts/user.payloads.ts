import { CreateAdminDto } from '../dto/create-admin.dto';
import { CreateCourierDto } from '../dto/create-courier.dto';
import { CreateCustomerDto } from '../dto/create-customer.dto';
import { CreateManagerDto } from '../dto/create-manager.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { Status } from '@app/common';

export interface RequesterContext {
  id: string;
  roles: string[];
  allowed_user_ids?: string[];
}

export interface CreateUserPayload {
  dto: CreateAdminDto;
  requester?: RequesterContext;
}

export interface CreateCourierPayload {
  dto: CreateCourierDto;
  requester?: RequesterContext;
}

export interface CreateCustomerPayload {
  dto: CreateCustomerDto;
}

export interface CreateManagerPayload {
  dto: CreateManagerDto;
  requester?: RequesterContext;
}

export interface FindCouriersByIdsPayload {
  ids: string[];
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
  region_id?: string;
  user_ids?: string[];
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
