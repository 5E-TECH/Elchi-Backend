import { HttpException, InternalServerErrorException } from '@nestjs/common';

export const catchError = (error: any) => {
  if (error?.response) {
    throw new HttpException(
      error?.response?.message,
      error?.response?.statusCode,
    );
  } else {
    throw new InternalServerErrorException(error.message);
  }
};

export const errorRes = (message?: string, code?: number, data?: any) => {
  return {
    statusCode: code ?? 500,
    message: message ?? 'error',
    data: data ?? null,
  };
};

export const successRes = (resData: any, code?: number, message?: string) => {
  return {
    statusCode: code ? code : 200,
    message: message ? message : 'success',
    data: resData,
  };
};
