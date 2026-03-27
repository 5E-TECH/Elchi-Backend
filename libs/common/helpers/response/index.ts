import { HttpException, InternalServerErrorException } from '@nestjs/common';

export const catchError = (error: any) => {
  if (error instanceof HttpException) {
    throw error;
  }

  if (error?.response) {
    const statusCode =
      error?.response?.statusCode || error?.response?.status || 500;
    const message =
      error?.response?.message || error?.message || 'Internal server error';
    throw new HttpException(
      message,
      statusCode,
    );
  }

  if (typeof error === 'string') {
    throw new InternalServerErrorException(error);
  }

  throw new InternalServerErrorException(
    error?.message || 'Internal server error',
  );
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
