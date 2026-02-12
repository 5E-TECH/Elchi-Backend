import { Catch, ArgumentsHost, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Response } from 'express';

@Catch(RpcException)
export class RpcExceptionFilter implements ExceptionFilter {
  catch(exception: RpcException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const error = exception.getError();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';

    if (typeof error === 'object' && error !== null) {
      const err = error as Record<string, unknown>;
      status = typeof err.statusCode === 'number' ? err.statusCode : HttpStatus.INTERNAL_SERVER_ERROR;
      message = typeof err.message === 'string' ? err.message : 'Internal server error';
    } else if (typeof error === 'string') {
      message = error;
    }

    response.status(status).json({
      statusCode: status,
      message,
    });
  }
}
